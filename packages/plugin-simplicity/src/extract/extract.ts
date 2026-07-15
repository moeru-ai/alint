import type { SourceRange } from '@alint-js/plugin'

import type { CallSite, ExtractedFunction, ExtractLanguage, SourceExtract } from './types'

import Parser from 'web-tree-sitter'

import { grammarFor } from './parser'
import { querySource } from './queries'

const queries = new Map<ExtractLanguage, Parser.Query>()

export async function extractSource(source: string, language: ExtractLanguage): Promise<SourceExtract> {
  const grammar = await grammarFor(language)

  const parser = new Parser()
  parser.setLanguage(grammar)
  const tree = parser.parse(source)

  let query = queries.get(language)
  if (query === undefined) {
    query = grammar.query(querySource(language))
    queries.set(language, query)
  }

  const calls: CallSite[] = []
  const comments: SourceRange[] = []
  const identifiers: SourceRange[] = []
  const anchored = new Set<number>()
  const binders: Parser.SyntaxNode[] = []
  const functionNodes: Parser.SyntaxNode[] = []
  const exportedNames = new Set<string>()

  for (const { name, node } of query.captures(tree.rootNode)) {
    switch (name) {
      case 'anchor':
        anchored.add(node.startIndex)
        break
      case 'binder':
        binders.push(node)
        break
      case 'call':
        calls.push({ name: node.text, range: rangeOf(node) })
        break
      case 'comment':
        comments.push(rangeOf(node))
        break
      case 'export':
        exportedNames.add(node.text)
        break
      case 'function':
        functionNodes.push(node)
        break
      case 'identifier':
        identifiers.push(rangeOf(node))
        break
    }
  }

  const renameable = identifiers.filter(range => !anchored.has(range.start))

  const commentStarts = new Set(comments.map(range => range.start))

  return {
    calls,
    functions: functionNodes.map(node => extractFunction(node, source, language, comments, commentStarts, renameable, binders, exportedNames)),
  }
}

function bodyIsSingleExpressionOf(node: Parser.SyntaxNode, commentStarts: ReadonlySet<number>): boolean {
  const { arrowExpression, statements } = bodyOf(node, commentStarts)

  if (arrowExpression) {
    return true
  }

  return statements.length === 1 && !holdsBlock(statements[0])
}

/** The body's statements, with comments left out, and whether the body is a bare arrow expression. */
function bodyOf(
  node: Parser.SyntaxNode,
  commentStarts: ReadonlySet<number>,
): { arrowExpression: boolean, statements: Parser.SyntaxNode[] } {
  const callable = callableOf(node)
  const body = callable.childForFieldName('body')

  if (body === null) {
    return { arrowExpression: false, statements: [] }
  }

  // `=> String(value)` is a bare expression, and the whole helper is that expression.
  if (callable.type === 'arrow_function' && body.type !== 'statement_block') {
    return { arrowExpression: true, statements: [body] }
  }

  const statements: Parser.SyntaxNode[] = []

  for (let index = 0; index < body.namedChildCount; index += 1) {
    const child = body.namedChild(index)

    if (child !== null && !commentStarts.has(child.startIndex)) {
      statements.push(child)
    }
  }

  return { arrowExpression: false, statements }
}

/**
 * A comment is a named child of its block in every grammar here, so comments must be filtered out
 * or a commented one-line helper counts as two statements.
 */
function bodyStatementsOf(node: Parser.SyntaxNode, commentStarts: ReadonlySet<number>): number {
  return bodyOf(node, commentStarts).statements.length
}

/** The captured node, except for an arrow or function expression, which sits in its declarator's `value`. */
function callableOf(node: Parser.SyntaxNode): Parser.SyntaxNode {
  if (node.type !== 'variable_declarator') {
    return node
  }

  return node.childForFieldName('value') ?? node
}

