import type { SourceLocation, SourceRange } from '@alint-js/core'

export interface CallSite {
  /** The last segment only: `a.b.helper()` and `helper()` both yield `helper`. */
  name: string
  range: SourceRange
}

export interface ExtractedFunction {
  /** The names this function declares. Everything else stays verbatim in the alpha fingerprint; see `queries.ts`. */
  binderNames: string[]
  /** Stricter than one statement: a body that is one `if` and its two returns is one statement and not one expression. */
  bodyIsSingleExpression: boolean
  bodyStatements: number
  /** Relative to `text`, not to the source. */
  commentRanges: SourceRange[]
  exported: boolean
  /** Relative to `text`. Property, field and type names are not here: replacing them would collapse `entry.name` and `entry.size`. */
  identifierRanges: SourceRange[]
  /** Absolute. Lines are 1-based, columns 0-based. */
  loc: SourceLocation
  name: string
  /** Absolute offsets into the source. */
  range: SourceRange
  text: string
}

export type ExtractLanguage = 'go' | 'javascript' | 'python' | 'rust' | 'tsx' | 'typescript'

export interface SourceExtract {
  /** Every call in the source, including calls made outside any function. */
  calls: CallSite[]
  functions: ExtractedFunction[]
}
