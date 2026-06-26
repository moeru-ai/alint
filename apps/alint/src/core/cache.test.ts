import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createCacheKey,
  createCacheStore,
  createTargetIdentityResolver,
  hashText,
  normalizeRunnerCacheConfig,
  resolveCacheLocation,
  stableHash,
} from './cache'

describe('cache helpers', () => {
  it('resolves the default cache file under cwd', () => {
    expect(resolveCacheLocation('/repo')).toBe(join('/repo', '.alintcache'))
  })

  it('resolves directory cache locations to .alintcache inside the directory', async () => {
    const root = join(tmpdir(), `alint-cache-${Date.now()}`)
    await mkdir(root, { recursive: true })

    expect(resolveCacheLocation('/repo', root)).toBe(join(root, '.alintcache'))
    expect(resolveCacheLocation('/repo', `${root}/`)).toBe(join(root, '.alintcache'))
  })

  it('hashes stable objects independent of property insertion order', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ a: 1, b: 2 }))
    expect(hashText('same')).toBe(hashText('same'))
  })

  it('builds distinct keys for different target hashes', () => {
    const base = {
      alintVersion: '0.0.1',
      configHash: stableHash({ rules: { a: 'warn' } }),
      filePath: 'src/a.ts',
      modelHash: stableHash({ model: 'default' }),
      ruleHash: stableHash({ id: 'x/a' }),
      schemaVersion: 1 as const,
      targetIdentity: 'function:load',
      targetKind: 'function' as const,
    }

    expect(createCacheKey({ ...base, targetHash: hashText('one') }))
      .not
      .toBe(createCacheKey({ ...base, targetHash: hashText('two') }))
  })

  it('adds range to duplicate target identities', () => {
    const resolveIdentity = createTargetIdentityResolver([
      { kind: 'function', name: 'handler', range: { end: 20, start: 10 } },
      { kind: 'function', name: 'handler', range: { end: 40, start: 30 } },
    ])

    expect(resolveIdentity({ kind: 'function', name: 'handler', range: { end: 20, start: 10 } }))
      .toBe('function:handler:10:20')
    expect(resolveIdentity({ kind: 'function', name: 'handler', range: { end: 40, start: 30 } }))
      .toBe('function:handler:30:40')
  })

  it('ignores malformed cache files and writes valid JSON atomically', async () => {
    const root = join(tmpdir(), `alint-cache-store-${Date.now()}`)
    const cachePath = join(root, '.alintcache')

    await mkdir(root, { recursive: true })
    await writeFile(cachePath, '{bad json')

    const store = await createCacheStore({ cwd: root, enabled: true, location: cachePath })

    expect(store.get('missing')).toBeUndefined()

    store.set('key', {
      diagnostics: [],
      filePath: join(root, 'demo.ts'),
      fingerprint: {
        alintVersion: '0.0.1',
        configHash: hashText('config'),
        modelHash: hashText('model'),
        ruleHash: hashText('rule'),
      },
      target: {
        hash: hashText('target'),
        identity: 'file:demo.ts',
        kind: 'file',
      },
      usage: [],
    })
    store.markFile(join(root, 'demo.ts'), hashText('file'), ['key'])
    await store.reconcile()

    const cache = JSON.parse(await readFile(cachePath, 'utf8'))

    expect(cache.createdAt).toEqual(expect.any(String))
    expect(cache.updatedAt).toEqual(expect.any(String))
    expect(cache.entries.key).toBeTruthy()
    expect(cache.files['demo.ts']).toEqual({
      contentHash: hashText('file'),
      entries: ['key'],
      path: 'demo.ts',
    })
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

  it('resets cache files with the wrong schema', async () => {
    const root = join(tmpdir(), `alint-cache-schema-${Date.now()}`)
    const cachePath = join(root, '.alintcache')

    await mkdir(root, { recursive: true })
    await writeFile(cachePath, JSON.stringify({ entries: { stale: true }, version: 999 }))

    const store = await createCacheStore({ cwd: root, enabled: true, location: cachePath })

    expect(store.get('stale')).toBeUndefined()
  })

  it('resets cache files missing required timestamps', async () => {
    const root = join(tmpdir(), `alint-cache-timestamps-${Date.now()}`)
    const cachePath = join(root, '.alintcache')

    await mkdir(root, { recursive: true })
    await writeFile(cachePath, JSON.stringify({
      entries: {
        stale: {
          diagnostics: [],
          filePath: 'demo.ts',
          fingerprint: {
            alintVersion: '0.0.1',
            configHash: hashText('config'),
            modelHash: hashText('model'),
            ruleHash: hashText('rule'),
          },
          target: {
            hash: hashText('target'),
            identity: 'file:demo.ts',
            kind: 'file',
          },
          usage: [],
        },
      },
      files: {},
      schemaVersion: 1,
    }))

    const store = await createCacheStore({ cwd: root, enabled: true, location: cachePath })

    expect(store.get('stale')).toBeUndefined()
  })

  it('resets cache files with invalid nested entries', async () => {
    const root = join(tmpdir(), `alint-cache-invalid-entry-${Date.now()}`)
    const cachePath = join(root, '.alintcache')

    await mkdir(root, { recursive: true })
    await writeFile(cachePath, JSON.stringify({
      createdAt: '2000-01-01T00:00:00.000Z',
      entries: {
        bad: null,
      },
      files: {},
      schemaVersion: 1,
      updatedAt: '2000-01-01T00:00:00.000Z',
    }))

    const store = await createCacheStore({ cwd: root, enabled: true, location: cachePath })

    expect(store.get('bad')).toBeUndefined()
  })

  it('resets cache files with invalid nested diagnostics', async () => {
    const root = join(tmpdir(), `alint-cache-invalid-diagnostic-${Date.now()}`)
    const cachePath = join(root, '.alintcache')

    await mkdir(root, { recursive: true })
    await writeFile(cachePath, JSON.stringify({
      createdAt: '2000-01-01T00:00:00.000Z',
      entries: {
        bad: {
          diagnostics: [null],
          filePath: 'demo.ts',
          fingerprint: {
            alintVersion: '0.0.1',
            configHash: hashText('config'),
            modelHash: hashText('model'),
            ruleHash: hashText('rule'),
          },
          target: {
            hash: hashText('target'),
            identity: 'file:demo.ts',
            kind: 'file',
          },
          usage: [],
        },
      },
      files: {},
      schemaVersion: 1,
      updatedAt: '2000-01-01T00:00:00.000Z',
    }))

    const store = await createCacheStore({ cwd: root, enabled: true, location: cachePath })

    expect(store.get('bad')).toBeUndefined()
  })

  it('resets cache files with invalid target kinds', async () => {
    const root = join(tmpdir(), `alint-cache-invalid-target-${Date.now()}`)
    const cachePath = join(root, '.alintcache')

    await mkdir(root, { recursive: true })
    await writeFile(cachePath, JSON.stringify({
      createdAt: '2000-01-01T00:00:00.000Z',
      entries: {
        bad: {
          diagnostics: [],
          filePath: 'demo.ts',
          fingerprint: {
            alintVersion: '0.0.1',
            configHash: hashText('config'),
            modelHash: hashText('model'),
            ruleHash: hashText('rule'),
          },
          target: {
            hash: hashText('target'),
            identity: 'method:demo',
            kind: 'method',
          },
          usage: [],
        },
      },
      files: {},
      schemaVersion: 1,
      updatedAt: '2000-01-01T00:00:00.000Z',
    }))

    const store = await createCacheStore({ cwd: root, enabled: true, location: cachePath })

    expect(store.get('bad')).toBeUndefined()
  })

  it('updates the cache updatedAt timestamp during reconcile', async () => {
    const root = join(tmpdir(), `alint-cache-updated-at-${Date.now()}`)
    const cachePath = join(root, '.alintcache')
    const oldTimestamp = '2000-01-01T00:00:00.000Z'

    await mkdir(root, { recursive: true })
    await writeFile(cachePath, JSON.stringify({
      createdAt: oldTimestamp,
      entries: {},
      files: {},
      schemaVersion: 1,
      updatedAt: oldTimestamp,
    }))

    const store = await createCacheStore({ cwd: root, enabled: true, location: cachePath })
    await store.reconcile()

    const cache = JSON.parse(await readFile(cachePath, 'utf8'))

    expect(cache.createdAt).toBe(oldTimestamp)
    expect(cache.updatedAt).not.toBe(oldTimestamp)
    expect(new Date(cache.updatedAt).toISOString()).toBe(cache.updatedAt)
  })
})
