import type { ClassUnit, FunctionUnit, SourceFile, SourceRange } from './types'

import { parseSync } from 'oxc-parser'

import { sliceRange } from './runtime'

export interface JsSourceUnits {
  classes: ClassUnit[]
  functions: FunctionUnit[]
}

interface AstNode {
  [key: string]: unknown
  async?: boolean
  declaration?: AstNode | null
  end?: number
  id?: AstNode | null
  key?: AstNode | null
  name?: string
  range?: [number, number]
  start?: number
  type?: string
}

interface VisitState {
  bindingNodes: Map<string, AstNode>
  classes: ClassUnit[]
  exportedNodes: Set<AstNode>
  file: SourceFile
  functions: FunctionUnit[]
  inferredNames: Map<AstNode, string>
  seenClasses: Set<AstNode>
  seenFunctions: Set<AstNode>
  visited: Set<AstNode>
}

export function extractJsSourceUnits(file: SourceFile): JsSourceUnits {
  const result = parseSync(file.path, file.text, {
    sourceType: 'module',
  })
  const state: VisitState = {
    bindingNodes: new Map(),
    classes: [],
    exportedNodes: new Set(),
    file,
    functions: [],
    inferredNames: new Map(),
    seenClasses: new Set(),
    seenFunctions: new Set(),
    visited: new Set(),
  }

  collectModuleBindings(result.program as unknown as AstNode, state)
  collectExportedBindings(result.program as unknown as AstNode, state)
  visit(result.program as unknown as AstNode, state)

  return {
    classes: state.classes,
    functions: state.functions,
  }
}

function addClassUnit(node: AstNode, state: VisitState): void {
  if (state.seenClasses.has(node)) {
    return
  }

  const unit = createClassUnit(node, state)

  if (!unit) {
    return
  }

  state.seenClasses.add(node)
  state.classes.push(unit)
}

function addFunctionUnit(node: AstNode, state: VisitState): void {
  if (state.seenFunctions.has(node)) {
    return
  }

  const unit = createFunctionUnit(node, state)

  if (!unit) {
    return
  }

  state.seenFunctions.add(node)
  state.functions.push(unit)
}

function asAstNode(value: unknown): AstNode | undefined {
  return isAstNode(value) ? value : undefined
}

function collectDeclarationBindings(node: AstNode, state: VisitState): void {
  const name = getNodeName(node)

  if (name && (isClassNode(node) || isFunctionNode(node))) {
    state.bindingNodes.set(name, node)
    return
  }

  if (node.type !== 'VariableDeclaration' || !Array.isArray(node.declarations)) {
    return
  }

  for (const declarator of node.declarations) {
    if (!isAstNode(declarator)) {
      continue
    }

    const id = asAstNode(declarator.id)
    const initializer = asAstNode(declarator.init)

    if (typeof id?.name === 'string' && initializer && (isClassNode(initializer) || isFunctionNode(initializer))) {
      state.bindingNodes.set(id.name, initializer)
    }
  }
}

function collectExportedBindings(node: AstNode | AstNode[] | null | undefined, state: VisitState): void {
  if (!node) {
    return
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      collectExportedBindings(child, state)
    }

    return
  }

  if (node.type === 'ExportNamedDeclaration' && !node.source && Array.isArray(node.specifiers)) {
    for (const specifier of node.specifiers) {
      if (!isAstNode(specifier) || specifier.type !== 'ExportSpecifier') {
        continue
      }

      const local = asAstNode(specifier.local)

      if (typeof local?.name === 'string') {
        markExportedBinding(local.name, state)
      }
    }
  }
  else if (node.type === 'ExportDefaultDeclaration') {
    const declaration = asAstNode(node.declaration)

    if (typeof declaration?.name === 'string') {
      markExportedBinding(declaration.name, state)
    }
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      collectExportedBindings(value.filter(isAstNode), state)
    }
    else if (isAstNode(value)) {
      collectExportedBindings(value, state)
    }
  }
}

function collectModuleBindings(program: AstNode, state: VisitState): void {
  if (!Array.isArray(program.body)) {
    return
  }

  for (const statement of program.body) {
    if (!isAstNode(statement)) {
      continue
    }

    const declaration = isExportDeclaration(statement)
      ? asAstNode(statement.declaration)
      : statement

    if (declaration) {
      collectDeclarationBindings(declaration, state)
    }
  }
}

function createClassUnit(node: AstNode, state: VisitState): ClassUnit | undefined {
  const range = getRange(node)

  if (!range) {
    return undefined
  }

  const source = sliceRange(state.file, range)

  return {
    exported: isExportedUnit(node, state),
    file: state.file,
    kind: 'class',
    loc: source.loc,
    name: getNodeName(node) ?? state.inferredNames.get(node),
    range,
    text: source.text,
  }
}

