/**
 * Carried on a file target under `metadata.calls`, in source order.
 *
 * Every call in the file, including those outside any function: a consumer counting how often a
 * name is used has to see the uses, not just the definitions.
 */
export interface CallSite {
  /** The last segment only: `a.b.helper()` and `helper()` both yield `helper`. */
  name: string
  /** Absolute, into the file's text. */
  range: SourceRange
}

export type ClassTarget = SourceTargetOfKind<'class'>

export type FileTarget = SourceTargetOfKind<'file'>

/**
 * Carried under `metadata.function`, so a consumer can fingerprint, count and classify a function
 * without reaching for a parser of its own.
 *
 * Every producer of function targets should fill it in; a consumer validates on read, because
 * `metadata` is `Record<string, unknown>` and the contract is therefore by convention, not by type.
 *
 * Ranges are relative to the target's own `text`, not to the file, so a consumer can slice that
 * text directly and never has to rebase.
 */
export interface FunctionInfo {
  /**
   * Stricter than one statement: a body that is one `if` and its two returns is one statement and
   * not one expression.
   */
  bodyIsSingleExpression: boolean
  /** Statements in the body, not counting comments. */
  bodyStatements: number
  commentRanges: readonly SourceRange[]
  /**
   * The names the function declares: its own name, its parameters and its locals.
   *
   * A copy can rename what it declares and stay a copy, so this is the set an α-renaming
   * fingerprint may replace. Everything else — callees, globals, types, properties — stays
   * verbatim and is what tells two same-shaped functions apart.
   */
  declaredNames: readonly string[]
  /** Reachable from outside its file, however the language spells it. */
  exported: boolean
  /**
   * Identifiers that MAY be renamed away, which is narrower than "every identifier token".
   *
   * Property, field and type names must not be here: replacing them collapses `entry.name` and
   * `entry.size` into the same fingerprint, which is the mistake this set exists to avoid.
   */
  identifierRanges: readonly SourceRange[]
}

export type FunctionTarget = SourceTargetOfKind<'function'>

export interface LanguageContext {
  cwd: string
  languageOptions: Record<string, unknown>
  src: SourceRuntime
}

export interface LineRange {
  endLine: number
  startLine: number
}

export interface ProcessedSource {
  identity: string
  language?: string
  origin?: ProcessedSourceOrigin
  path: string
  text: string
}

export interface ProcessedSourceOrigin {
  physicalPath: string
  range?: SourceRange
  virtualPath?: string
}

export interface ProcessorContext {
  cwd: string
  options: Record<string, unknown>
  src: SourceRuntime
}

export interface ProcessorPostprocessContext extends ProcessorContext {
  file: SourceFile
  processedSources: ProcessedSource[]
}

export interface SourceExtractOptions {
  /**
   * Overrides the file's configured `language:` pin.
   *
   * For a caller walking a mixed tree, where the file's own config cannot know what each file is.
   */
  language?: string
}

export interface SourceFile {
  language: string
  lines: string[]
  path: string
  text: string
}

export interface SourceLocation {
  end: SourcePosition
  start: SourcePosition
}

export interface SourcePosition {
  column: number
  line: number
}

export interface SourceRange {
  end: number
  start: number
}
export interface SourceRuntime {
  /**
   * Targets for any file, linted or not.
   *
   * Resolves the file's own config the way linting does, resolves its language from that config,
   * and runs that language's extract. A rule handed `ProjectTarget.files`, or an index builder
   * sweeping files outside the lint set, has no other way to parse them.
   *
   * An ignored file extracts to `[]` rather than throwing: sweeping broadly and skipping what the
   * config excluded is the normal case, not an error.
   *
   * Only wired inside a run. A runtime built by `createSourceRuntime()` with no extractor throws,
   * because there is no config to resolve the file against.
   */
  extract: (filePath: string, options?: SourceExtractOptions) => Promise<SourceTarget[]>
  getText: (target: SourceFile | SourceTarget) => string
  readFile: (filePath: string) => Promise<SourceFile>
  sliceLines: (file: SourceFile, range: LineRange) => SourceText
  sliceRange: (file: SourceFile, range: SourceRange) => SourceText
}
export interface SourceTarget {
  file: SourceFile
  identity: string
  kind: SourceTargetKind
  language: string
  loc?: SourceLocation
  metadata?: Record<string, unknown>
  name?: string
  origin?: SourceTargetOrigin
  range?: SourceRange
  text: string
}

export type SourceTargetKind = 'class' | 'file' | 'fragment' | 'function' | 'symbol' | (string & {})

export type SourceTargetOfKind<Kind extends SourceTargetKind> = Omit<SourceTarget, 'kind'> & {
  kind: Kind
}

export interface SourceTargetOrigin {
  physicalPath: string
  range?: SourceRange
  virtualPath?: string
}

export interface SourceText {
  filePath: string
  loc: SourceLocation
  text: string
}
