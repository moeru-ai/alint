import type { CacheEntry, CacheFingerprint, CacheSlotIdentity } from './types'

import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createCacheStore,
  createTargetIdentityResolver,
  normalizeCachePath,
  normalizeRunnerCacheConfig,
  readCacheBody,
  resolveCacheLocation,
} from './store'

const slot: CacheSlotIdentity = {
  ruleId: 'demo/rule',
  scope: 'file',
  targetIdentity: 'file:demo.ts',
}

async function createRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alint-cache-store-'))
}

function entry(targetHash: string): CacheEntry {
  return {
    diagnostics: [],
    fingerprint: { configHash: 'config', modelHash: 'model', ruleHash: 'rule', targetHash },
    target: { hash: targetHash, identity: 'file:demo.ts', kind: 'file' },
    usage: [],
  }
}

describe('cache helpers', () => {
  it('normalizes paths relative to cwd', () => {
    expect(normalizeCachePath('/repo', '/repo/src/demo.ts')).toBe('src/demo.ts')
    expect(normalizeCachePath('/repo', 'src/demo.ts')).toBe('src/demo.ts')
    expect(normalizeCachePath('/repo', '/repo')).toBe('.')
  })

  it('normalizes disabled and object runner cache config', () => {
    expect(normalizeRunnerCacheConfig(false, '/repo')).toEqual({
      enabled: false,
      location: join('/repo', '.alintcache'),
    })
    expect(normalizeRunnerCacheConfig({ location: 'cache/alint.json' }, '/repo')).toEqual({
      enabled: true,
      location: join('/repo', 'cache/alint.json'),
    })
  })

  it('resolves default, file, and directory cache locations', async () => {
    const root = await createRoot()

    expect(resolveCacheLocation('/repo')).toBe(join('/repo', '.alintcache'))
    expect(resolveCacheLocation('/repo', root)).toBe(join(root, '.alintcache'))
    expect(resolveCacheLocation('/repo', `${root}/`)).toBe(join(root, '.alintcache'))
    expect(resolveCacheLocation('/repo', 'cache/alint.json')).toBe(join('/repo', 'cache/alint.json'))
  })

  it('adds ranges only to duplicate target identities', () => {
    const resolveIdentity = createTargetIdentityResolver([
      { kind: 'function', name: 'handler', range: { end: 20, start: 10 } },
      { kind: 'function', name: 'handler', range: { end: 40, start: 30 } },
      { kind: 'function', name: 'unique', range: { end: 60, start: 50 } },
    ])

    expect(resolveIdentity({ kind: 'function', name: 'handler', range: { end: 20, start: 10 } })).toBe('function:handler:10:20')
    expect(resolveIdentity({ kind: 'function', name: 'handler', range: { end: 40, start: 30 } })).toBe('function:handler:30:40')
    expect(resolveIdentity({ kind: 'function', name: 'unique', range: { end: 60, start: 50 } })).toBe('function:unique')
  })
})

