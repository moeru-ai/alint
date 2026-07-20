import { parseSync } from '@alint-js/core/languages/js'

export interface SyntaxNode {
  [key: string]: unknown
  end?: number
  start?: number
  type: string
}

export function childSyntaxNodes(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = []

  for (const value of Object.values(node)) {
    if (isSyntaxNode(value)) {
      children.push(value)
    }
    else if (Array.isArray(value)) {
      children.push(...value.filter(isSyntaxNode))
    }
  }

  return children
}

export function isSyntaxNode(value: unknown): value is SyntaxNode {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && typeof (value as { type?: unknown }).type === 'string'
}

export function parseProgram(filePath: string, source: string): SyntaxNode | undefined {
  try {
    return parseSync(filePath, source, { sourceType: 'module' }).program as unknown as SyntaxNode
  }
  catch {
    return undefined
  }
}

export function sourceLinesForNodes(source: string, nodes: readonly SyntaxNode[]): { line: number, text: string }[] {
  const lineStarts = [0]

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      lineStarts.push(index + 1)
    }
  }

  const lines = source.split('\n')
  const selected = new Map<number, string>()

  for (const node of nodes) {
    if (typeof node.start !== 'number' || typeof node.end !== 'number') {
      continue
    }

    const startLine = offsetLine(lineStarts, node.start)
    const endLine = offsetLine(lineStarts, Math.max(node.start, node.end - 1))

    for (let line = startLine; line <= endLine; line += 1) {
      const text = lines[line - 1]?.trim()

      if (text) {
        selected.set(line, text)
      }
    }
  }

  return [...selected].sort(([left], [right]) => left - right).map(([line, text]) => ({ line, text }))
}

export function visitSyntax(node: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
  visitor(node)

  for (const child of childSyntaxNodes(node)) {
    visitSyntax(child, visitor)
  }
}

function offsetLine(lineStarts: readonly number[], offset: number): number {
  let low = 0
  let high = lineStarts.length

  while (low < high) {
    const middle = Math.floor((low + high) / 2)

    if ((lineStarts[middle] ?? Number.POSITIVE_INFINITY) <= offset) {
      low = middle + 1
    }
    else {
      high = middle
    }
  }

  return Math.max(1, low)
}
