import type { RuleContext } from '@alint-js/core'

import type { ExtractLanguage } from '../extract'

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'

import { DEFAULT_IGNORE_PATTERNS, listFiles } from '@alint-js/tools-fs'
import { errorMessageFrom } from '@moeru/std/error'
import { minimatch } from 'minimatch'

import { extractSource, resolveExtractLanguage } from '../extract'
import { alphaFingerprint, exactFingerprint, normalizedBody, tokenize, tokenOverlap } from '../fingerprint'

export type { DecisionCache, JudgedHelper, ReviewCache } from './cache'
export { decisionCacheFor, reviewCacheFor } from './cache'

export interface IndexedHelper {
  alphaFingerprint: string
  /** Comments and formatting removed, names left alone, so `search_helper_bodies` searches real code. */
  body: string
  bodyIsSingleExpression: boolean
  /** Statements in the body, not counting comments. */
  bodyStatements: number
  exactFingerprint: string
  exported: boolean
  filePath: string
  /** `packages/cli/src/lint.ts:57`. Unique, and a model can quote it back. */
  id: string
  language: ExtractLanguage
  line: number
  lines: number
  name: string
  text: string
  tokens: string[]
  /**
   * How often a function of this name is called across the workspace.
   *
   * Counted by NAME, not by binding, so two `isEmpty` helpers share a count and `x.isEmpty()` counts too.
   * Only ever handed to the judge as an approximate fact.
   */
  usageCount: number
}

export interface RepoIndex {
  byAlpha: Map<string, IndexedHelper[]>
  byExact: Map<string, IndexedHelper[]>
  byId: Map<string, IndexedHelper>
  /** Every helper in the workspace, in one hash. What a cached review is stamped with. */
  fingerprint: string
  helpers: IndexedHelper[]
}

export interface RepoIndexOptions {
  cwd: string
  ignores: readonly string[]
  maxLines: number
  minTokens: number
}

// A duplicate is a fact about the workspace, not about one file: the copy may live in a file this
// run never lints. Built once per run over every parseable file, which also keeps reports ordered.
const indexes = new WeakMap<RuleContext['src'], Promise<RepoIndex>>()

/** Helpers of one file, in source order. */
export function helpersIn(index: RepoIndex, filePath: string): IndexedHelper[] {
  return index.helpers.filter(helper => helper.filePath === filePath)
}

export async function repoIndexFor(ctx: RuleContext, options: RepoIndexOptions): Promise<RepoIndex> {
  const existing = indexes.get(ctx.src)

  if (existing !== undefined) {
    return existing
  }

  // The promise, not the result: files reach this in parallel, and the second must wait for the
  // first scan rather than start its own.
  const building = buildRepoIndex(ctx, options)
  indexes.set(ctx.src, building)

  return building
}

