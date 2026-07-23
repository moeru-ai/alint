import type { SourceTarget } from '../source/types'

import { extname } from 'node:path'

/**
 * `resolveLanguage` falls back to `text/plain` for any extension nothing registered, which extracts
 * one whole-file target and no functions. A rule looking for functions then reports nothing and the
 * run passes — a missing language pack reads exactly like clean code. This turns that silence into
 * the error it is, in the spirit of `requireAgent`.
 *
 * Targets pass straight through so the guard can wrap the call that produces them:
 * `for (const target of requireLanguage(path, await ctx.src.extract(path)))`.
 */
export function requireLanguage(filePath: string, targets: SourceTarget[]): SourceTarget[] {
  // An ignored file extracts to nothing at all. That is not a missing language: the config excluded
  // the file, and the caller asking about it should skip it, not fail.
  if (targets.length === 0) {
    return targets
  }

  if (targets[0].language !== 'text/plain') {
    return targets
  }

  // An explicit `language: 'text/plain'` pin lands here too, so the message reports what went
  // unclaimed rather than asserting a cause it cannot know.
  throw new TypeError(
    `No language registered for "${extname(filePath)}", so "${filePath}" was extracted as text/plain. Install @alint-js/languages-treesitter and add it to "plugins" in alint config.`,
  )
}
