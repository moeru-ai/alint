import type { CacheOwnerTransaction, CacheStore } from '../cache'
import type { RuleRuntime } from '../execution/types'
import type { PreparedInput } from '../preparation'
import type { SourceFile, SourceRuntime } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it, vi } from 'vitest'

import { defineRule } from '../../dsl/define'
import { compareJobOrder } from '../execution/job'
import { createRunProgress } from '../execution/progress'
import { RuleScheduler } from '../execution/scheduler'
import { hashText } from '../hash'
import { executeSourceSession, executeSourceSessions, resolveSourceWindow } from './session'

describe('source sessions', () => {
  it('detaches outcomes and project metadata before releasing source text', async () => {
    const sentinel = 'source session sentinel'
    const commits: Array<undefined | { contentHash?: string, mode?: 'merge' | 'replace' }> = []
    const owner = createOwner(commits)
    const cacheStore = createCacheStore(owner)
    const input = createInput(0, '/repo/demo.custom', async file => [
      { file, identity: 'same', kind: 'symbol', language: 'custom', text: `${file.text}:first` },
      { file, identity: 'same', kind: 'symbol', language: 'custom', text: `${file.text}:second` },
    ])
    const src = createSourceRuntime(async path => ({ language: 'custom', lines: [sentinel], path, text: sentinel }))
    const scheduler = createScheduler(2)

    const result = await executeSourceSession(input, {
      cacheStore,
      cwd: '/repo',
      ruleRuntimes: [createRuntime()],
      scheduler,
      src,
    })
    await scheduler.close()

    expect(result.failure).toBeUndefined()
    expect(result.outcomes).toHaveLength(2)
    expect(result.project?.file.path).toBe('/repo/demo.custom')
    expect(result.project?.file.targetCount).toBe(2)
    expect(JSON.stringify(result.project)).not.toContain(sentinel)
    expect(JSON.stringify(result.outcomes)).not.toContain(sentinel)
    expect(commits).toEqual([{ contentHash: hashText(sentinel) }])
  })

  it('returns an extract failure without opening cache ownership or scheduling jobs', async () => {
    const beginOwner = vi.fn(() => createOwner([]))
    const scheduler = createScheduler(2)
    const input = createInput(0, '/repo/demo.custom', () => {
      throw new Error('bad parser')
    })

    const result = await executeSourceSession(input, {
      cacheStore: { beginOwner, location: '', reconcile: async () => {} },
      cwd: '/repo',
      ruleRuntimes: [createRuntime()],
      scheduler,
      src: createSourceRuntime(async path => ({ language: 'custom', lines: ['text'], path, text: 'text' })),
    })
    await scheduler.close()

    expect(result.failure).toEqual({ file: { index: 0, path: '/repo/demo.custom' }, kind: 'extract', message: 'bad parser' })
    expect(result.project).toBeUndefined()
    expect(result.outcomes).toEqual([])
    expect(beginOwner).not.toHaveBeenCalled()
    expect(scheduler.snapshot().execution.planned).toBe(0)
  })

  it('bounds live source sessions and returns outcomes in stable input order', async () => {
    const releases: Array<() => void> = []
    const metrics = { active: 0, closed: 0, maximumActive: 0, opened: 0 }
    const inputs = Array.from({ length: 8 }, (_, index) => createInput(index, `/repo/${index}.custom`, file => [
      { file, identity: String(index), kind: 'symbol', language: 'custom', text: file.text },
    ]))
    const scheduler = createScheduler(8, async (job) => {
      await new Promise<void>(resolve => releases.push(resolve))
      return completed(job)
    })

    const pending = executeSourceSessions(inputs, {
      cacheStore: createCacheStore(createOwner([])),
      createRuleRuntimes: () => [createRuntime()],
      cwd: '/repo',
      metrics,
      scheduler,
      sourceWindow: resolveSourceWindow(8),
      src: createSourceRuntime(async path => ({ language: 'custom', lines: [path], path, text: path })),
    })

    await until(() => releases.length === 4)
    for (let index = 3; index >= 0; index -= 1) {
      releases[index]?.()
      await until(() => releases.length === 8 - index)
    }
    for (let index = 7; index >= 4; index -= 1)
      releases[index]?.()
    const results = await pending
    await scheduler.close()
    const outcomes = results.flatMap(result => result.outcomes).sort((left, right) => compareJobOrder(left.orderKey, right.orderKey))

    expect(metrics.maximumActive).toBe(4)
    expect(metrics.active).toBe(0)
    expect(metrics.opened).toBe(8)
    expect(metrics.opened).toBe(metrics.closed)
    expect(outcomes.map(outcome => outcome.orderKey.inputIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(resolveSourceWindow(8)).toBe(4)
  })

  it('does not read another source after aborting an active session', async () => {
    const controller = new AbortController()
    const reads: string[] = []
    let release: (() => void) | undefined
    const inputs = Array.from({ length: 4 }, (_, index) => createInput(index, `/repo/${index}.custom`, file => [
      { file, identity: String(index), kind: 'symbol', language: 'custom', text: file.text },
    ]))
    const scheduler = createScheduler(1, async (job) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return completed(job)
    })
    const pending = executeSourceSessions(inputs, {
      cacheStore: createCacheStore(createOwner([])),
      createRuleRuntimes: () => [createRuntime()],
      cwd: '/repo',
      scheduler,
      signal: controller.signal,
      sourceWindow: 1,
      src: createSourceRuntime(async (path) => {
        reads.push(path)
        return { language: 'custom', lines: [path], path, text: path }
      }),
    })

    await until(() => release !== undefined)
    controller.abort('stop')
    release?.()
    await pending
    await scheduler.close()

    expect(reads).toEqual(['/repo/0.custom'])
  })
})

function completed(job: Parameters<ConstructorParameters<typeof RuleScheduler>[0]['execute']>[0]) {
  return { cache: 'miss' as const, diagnostics: [], jobRef: job.jobRef, orderKey: job.orderKey, state: 'completed' as const, usage: [] }
}

function createCacheStore(owner: CacheOwnerTransaction): CacheStore {
  return { beginOwner: () => owner, location: '', reconcile: async () => {} }
}

function createInput(fileIndex: number, path: string, extract: PreparedInput['language']['extract']): PreparedInput {
  return {
    configHash: 'config',
    fileIndex,
    language: { extract, name: 'custom' },
    languageOptions: {},
    path,
    rules: [],
    settings: {},
  }
}

function createOwner(commits: Array<undefined | { contentHash?: string, mode?: 'merge' | 'replace' }>): CacheOwnerTransaction {
  return { commit: metadata => commits.push(metadata), discard: () => {}, lookup: () => undefined, put: () => {} }
}

function createRuntime(): RuleRuntime {
  const rule = defineRule({ create: () => ({ onTargetWith: () => {} }) })
  return {
    cacheable: true,
    enabledRule: { id: 'plugin/rule', localId: 'rule', options: [], rule, severity: 'warn' },
    executionState: new AsyncLocalStorage(),
    handlers: rule.create({} as never),
    ruleHash: 'rule',
    ruleIndex: 0,
  }
}

function createScheduler(concurrency: number, execute = async (job: Parameters<ConstructorParameters<typeof RuleScheduler>[0]['execute']>[0]) => completed(job)) {
  return new RuleScheduler({ clock: () => 1, concurrency, execute, progress: createRunProgress(8) })
}

function createSourceRuntime(readFile: (path: string) => Promise<SourceFile>): SourceRuntime {
  return {
    getText: target => target.text,
    readFile,
    sliceLines: () => {
      throw new Error('unused')
    },
    sliceRange: () => {
      throw new Error('unused')
    },
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition not reached')
}
