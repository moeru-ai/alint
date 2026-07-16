import type { RuleContext } from '@alint-js/plugin'

import type { IndexedHelper, RepoIndex } from './index'

import { resolve } from 'node:path'

import { repoIndexFor } from './index'

/**
 * The fixture workspace: real files in four languages. Shared so rule tests and tool tests index
 * the same one, and outside `index.ts` so it never ships.
 */
export const FIXTURES_DIR = resolve(import.meta.dirname, '../../fixtures')

export function createFixtureContext(overrides: Partial<RuleContext<readonly []>> = {}): RuleContext<readonly []> {
  return {
    cwd: FIXTURES_DIR,
    id: 'simplicity/no-duplicated-helper',
    localId: 'no-duplicated-helper',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
    model: () => Promise.resolve({
      aliases: [],
      capabilities: ['tool-call'],
      id: 'test-model',
      name: 'test-model',
      params: {},
      provider: { endpoint: 'http://127.0.0.1:0/v1', headers: {}, id: 'test-provider', type: 'openai-compatible' },
    }),
    options: [],
    report: () => {},
    settings: {},
    // A fresh object per context: the index is memoized on `src`, and one context is one run.
    src: {
      getText: target => target.text,
      readFile: () => {
        throw new Error('unused')
      },
      sliceLines: () => {
        throw new Error('unused')
      },
      sliceRange: () => {
        throw new Error('unused')
      },
    },
    ...overrides,
  }
}

export async function createFixtureIndex(): Promise<RepoIndex> {
  return repoIndexFor(createFixtureContext(), {
    cwd: FIXTURES_DIR,
    ignores: ['alint.config.ts'],
    maxLines: 10,
    minTokens: 5,
  })
}

/**
 * One fixture helper, by file and name. Tests must not spell out a `path:line` id: adding a comment
 * to a fixture moves the code under it and breaks every test that did.
 */
export function fixtureHelper(index: RepoIndex, relativePath: string, name: string): IndexedHelper {
  const helper = index.helpers.find(candidate => candidate.id.startsWith(`${relativePath}:`) && candidate.name === name)

  if (helper === undefined) {
    throw new Error(`no helper named "${name}" in ${relativePath}. The fixture or the index changed.`)
  }

  return helper
}
