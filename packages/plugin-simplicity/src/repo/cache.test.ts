import type { RuleContext } from '@alint-js/plugin'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reviewCacheFor } from './cache'
import { createFixtureContext } from './fixtures'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'simplicity-cache-'))
})

afterEach(async () => {
  await rm(cwd, { force: true, recursive: true })
})

/** A fresh context is a fresh run: the cache is memoized on `src`. */
function run(): RuleContext<[]> {
  return createFixtureContext({ cwd })
}

const FINDING = { helperId: 'a.ts:1', reason: 'Both read a file.', twinId: 'b.ts:1' }

describe('reviewCacheFor', () => {
  it('remembers a review across runs, when nothing in the workspace changed', async () => {
    const first = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })
    await first.set(join(cwd, 'a.ts'), [FINDING])

    const second = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })

    expect(second.get(join(cwd, 'a.ts'))).toStrictEqual([FINDING])
  })

  // What the fingerprint is for: a review decided against one index means nothing against another,
  // so the cache is thrown away whole rather than trusted in part.
  it('forgets everything when any helper in the workspace changed', async () => {
    const before = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })
    await before.set(join(cwd, 'a.ts'), [FINDING])

    const after = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-2' })

    expect(after.get(join(cwd, 'a.ts'))).toBeUndefined()
  })

  it('remembers that a file duplicates nothing, which is most files', async () => {
    const first = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })
    await first.set(join(cwd, 'clean.ts'), [])

    const second = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })

    // Not `undefined`: an empty answer is an answer, and must not be reviewed again.
    expect(second.get(join(cwd, 'clean.ts'))).toStrictEqual([])
  })

  it('keys by repository-relative path, so the cache survives being moved', async () => {
    const first = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })
    await first.set(join(cwd, 'src', 'a.ts'), [FINDING])

    const written = JSON.parse(await readFile(join(cwd, '.alint', 'simplicity', 'reviews.json'), 'utf8')) as {
      reviews: Record<string, unknown>
    }

    expect(Object.keys(written.reviews)).toStrictEqual(['src/a.ts'])
  })

  it('remembers nothing when it is turned off', async () => {
    const off = await reviewCacheFor(run(), { cwd, enabled: false, fingerprint: 'index-1' })
    await off.set(join(cwd, 'a.ts'), [FINDING])

    const on = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })

    expect(on.get(join(cwd, 'a.ts'))).toBeUndefined()
  })

  it('is one cache per run, however many files ask for it', async () => {
    const ctx = run()
    const options = { cwd, enabled: true, fingerprint: 'index-1' }

    const [first, second] = await Promise.all([
      reviewCacheFor(ctx, options),
      reviewCacheFor(ctx, options),
    ])

    expect(second).toBe(first)
  })

  it('treats an unreadable cache as a cold one, never as an error', async () => {
    const cache = await reviewCacheFor(run(), { cwd, enabled: true, fingerprint: 'index-1' })

    expect(cache.get(join(cwd, 'never-written.ts'))).toBeUndefined()
  })
})
