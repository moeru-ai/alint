import type { LineRange, SourceFile, SourcePosition, SourceRange, SourceRuntime, SourceText } from './types'

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

export function createSourceFile(path: string, text: string): SourceFile {
  return {
    language: inferLanguage(path),
    lines: text.split(/\r?\n/),
    path,
    text,
  }
}

export function createSourceRuntime(): SourceRuntime {
  return {
    getText: target => target.text,
    readFile: async filePath => createSourceFile(filePath, await readFile(filePath, 'utf8')),
    sliceLines,
    sliceRange,
  }
}

export function sliceLines(file: SourceFile, range: LineRange): SourceText {
  const startLine = clampLine(range.startLine, file.lines.length)
  const endLine = clampLine(range.endLine, file.lines.length)
  const orderedStartLine = Math.min(startLine, endLine)
  const orderedEndLine = Math.max(startLine, endLine)
  const text = file.lines.slice(orderedStartLine - 1, orderedEndLine).join('\n')

  return {
    filePath: file.path,
    loc: {
      end: {
        column: file.lines[orderedEndLine - 1]?.length ?? 0,
        line: orderedEndLine,
      },
      start: {
        column: 0,
        line: orderedStartLine,
      },
    },
    text,
  }
}

export function sliceRange(file: SourceFile, range: SourceRange): SourceText {
  const start = clampOffset(range.start, file.text.length)
  const end = clampOffset(range.end, file.text.length)
  const orderedStart = Math.min(start, end)
  const orderedEnd = Math.max(start, end)

  return {
    filePath: file.path,
    loc: {
      end: getPosition(file.text, orderedEnd),
      start: getPosition(file.text, orderedStart),
    },
    text: file.text.slice(orderedStart, orderedEnd),
  }
}

function clampLine(line: number, lineCount: number): number {
  if (lineCount === 0) {
    return 1
  }

  return Math.min(Math.max(Math.trunc(line), 1), lineCount)
}

function clampOffset(offset: number, textLength: number): number {
  return Math.min(Math.max(Math.trunc(offset), 0), textLength)
}

function getPosition(text: string, offset: number): SourcePosition {
  let line = 1
  let column = 0
  let index = 0

  while (index < offset) {
    const character = text[index]

    if (character === '\r') {
      if (text[index + 1] === '\n' && index + 1 < offset) {
        index += 1
      }

      line += 1
      column = 0
    }
    else if (character === '\n') {
      line += 1
      column = 0
    }
    else {
      column += 1
    }

    index += 1
  }

  return { column, line }
}

function inferLanguage(path: string): SourceFile['language'] {
  switch (extname(path)) {
    case '.cjs':
    case '.js':
    case '.jsx':
    case '.mjs':
      return 'javascript'
    case '.cts':
    case '.mts':
    case '.ts':
    case '.tsx':
      return 'typescript'
    default:
      return 'unknown'
  }
}