/** Closest first by token overlap, which ranks candidates and decides nothing; see `tokenOverlap`. */
export function similarTo(index: RepoIndex, helper: IndexedHelper, limit: number): IndexedHelper[] {
  return index.helpers
    .filter(other => other.id !== helper.id && other.language === helper.language)
    .map(other => ({ other, score: tokenOverlap(helper.tokens, other.tokens) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(entry => entry.other)
}

/** Every other helper sharing a fingerprint. A helper is never its own twin. */
export function twinsOf(
  index: RepoIndex,
  helper: IndexedHelper,
  kind: 'alpha' | 'exact',
): IndexedHelper[] {
  const bucket = kind === 'exact' ? index.byExact : index.byAlpha
  const fingerprint = kind === 'exact' ? helper.exactFingerprint : helper.alphaFingerprint

  return (bucket.get(fingerprint) ?? []).filter(other => other.id !== helper.id)
}

async function buildRepoIndex(ctx: RuleContext, options: RepoIndexOptions): Promise<RepoIndex> {
  const index: RepoIndex = {
    byAlpha: new Map(),
    byExact: new Map(),
    byId: new Map(),
    fingerprint: '',
    helpers: [],
  }

  const paths = await listFiles(options.cwd, {
    ignore: [...DEFAULT_IGNORE_PATTERNS, ...options.ignores],
    patterns: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,rs,go,py}'],
  })

  // Counted while each file is already parsed, rather than in a second pass.
  const calls = new Map<string, number>()

  for (const path of paths.sort()) {
    const language = resolveExtractLanguage(path)

    if (language === undefined || isIgnored(options.cwd, path, options.ignores)) {
      continue
    }

    let text: string

    try {
      text = await readFile(path, 'utf8')
    }
    catch (error) {
      ctx.logger.debug(`simplicity: could not read ${path}: ${errorMessageFrom(error) ?? 'unknown error'}`)
      continue
    }

    for (const helper of await helpersOf(ctx, path, text, language, options, calls)) {
      index.helpers.push(helper)
      index.byId.set(helper.id, helper)
      push(index.byExact, helper.exactFingerprint, helper)
      push(index.byAlpha, helper.alphaFingerprint, helper)
    }
  }

  for (const helper of index.helpers) {
    helper.usageCount = calls.get(helper.name) ?? 0
  }

  // Keyed by position as well as content: a helper that only moved is reported at a new line, so a
  // cached review pointing at the old one is stale.
  index.fingerprint = createHash('sha256')
    .update(index.helpers.map(helper => `${helper.id}:${helper.exactFingerprint}`).join('\n'))
    .digest('hex')

  ctx.logger.debug(`simplicity: indexed ${index.helpers.length} helpers from ${paths.length} files`)

  return index
}

async function helpersOf(
  ctx: RuleContext,
  filePath: string,
  text: string,
  language: ExtractLanguage,
  options: RepoIndexOptions,
  calls: Map<string, number>,
): Promise<IndexedHelper[]> {
  let functions
  let sourceCalls

  try {
    ({ calls: sourceCalls, functions } = await extractSource(text, language))
  }
  catch (error) {
    // A file that cannot be parsed costs its own helpers, never the run.
    ctx.logger.debug(`simplicity: skipped ${filePath}: ${errorMessageFrom(error) ?? 'could not be parsed'}`)

    return []
  }

  for (const call of sourceCalls) {
    calls.set(call.name, (calls.get(call.name) ?? 0) + 1)
  }

  const helpers: IndexedHelper[] = []

  for (const fn of functions) {
    const lines = fn.loc.end.line - fn.loc.start.line + 1
    const tokens = tokenize(fn.text, fn.commentRanges, fn.identifierRanges, fn.binderNames)

    if (fn.name === '' || lines > options.maxLines || tokens.length < options.minTokens) {
      continue
    }

    helpers.push({
      alphaFingerprint: alphaFingerprint(fn.text, fn.commentRanges, fn.identifierRanges, fn.binderNames),
      body: normalizedBody(fn.text, fn.commentRanges),
      bodyIsSingleExpression: fn.bodyIsSingleExpression,
      bodyStatements: fn.bodyStatements,
      exactFingerprint: exactFingerprint(fn.text, fn.commentRanges),
      exported: fn.exported,
      filePath,
      id: `${relative(options.cwd, filePath)}:${fn.loc.start.line}`,
      language,
      line: fn.loc.start.line,
      lines,
      name: fn.name,
      text: fn.text,
      tokens,
      // Filled in once every file has been counted.
      usageCount: 0,
    })
  }

  return helpers
}

function isIgnored(cwd: string, filePath: string, ignores: readonly string[]): boolean {
  const relativePath = relative(cwd, filePath)

  return ignores.some(pattern => minimatch(relativePath, pattern, { dot: true }))
}

function push(bucket: Map<string, IndexedHelper[]>, key: string, helper: IndexedHelper): void {
  bucket.set(key, [...bucket.get(key) ?? [], helper])
}
