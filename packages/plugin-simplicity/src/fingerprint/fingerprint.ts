import type { SourceRange } from '@alint-js/core'

import { createHash } from 'node:crypto'

interface Edit {
  end: number
  replacement: string
  start: number
}

const CONTENT_TOKEN = /[a-z_$][\w$]*|\d+(?:\.\d+)?/gi

/**
 * Hashes a function with the names it declares (own name, parameters, locals) replaced by
 * placeholders. Same alpha fingerprint means the same function, renamed.
 *
 * `identifierRanges` must hold renameable identifiers only. Replacing property, field or type
 * names is the mistake this fingerprint exists to avoid.
 */
export function alphaFingerprint(
  text: string,
  commentRanges: readonly SourceRange[],
  identifierRanges: readonly SourceRange[],
  binderNames: readonly string[],
): string {
  return hash(alphaNormalize(text, commentRanges, identifierRanges, binderNames))
}

/** Hashes a function with comments and formatting removed, so layout and docs do not count. */
export function exactFingerprint(text: string, commentRanges: readonly SourceRange[]): string {
  return hash(normalize(text, commentRanges))
}

/** Comments and formatting removed, names left alone, so `search_helper_bodies` can search real code. */
export function normalizedBody(
  text: string,
  commentRanges: readonly SourceRange[],
): string {
  return normalize(text, commentRanges)
}

/** Content tokens, alpha-normalized. Punctuation is dropped: every function has braces. */
export function tokenize(
  text: string,
  commentRanges: readonly SourceRange[],
  identifierRanges: readonly SourceRange[],
  binderNames: readonly string[],
): string[] {
  return alphaNormalize(text, commentRanges, identifierRanges, binderNames).match(CONTENT_TOKEN) ?? []
}

/** Shared token fraction of the larger bag. Ranks candidates, decides nothing. */
export function tokenOverlap(left: readonly string[], right: readonly string[]): number {
  const longest = Math.max(left.length, right.length)

  if (longest === 0) {
    return 0
  }

  const remaining = new Map<string, number>()

  for (const token of left) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1)
  }

  let shared = 0

  for (const token of right) {
    const available = remaining.get(token) ?? 0

    if (available > 0) {
      remaining.set(token, available - 1)
      shared += 1
    }
  }

  return shared / longest
}

function alphaNormalize(
  text: string,
  commentRanges: readonly SourceRange[],
  identifierRanges: readonly SourceRange[],
  binderNames: readonly string[],
): string {
  const declared = new Set(binderNames)

  // Every occurrence, not just the declaration site: a renamed copy only matches if the name
  // reads as the same placeholder throughout the body.
  const renameable = identifierRanges.filter(range => declared.has(text.slice(range.start, range.end)))

  return normalize(text, commentRanges, renameable)
}

function byStart(left: SourceRange, right: SourceRange): number {
  return left.start - right.start
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function normalize(
  text: string,
  commentRanges: readonly SourceRange[],
  renameableRanges?: readonly SourceRange[],
): string {
  // A space, not nothing: dropping the comment outright glues `a/* c */b` into `ab`.
  const edits: Edit[] = commentRanges.map(range => ({ end: range.end, replacement: ' ', start: range.start }))

  if (renameableRanges !== undefined)
    edits.push(...placeholderEdits(text, renameableRanges))

  edits.sort(byStart)

  let normalized = ''
  let cursor = 0
  for (const edit of edits) {
    normalized += text.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
  }
  normalized += text.slice(cursor)

  // Runs collapse rather than disappear: reindenting a copy keeps its fingerprint, but `f( a )`
  // and `f(a)` still differ. Closing that needs a full token list, and ESLint keeps spacing canonical.
  return normalized.replaceAll(/\s+/g, ' ').trim()
}

function placeholderEdits(text: string, ranges: readonly SourceRange[]): Edit[] {
  const placeholders = new Map<string, string>()

  // Sorted before numbering, so a placeholder depends on where the name first appears, not on the
  // order the extractor reported the ranges in.
  return [...ranges].sort(byStart).map((range) => {
    const name = text.slice(range.start, range.end)

    // `$0` cannot collide: a `$0` written in the source is an identifier and gets replaced too.
    let placeholder = placeholders.get(name)
    if (placeholder === undefined) {
      placeholder = `$${placeholders.size}`
      placeholders.set(name, placeholder)
    }

    return { end: range.end, replacement: placeholder, start: range.start }
  })
}
