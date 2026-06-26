export interface ClassUnit extends SourceUnit {
  exported: boolean
  kind: 'class'
}

export interface FunctionUnit extends SourceUnit {
  async: boolean
  exported: boolean
  kind: 'function'
}

export interface LineRange {
  endLine: number
  startLine: number
}

export interface SourceFile {
  language: 'javascript' | 'typescript' | 'unknown'
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
  getText: (target: SourceFile | SourceUnit) => string
  readFile: (filePath: string) => Promise<SourceFile>
  sliceLines: (file: SourceFile, range: LineRange) => SourceText
  sliceRange: (file: SourceFile, range: SourceRange) => SourceText
}

export interface SourceText {
  filePath: string
  loc: SourceLocation
  text: string
}

export interface SourceUnit {
  file: SourceFile
  kind: 'class' | 'function'
  loc: SourceLocation
  name?: string
  range: SourceRange
  text: string
}