function createFunctionUnit(node: AstNode, state: VisitState): FunctionUnit | undefined {
  const range = getRange(node)

  if (!range) {
    return undefined
  }

  const source = sliceRange(state.file, range)
  const functionNode = node.type === 'MethodDefinition' ? asAstNode(node.value) : node

  return {
    async: functionNode?.async === true,
    exported: isExportedUnit(node, state),
    file: state.file,
    kind: 'function',
    loc: source.loc,
    name: getNodeName(node) ?? getNodeName(functionNode) ?? state.inferredNames.get(node),
    range,
    text: source.text,
  }
}

function getNodeName(node: AstNode | null | undefined): string | undefined {
  if (!node) {
    return undefined
  }

  if (typeof node.name === 'string') {
    return node.name
  }

  const id = asAstNode(node.id)

  if (typeof id?.name === 'string') {
    return id.name
  }

  const key = asAstNode(node.key)

  if (typeof key?.name === 'string') {
    return key.name
  }

  if (typeof key?.value === 'string' || typeof key?.value === 'number') {
    return String(key.value)
  }

  return undefined
}

function getRange(node: AstNode): SourceRange | undefined {
  if (typeof node.start === 'number' && typeof node.end === 'number') {
    return {
      end: node.end,
      start: node.start,
    }
  }

  if (Array.isArray(node.range) && node.range.length === 2) {
    return {
      end: node.range[1],
      start: node.range[0],
    }
  }

  return undefined
}

function inferChildName(parent: AstNode, key: string, child: AstNode, state: VisitState): void {
  if (state.inferredNames.has(child)) {
    return
  }

  if (parent.type === 'VariableDeclarator' && key === 'init') {
    const id = asAstNode(parent.id)

    if (typeof id?.name === 'string') {
      state.inferredNames.set(child, id.name)
    }
  }

  if (parent.type === 'Property' && key === 'value') {
    const name = getNodeName(parent)

    if (name) {
      state.inferredNames.set(child, name)
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string'
}

function isClassNode(node: AstNode): boolean {
  return node.type === 'ClassDeclaration' || node.type === 'ClassExpression'
}

function isExportDeclaration(node: AstNode): boolean {
  return node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration'
}

function isExportedUnit(node: AstNode, state: VisitState): boolean {
  return state.exportedNodes.has(node)
}

function isFunctionNode(node: AstNode): boolean {
  return node.type === 'ArrowFunctionExpression'
    || node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
}

function markExportedBinding(name: string, state: VisitState): void {
  const bindingNode = state.bindingNodes.get(name)

  if (bindingNode) {
    state.exportedNodes.add(bindingNode)
  }
}

function markExportedDeclaration(node: AstNode, state: VisitState): void {
  state.exportedNodes.add(node)

  if (node.type !== 'VariableDeclaration' || !Array.isArray(node.declarations)) {
    return
  }

  for (const declarator of node.declarations) {
    if (!isAstNode(declarator)) {
      continue
    }

    const initializer = asAstNode(declarator.init)

    if (initializer && (isClassNode(initializer) || isFunctionNode(initializer))) {
      state.exportedNodes.add(initializer)
    }
  }
}

function visit(node: AstNode | AstNode[] | null | undefined, state: VisitState): void {
  if (!node) {
    return
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      visit(child, state)
    }

    return
  }

  if (state.visited.has(node)) {
    return
  }

  state.visited.add(node)

  if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
    if (node.declaration) {
      markExportedDeclaration(node.declaration, state)
      visit(node.declaration, state)
    }

    visitChildren(node, state, new Set(['declaration']))
    return
  }

  if (isClassNode(node)) {
    addClassUnit(node, state)
  }
  else if (isFunctionNode(node) || node.type === 'MethodDefinition') {
    addFunctionUnit(node, state)

    const methodValue = node.type === 'MethodDefinition' ? asAstNode(node.value) : undefined

    if (methodValue) {
      state.seenFunctions.add(methodValue)
    }
  }

  visitChildren(node, state)
}

function visitChildren(node: AstNode, state: VisitState, skippedKeys = new Set<string>()): void {
  for (const [key, value] of Object.entries(node)) {
    if (skippedKeys.has(key) || key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      continue
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          inferChildName(node, key, child, state)
          visit(child, state)
        }
      }
    }
    else if (isAstNode(value)) {
      inferChildName(node, key, value, state)
      visit(value, state)
    }
  }
}