function extractFunction(
  node: Parser.SyntaxNode,
  source: string,
  language: ExtractLanguage,
  comments: readonly SourceRange[],
  commentStarts: ReadonlySet<number>,
  identifiers: readonly SourceRange[],
  binders: readonly Parser.SyntaxNode[],
  exportedNames: ReadonlySet<string>,
): ExtractedFunction {
  // For an arrow this is the declarator, not the whole statement: `const` versus `let` is not
  // part of a helper's identity, and `export` is answered by `exported`.
  const range = rangeOf(node)

  const nameNode = node.childForFieldName('name')

  return {
    binderNames: [...new Set([
      ...nodesInside(binders, range).map(binder => binder.text),
      ...(nameNode ? [nameNode.text] : []),
    ])],
    bodyIsSingleExpression: bodyIsSingleExpressionOf(node, commentStarts),
    bodyStatements: bodyStatementsOf(node, commentStarts),
    commentRanges: rangesInside(comments, range),
    exported: isExported(node, language, nameNode?.text ?? '', exportedNames),
    identifierRanges: withOwnName(rangesInside(identifiers, range), nameNode, range),
    loc: {
      end: { column: node.endPosition.column, line: node.endPosition.row + 1 },
      start: { column: node.startPosition.column, line: node.startPosition.row + 1 },
    },
    // An incomplete function (`function () {}` mid-edit) parses with no name; callers skip it.
    name: nameNode?.text ?? '',
    range,
    text: source.slice(range.start, range.end),
  }
}

/** Whether anything under this node is a block, which is how every grammar here writes a branch or a loop. */
function holdsBlock(node: Parser.SyntaxNode): boolean {
  const pending = [...node.namedChildren]

  while (pending.length > 0) {
    const next = pending.pop()

    if (next === undefined) {
      continue
    }

    if (next.type === 'block' || next.type === 'statement_block') {
      return true
    }

    pending.push(...next.namedChildren)
  }

  return false
}

/** Reachable from outside its file. Each language spells it differently: `export_statement`, `pub`, or the name itself. */
function isExported(
  node: Parser.SyntaxNode,
  language: ExtractLanguage,
  name: string,
  exportedNames: ReadonlySet<string>,
): boolean {
  switch (language) {
    case 'go':
      return /^[A-Z]/.test(name)
    case 'python':
      return !name.startsWith('_')
    case 'rust':
      return node.children.some(child => child.type === 'visibility_modifier')
    default: {
      // A declarator sits one level deeper than a function (`export const f = () => {}` exports the
      // `lexical_declaration`), so ask its parent. Every declarator of one statement is then exported.
      const declaration = node.type === 'variable_declarator' ? node.parent : node

      return declaration?.parent?.type === 'export_statement' || exportedNames.has(name)
    }
  }
}

function nodesInside(nodes: readonly Parser.SyntaxNode[], outer: SourceRange): Parser.SyntaxNode[] {
  return nodes.filter(node => node.startIndex >= outer.start && node.endIndex <= outer.end)
}

/** Offsets are into the JS string, matching `source.slice`, not UTF-8 bytes. */
function rangeOf(node: Parser.SyntaxNode): SourceRange {
  return { end: node.endIndex, start: node.startIndex }
}

/** Rebases the contained ranges onto the function's own text. */
function rangesInside(ranges: readonly SourceRange[], outer: SourceRange): SourceRange[] {
  return ranges
    .filter(range => range.start >= outer.start && range.end <= outer.end)
    .map(range => ({ end: range.end - outer.start, start: range.start - outer.start }))
}

/**
 * The function's own name, added to its renameable identifiers. A `method_definition` name is a
 * `property_identifier`, which the query keeps out of `@identifier`; a `function_declaration` name is
 * already there, hence the dedupe by start offset.
 */
function withOwnName(
  ranges: SourceRange[],
  nameNode: null | Parser.SyntaxNode,
  outer: SourceRange,
): SourceRange[] {
  if (nameNode === null) {
    return ranges
  }

  const name: SourceRange = {
    end: nameNode.endIndex - outer.start,
    start: nameNode.startIndex - outer.start,
  }

  if (ranges.some(range => range.start === name.start)) {
    return ranges
  }

  return [...ranges, name].sort((left, right) => left.start - right.start)
}
