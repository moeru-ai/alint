export type ClassTarget = SourceTargetOfKind<'class'>

export type FileTarget = SourceTargetOfKind<'file'>

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
  getText: (target: SourceFile | SourceTarget) => string
  readFile: (filePath: string) => Promise<SourceFile>
  sliceLines: (file: SourceFile, range: LineRange) => SourceText
  sliceRange: (file: SourceFile, range: SourceRange) => SourceText
}

/** Diagnostic counters for asserting the bounded lifetime of live source text. */
export interface SourceSessionMetrics {
  active: number
  closed: number
  maximumActive: number
  opened: number
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
