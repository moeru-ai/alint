import type { RuleLanguages } from '../../dsl/types'
import type { SourceTargetKind } from '../source/types'

/**
 * The language a file falls back to when no registered language claims its extension. Not a real
 * language, which is why `'any'` excludes it.
 */
const PLAIN_TEXT = 'plaintext'

/**
 * A rule's `languages` declaration reduced to the three cases the run acts on, so the dispatch path
 * never re-reads the three shapes an author may write.
 */
export type ResolvedRuleLanguages
  = | { ids: readonly string[], kind: 'list', skipMissing: boolean }
    | { kind: 'any' }
    | { kind: 'off' }

/**
 * Whether a rule reads this target.
 *
 * A rule with language off still reads file targets, because reading raw text, or asking a model about a
 * whole file, needs no language. However, it never reads the function and class targets extraction produces.
 * `'file'` is the one kind every language yields, plain text included, so it is the dividing line.
 *
 * `'any'` means any real language, so a file that fell back to plain text because nothing claimed
 * its extension is withheld: the rule asked for structure and there is none to give. The run says so
 * once per extension through `alint/unregistered-language` rather than letting each rule report an
 * empty file.
 */
export function isTargetLanguageAccepted(
  languages: ResolvedRuleLanguages,
  targetKind: SourceTargetKind,
  targetLanguage: string,
): boolean {
  if (languages.kind === 'off')
    return targetKind === 'file'

  if (languages.kind === 'any')
    return targetLanguage !== PLAIN_TEXT

  return languages.ids.includes(targetLanguage)
}

export function resolveRuleLanguages(languages: RuleLanguages | undefined): ResolvedRuleLanguages {
  if (languages === undefined)
    return { kind: 'off' }

  if (languages === 'any')
    return { kind: 'any' }

  if ('ids' in languages)
    return { ids: languages.ids, kind: 'list', skipMissing: languages.skipMissing ?? false }

  return { ids: languages, kind: 'list', skipMissing: false }
}