describe('cache store', () => {
  it.each([
    ['legacy', '{"legacy":true}'],
    ['version mismatch', `ALINT_CACHE 2 1.0.0\n${JSON.stringify({ createdAt: '2000-01-01T00:00:00.000Z', entries: {}, owners: {}, updatedAt: '2000-01-01T00:00:00.000Z' })}\n`],
    ['malformed nested body', `ALINT_CACHE 2 2.0.0\n${JSON.stringify({
      createdAt: '2000-01-01T00:00:00.000Z',
      entries: {
        bad: {
          diagnostics: [{ filePath: 'demo.ts', loc: { start: { column: 1, line: 'bad' } }, message: 'bad', ruleId: 'demo/rule', severity: 'warn' }],
          fingerprint: { configHash: 'config', modelHash: 'model', ruleHash: 'rule', targetHash: 'target' },
          target: { hash: 'target', identity: 'file:demo.ts', kind: 'file' },
          usage: [],
        },
      },
      owners: {},
      updatedAt: '2000-01-01T00:00:00.000Z',
    })}\n`],
  ])('leaves %s cache bytes unchanged when read-only', async (_, original) => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    await writeFile(cachePath, original)

    const store = await createCacheStore({ alintVersion: '2.0.0', cwd: root, enabled: true, location: cachePath, readOnly: true })
    const owner = store.beginOwner({ kind: 'file', path: join(root, 'demo.ts') })
    owner.put(slot, entry('replacement'))
    owner.commit({ contentHash: 'replacement' })
    await store.reconcile()

    expect(await readFile(cachePath, 'utf8')).toBe(original)
  })

  it('reads valid entries but ignores commits and reconcile when read-only', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const writable = await createCacheStore({ alintVersion: '2.0.0', cwd: root, enabled: true, location: cachePath })
    const warmOwner = writable.beginOwner({ kind: 'file', path: sourcePath })
    warmOwner.put(slot, entry('warm'))
    warmOwner.commit({ contentHash: 'warm' })
    await writable.reconcile()
    const original = await readFile(cachePath, 'utf8')

    const readOnly = await createCacheStore({ alintVersion: '2.0.0', cwd: root, enabled: true, location: cachePath, readOnly: true })
    const owner = readOnly.beginOwner({ kind: 'file', path: sourcePath })
    expect(owner.lookup(slot, entry('warm').fingerprint)?.fingerprint.targetHash).toBe('warm')
    owner.put(slot, entry('replacement'))
    owner.commit({ contentHash: 'replacement' })
    await readOnly.reconcile()

    expect(await readFile(cachePath, 'utf8')).toBe(original)
  })

  it('removes a legacy large raw JSON body after reading only the bounded header', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    await writeFile(cachePath, JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }))

    const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const owner = store.beginOwner({ kind: 'file', path: join(root, 'demo.ts') })

    expect(owner.lookup(slot, entry('target').fingerprint)).toBeUndefined()
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces one owner without deleting untouched owners', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    await writeFile(join(root, 'a.ts'), 'a')
    await writeFile(join(root, 'b.ts'), 'b')
    const initial = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const ownerA = initial.beginOwner({ kind: 'file', path: join(root, 'a.ts') })
    const ownerB = initial.beginOwner({ kind: 'file', path: join(root, 'b.ts') })
    ownerA.put(slot, entry('a-1'))
    ownerA.commit({ contentHash: 'content-a-1' })
    ownerB.put(slot, entry('b-1'))
    ownerB.commit({ contentHash: 'content-b-1' })
    await initial.reconcile()

    const reopened = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const replacementA = reopened.beginOwner({ kind: 'file', path: join(root, 'a.ts') })
    replacementA.put(slot, entry('a-2'))
    replacementA.commit({ contentHash: 'content-a-2' })
    await reopened.reconcile()
    const body = await readCacheBody(cachePath)

    expect(Object.keys(body.owners)).toHaveLength(2)
    expect(Object.keys(body.entries)).toHaveLength(2)
    expect(Object.values(body.entries).map(value => value.fingerprint.targetHash).sort()).toEqual(['a-2', 'b-1'])
    expect(Object.values(body.owners).find(owner => owner.path === 'b.ts')?.contentHash).toBe('content-b-1')
  })

  it('leaves no orphan entries when overlapping owner transactions commit', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const first = store.beginOwner({ kind: 'file', path: sourcePath })
    const second = store.beginOwner({ kind: 'file', path: sourcePath })
    first.put(slot, entry('first'))
    second.put({ ...slot, ruleId: 'demo/second' }, entry('second'))

    first.commit({ contentHash: 'first' })
    second.commit({ contentHash: 'second' })
    await store.reconcile()
    const body = await readCacheBody(cachePath)
    const owner = Object.values(body.owners)[0]

    expect(owner?.slots).toHaveLength(1)
    expect(Object.keys(body.entries).sort()).toEqual(owner?.slots)
    expect(Object.values(body.entries)[0]?.fingerprint.targetHash).toBe('second')
  })

  it('removes cache bodies with orphan entries', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const body = {
      createdAt: '2000-01-01T00:00:00.000Z',
      entries: { orphan: entry('orphan') },
      owners: {},
      updatedAt: '2000-01-01T00:00:00.000Z',
    }
    await writeFile(cachePath, `ALINT_CACHE 2 1.0.0\n${JSON.stringify(body)}\n`)

    await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })

    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['evidence', 'metadata'] as const)('rejects non-JSON %s values before persistence', async (field) => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const malformed = entry('target')
    if (field === 'evidence') {
      malformed.diagnostics = [{ evidence: () => 'not JSON', filePath: sourcePath, message: 'bad', ruleId: 'demo/rule', severity: 'warn' }]
    }
    else {
      malformed.usage = [{ metadata: () => 'not JSON', modelId: 'model', providerId: 'provider', ruleId: 'demo/rule' }]
    }
    const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, malformed)
    owner.commit({ contentHash: 'content' })

    await expect(store.reconcile()).rejects.toThrow()
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['cached target location', (value: CacheEntry) => {
      value.target.loc = { end: { column: 1, line: 1 }, start: { column: 0, line: Infinity } }
    }],
    ['cached target range', (value: CacheEntry) => {
      value.target.range = { end: -Infinity, start: 0 }
    }],
    ['diagnostic location', (value: CacheEntry) => {
      value.diagnostics = [{ filePath: 'demo.ts', loc: { start: { column: Infinity, line: 1 } }, message: 'bad', ruleId: 'demo/rule', severity: 'warn' }]
    }],
    ['usage token count', (value: CacheEntry) => {
      value.usage = [{ inputTokens: Infinity, modelId: 'model', outputTokens: -Infinity, providerId: 'provider', ruleId: 'demo/rule', totalTokens: Infinity }]
    }],
  ] as const)('rejects non-finite %s before persistence', async (_, makeNonFinite) => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const malformed = entry('target')
    makeNonFinite(malformed)
    const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, malformed)
    owner.commit({ contentHash: 'content' })

    await expect(store.reconcile()).rejects.toThrow()
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['evidence', 'metadata'] as const)('rejects cyclic %s without overflowing the validator', async (field) => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const malformed = entry('target')
    if (field === 'evidence') {
      malformed.diagnostics = [{ evidence: cyclic, filePath: sourcePath, message: 'bad', ruleId: 'demo/rule', severity: 'warn' }]
    }
    else {
      malformed.usage = [{ metadata: cyclic, modelId: 'model', providerId: 'provider', ruleId: 'demo/rule' }]
    }
    const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, malformed)
    owner.commit({ contentHash: 'content' })

    let persistenceError: unknown
    try {
      await store.reconcile()
    }
    catch (error) {
      persistenceError = error
    }

    expect(persistenceError).toBeInstanceOf(Error)
    expect(persistenceError).not.toBeInstanceOf(RangeError)
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  describe('json persistence boundary', () => {
    interface BoundaryCase {
      create: () => { getterCalls?: () => number, value: unknown }
      name: string
    }

    const cases: BoundaryCase[] = [
      {
        create: () => {
          const value: Record<PropertyKey, unknown> = {}
          Object.defineProperty(value, Symbol('hidden'), { value: 'hidden' })
          return { value }
        },
        name: 'non-enumerable symbol property',
      },
      ...[
        ['undefined', undefined],
        ['function', () => 'hidden'],
        ['bigint', 1n],
      ].map(([name, hidden]): BoundaryCase => ({
        create: () => {
          const value: Record<PropertyKey, unknown> = {}
          Object.defineProperty(value, 'hidden', { value: hidden })
          return { value }
        },
        name: `non-enumerable string ${name}`,
      })),
      {
        create: () => {
          let calls = 0
          const value: Record<PropertyKey, unknown> = {}
          Object.defineProperty(value, 'computed', {
            enumerable: true,
            get: () => {
              calls += 1
              return 'computed'
            },
          })
          return { getterCalls: () => calls, value }
        },
        name: 'object getter property',
      },
      {
        create: () => {
          const value: unknown[] = ['item']
          Object.defineProperty(value, Symbol('hidden'), { value: 'hidden' })
          return { value }
        },
        name: 'array symbol property',
      },
      {
        create: () => {
          const value: unknown[] = ['item']
          Object.defineProperty(value, '01', { enumerable: true, value: 'hidden' })
          return { value }
        },
        name: 'array non-canonical index property',
      },
      {
        create: () => {
          let calls = 0
          const value: unknown[] = ['item']
          Object.defineProperty(value, '0', {
            enumerable: true,
            get: () => {
              calls += 1
              return 'computed'
            },
          })
          return { getterCalls: () => calls, value }
        },
        name: 'array index getter',
      },
      {
        create: () => ({ value: new Array(1) }),
        name: 'sparse array hole',
      },
      {
        create: () => {
          class FancyArray extends Array<unknown> {}
          return { value: new FancyArray('item') }
        },
        name: 'array subclass',
      },
      {
        create: () => {
          const value: unknown[] = ['item']
          Object.setPrototypeOf(value, { custom: true })
          return { value }
        },
        name: 'array with a custom prototype',
      },
    ]

    it.each(cases)('rejects $name without invoking accessors', async ({ create }) => {
      const root = await createRoot()
      const cachePath = join(root, '.alintcache')
      const sourcePath = join(root, 'demo.ts')
      await writeFile(sourcePath, 'demo')
      const { getterCalls, value } = create()
      const malformed = entry('target')
      malformed.diagnostics = [{ evidence: value, filePath: sourcePath, message: 'bad', ruleId: 'demo/rule', severity: 'warn' }]
      malformed.usage = [{ metadata: value, modelId: 'model', providerId: 'provider', ruleId: 'demo/rule' }]
      const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
      const owner = store.beginOwner({ kind: 'file', path: sourcePath })
      owner.put(slot, malformed)
      owner.commit({ contentHash: 'content' })

      await expect(store.reconcile()).rejects.toThrow()
      expect(getterCalls?.() ?? 0).toBe(0)
      await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('accepts plain arrays, shared references, and null-prototype objects', async () => {
      const root = await createRoot()
      const cachePath = join(root, '.alintcache')
      const sourcePath = join(root, 'demo.ts')
      await writeFile(sourcePath, 'demo')
      const shared = { value: 'shared' }
      const nullPrototype: Record<string, unknown> = Object.create(null)
      nullPrototype.value = 'null prototype'
      const valid = entry('target')
      valid.diagnostics = [{
        evidence: { empty: [], first: shared, nullPrototype, second: shared },
        filePath: sourcePath,
        message: 'valid',
        ruleId: 'demo/rule',
        severity: 'warn',
      }]
      const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
      const owner = store.beginOwner({ kind: 'file', path: sourcePath })
      owner.put(slot, valid)
      owner.commit({ contentHash: 'content' })

      await store.reconcile()
      const body = await readCacheBody(cachePath)

      expect(Object.values(body.entries)[0]?.diagnostics[0]?.message).toBe('valid')
    })
  })

  it('garbage-collects a missing file owner and all of its slots', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const initial = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const owner = initial.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('one'))
    owner.put({ ...slot, ruleId: 'demo/other' }, entry('two'))
    owner.commit({ contentHash: 'content' })
    await initial.reconcile()
    await rm(sourcePath)

    const reopened = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    await reopened.reconcile()
    const body = await readCacheBody(cachePath)

    expect(Object.keys(body.owners)).toHaveLength(0)
    expect(Object.keys(body.entries)).toHaveLength(0)
  })

  it('preserves partial-write errors and removes the temporary file', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    const writeError = new Error('partial cache write failed')
    await writeFile(sourcePath, 'demo')
    const partialWrite: typeof writeFile = async (path) => {
      await writeFile(path, 'partial')
      throw writeError
    }
    const store = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      location: cachePath,
      writeFile: partialWrite,
    })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('target'))
    owner.commit({ contentHash: 'content' })

    await expect(store.reconcile()).rejects.toBe(writeError)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves rename errors and removes the temporary file', async () => {
    const root = await createRoot()
    const cachePath = join(root, 'blocked-cache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')
    const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    const owner = store.beginOwner({ kind: 'file', path: sourcePath })
    owner.put(slot, entry('target'))
    owner.commit({ contentHash: 'content' })
    await mkdir(cachePath)

    let renameError: unknown
    try {
      await store.reconcile()
    }
    catch (error) {
      renameError = error
    }

    expect(renameError).toBeInstanceOf(Error)
    expect(renameError).toMatchObject({ code: expect.stringMatching(/^E/) })
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rethrows non-missing access errors without changing the cache', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const longPath = join(root, 'x'.repeat(5000))
    const initial = await createCacheStore({
      alintVersion: '1.0.0',
      cwd: root,
      enabled: true,
      fileExists: async () => true,
      location: cachePath,
    })
    const owner = initial.beginOwner({ kind: 'file', path: longPath })
    owner.put(slot, entry('target'))
    owner.commit({ contentHash: 'content' })
    await initial.reconcile()
    const original = await readFile(cachePath, 'utf8')

    const reopened = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
    await expect(reopened.reconcile()).rejects.toMatchObject({ code: 'ENAMETOOLONG' })

    expect(await readFile(cachePath, 'utf8')).toBe(original)
    expect(Object.keys((await readCacheBody(cachePath)).owners)).toHaveLength(1)
  })

  it('keeps one owner and one logical slot across twenty fingerprint changes', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const sourcePath = join(root, 'demo.ts')
    await writeFile(sourcePath, 'demo')

    for (let index = 0; index < 20; index += 1) {
      const store = await createCacheStore({ alintVersion: '1.0.0', cwd: root, enabled: true, location: cachePath })
      const owner = store.beginOwner({ kind: 'file', path: sourcePath })
      owner.put(slot, entry(`target-${index}`))
      owner.commit({ contentHash: `content-${index}` })
      await store.reconcile()
    }
    const body = await readCacheBody(cachePath)

    expect(Object.keys(body.owners)).toHaveLength(1)
    expect(Object.keys(body.entries)).toHaveLength(1)
    expect(Object.values(body.owners)[0]?.slots).toHaveLength(1)
    expect(Object.values(body.entries)[0]?.fingerprint.targetHash).toBe('target-19')
  })

  it('removes cache files whose header alint version differs', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const body = { createdAt: '2000-01-01T00:00:00.000Z', entries: {}, owners: {}, updatedAt: '2000-01-01T00:00:00.000Z' }
    await writeFile(cachePath, `ALINT_CACHE 2 1.0.0\n${JSON.stringify(body)}\n`)

    const store = await createCacheStore({ alintVersion: '2.0.0', cwd: root, enabled: true, location: cachePath })
    const owner = store.beginOwner({ kind: 'project', path: root })

    expect(owner.lookup({ ...slot, scope: 'project' }, entry('target').fingerprint)).toBeUndefined()
    await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns misses and never persists when disabled', async () => {
    const root = await createRoot()
    const cachePath = join(root, '.alintcache')
    const store = await createCacheStore({ cwd: root, enabled: false, location: cachePath })
    const owner = store.beginOwner({ kind: 'file', path: join(root, 'demo.ts') })
    const fingerprint: CacheFingerprint = entry('target').fingerprint

    owner.put(slot, entry('target'))
    owner.commit({ contentHash: 'content' })
    expect(owner.lookup(slot, fingerprint)).toBeUndefined()
    await store.reconcile()
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
