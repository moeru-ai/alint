import { readFile, realpath, stat } from 'node:fs/promises'

import { dirname, extname, isAbsolute, relative, resolve } from 'pathe'
import { exports as resolvePackageExport } from 'resolve.exports'

export interface VerifiedPluginPackage {
  apiVersion: string
  entry: string
  name: string
  version: string
}

export interface VerifyExtractedPluginPackageOptions {
  expectedName: string
  expectedVersion: string
  supportedApiVersion: string
}

interface PluginPackageJson {
  alint?: {
    apiVersion?: unknown
  }
  bundledDependencies?: unknown
  bundleDependencies?: unknown
  dependencies?: unknown
  exports?: unknown
  name?: unknown
  optionalDependencies?: unknown
  peerDependencies?: unknown
  type?: unknown
  version?: unknown
}

const allowedBuiltinModuleNames = new Set([
  'node:path',
  'node:path/posix',
  'node:path/win32',
  'path',
  'path/posix',
  'path/win32',
])

const importSpecifierPatterns: RegExp[] = []

const runtimeEscapeNames = new Set([
  '__proto__',
  'Bun',
  'constructor',
  'eval',
  'fetch',
  'Function',
  'getBuiltinModule',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'global',
  'globalThis',
  'Object',
  'process',
  'prototype',
  'Reflect',
  'require',
  'WebSocket',
  'Worker',
])

interface ReadIdentifierResult {
  endIndex: number
  value: string
}

interface ScanTemplateComputedMemberAccessResult {
  endIndex: number
  hasComputedMemberAccess: boolean
}

export async function verifyExtractedPluginPackage(
  packageDir: string,
  options: VerifyExtractedPluginPackageOptions,
): Promise<VerifiedPluginPackage> {
  const root = resolve(packageDir)
  const canonicalRoot = await realpath(root)
  const packageJson = await readPackageJson(root)

  if (packageJson.name !== options.expectedName || packageJson.version !== options.expectedVersion) {
    throw new Error(`Plugin package identity mismatch: expected ${options.expectedName}@${options.expectedVersion}.`)
  }

  assertNoDeclaredDependencies(packageJson, options.expectedName, options.expectedVersion)

  if (packageJson.alint?.apiVersion !== options.supportedApiVersion) {
    throw new Error(`Plugin package ${options.expectedName}@${options.expectedVersion} declares alint apiVersion "${String(packageJson.alint?.apiVersion)}", but this alint binary supports "${options.supportedApiVersion}".`)
  }

  const entrySpecifier = resolvePluginPackageEntry(packageJson, options.expectedName, options.expectedVersion)
  assertSafeLocalImportSpecifier(entrySpecifier)
  const entry = isAbsolute(entrySpecifier)
    ? resolve(entrySpecifier)
    : resolveInside(root, entrySpecifier, 'entry')
  assertEsmEntry(entry, packageJson)
  const canonicalEntry = await assertFileExists(entry, 'entry', root)
  await assertNoExternalImports(canonicalEntry, canonicalRoot, packageJson)

  return {
    apiVersion: options.supportedApiVersion,
    entry: canonicalEntry,
    name: options.expectedName,
    version: options.expectedVersion,
  }
}

function assertEsmEntry(entry: string, packageJson: PluginPackageJson): void {
  const extension = extname(entry)

  if (extension === '.mjs') {
    return
  }

  if (extension === '.js' && packageJson.type === 'module') {
    return
  }

  throw new Error('Plugin package entry must be an ESM .mjs file or a .js file in a module package.')
}

async function assertFileExists(path: string, label: string, root?: string): Promise<string> {
  let stats

  try {
    stats = await stat(path)
  }
  catch {
    throw new Error(`Plugin package ${label} does not exist.`)
  }

  if (!stats.isFile()) {
    throw new Error(`Plugin package ${label} is not a file.`)
  }

  if (root !== undefined) {
    const rootLocation = await realpath(root)
    const fileLocation = await realpath(path)
    const relativeLocation = relative(rootLocation, fileLocation)

    if (isPathOutside(relativeLocation)) {
      throw new Error(`Plugin package ${label} escapes package root.`)
    }

    return fileLocation
  }

  return await realpath(path)
}

function assertNoDeclaredDependencies(packageJson: PluginPackageJson, expectedName: string, expectedVersion: string): void {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const value = packageJson[field]

    if (hasDependencyDeclaration(value)) {
      throw new Error(`Plugin package ${expectedName}@${expectedVersion} declares ${field}, but static plugin artifacts must be self-contained.`)
    }
  }

  for (const field of ['bundleDependencies', 'bundledDependencies'] as const) {
    if (packageJson[field] !== undefined && packageJson[field] !== false) {
      throw new Error(`Plugin package ${expectedName}@${expectedVersion} declares ${field}, but static plugin artifacts must be self-contained.`)
    }
  }
}

async function assertNoExternalImports(entry: string, packageDir: string, packageJson: PluginPackageJson): Promise<void> {
  await scanPackageLocalImports(entry, packageDir, packageJson, new Set())
}

function assertNoRuntimeEscapeAccess(source: string, modulePath: string, packageDir: string): void {
  for (const identifier of runtimeEscapeNames) {
    if (identifier === 'constructor') {
      if (hasUnsafeConstructorIdentifier(source)) {
        throw new Error(`Plugin package entry ${relative(packageDir, modulePath)} accesses runtime escape "${identifier}".`)
      }

      continue
    }

    if (hasIdentifier(source, identifier)) {
      throw new Error(`Plugin package entry ${relative(packageDir, modulePath)} accesses runtime escape "${identifier}".`)
    }
  }

  for (const stringKey of readStringLiteralPropertyNames(source)) {
    if (runtimeEscapeNames.has(stringKey)) {
      throw new Error(`Plugin package entry ${relative(packageDir, modulePath)} accesses runtime escape "${stringKey}".`)
    }
  }

  if (hasComputedMemberAccess(source)) {
    throw new Error(`Plugin package entry ${relative(packageDir, modulePath)} uses computed member access.`)
  }
}

function assertSafeLocalImportSpecifier(specifier: string): void {
  if (specifier.includes('\\')) {
    throw new Error(`Plugin package import "${specifier}" uses string escape sequences.`)
  }

  if (specifier.includes('%')) {
    throw new Error(`Plugin package import "${specifier}" uses URL percent encoding.`)
  }
}

function findClosingParen(source: string, openIndex: number): number {
  let quote: string | undefined

  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (quote !== undefined) {
      if (character === '\\') {
        index += 1
        continue
      }

      if (character === quote) {
        quote = undefined
      }

      continue
    }

    if (character === '/' && nextCharacter === '/') {
      const newlineIndex = findLineTerminator(source, index + 2, source.length)
      index = newlineIndex === -1 ? source.length : newlineIndex
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      const commentEndIndex = source.indexOf('*/', index + 2)
      index = commentEndIndex === -1 ? source.length : commentEndIndex + 1
      continue
    }

    if (character === '"' || character === '\'') {
      quote = character
      continue
    }

    if (character === '`') {
      index = skipTemplateLiteral(source, index, source.length) - 1
      continue
    }

    if (character === ')') {
      return index
    }
  }

  return -1
}

function findLineTerminator(source: string, startIndex: number, endIndex: number): number {
  for (let index = startIndex; index < endIndex; index += 1) {
    const character = source[index]

    if (character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029') {
      return index
    }
  }

  return -1
}

function findOpeningBrace(source: string, closeIndex: number): number {
  let depth = 1

  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    index = skipBackwardTrivia(source, index, 0)
    const character = source[index]

    if (character === undefined) {
      return -1
    }

    if (character === '"' || character === '\'') {
      const quoteIndex = findOpeningQuote(source, index, character)

      if (quoteIndex === -1) {
        return -1
      }

      index = quoteIndex
      continue
    }

    if (character === '}' || character === ']') {
      depth += 1
      continue
    }

    if (character === '{' || character === '[') {
      depth -= 1

      if (depth === 0) {
        return character === '{' ? index : -1
      }
    }
  }

  return -1
}

function findOpeningQuote(source: string, closeIndex: number, quote: string): number {
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    if (source[index] !== quote) {
      continue
    }

    let backslashCount = 0

    for (let slashIndex = index - 1; source[slashIndex] === '\\'; slashIndex -= 1) {
      backslashCount += 1
    }

    if (backslashCount % 2 === 0) {
      return index
    }
  }

  return -1
}

function findPreviousLineTerminator(source: string, startIndex: number): number {
  for (let index = startIndex; index >= 0; index -= 1) {
    const character = source[index]

    if (character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029') {
      return index
    }
  }

  return -1
}

function findTemplateExpressionEnd(source: string, startIndex: number, endIndex: number): number {
  let depth = 1
  let index = startIndex

  while (index < endIndex) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (character === '/' && nextCharacter === '/') {
      const newlineIndex = findLineTerminator(source, index + 2, endIndex)
      index = newlineIndex === -1 ? endIndex : newlineIndex + 1
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      const commentEndIndex = source.indexOf('*/', index + 2)
      index = commentEndIndex === -1 ? endIndex : commentEndIndex + 2
      continue
    }

    if (character === '"' || character === '\'') {
      index = skipQuotedText(source, index, character)
      continue
    }

    if (character === '/' && isRegexLiteralStart(source, index, startIndex)) {
      index = skipRegexLiteral(source, index, endIndex)
      continue
    }

    if (character === '`') {
      index = skipTemplateLiteral(source, index, endIndex)
      continue
    }

    if (character === '{') {
      depth += 1
      index += 1
      continue
    }

    if (character === '}') {
      depth -= 1

      if (depth === 0) {
        return index
      }
    }

    index += 1
  }

  return -1
}

function hasComputedMemberAccess(source: string): boolean {
  return scanCodeComputedMemberAccess(source, 0, source.length)
}

function hasDependencyDeclaration(value: unknown): boolean {
  if (value === undefined) {
    return false
  }

  if (typeof value !== 'object' || value === null) {
    return true
  }

  if (Array.isArray(value)) {
    return true
  }

  return Object.keys(value).length > 0
}

function hasIdentifier(source: string, identifier: string): boolean {
  return readIdentifierIndexes(source, identifier).length > 0
}

function hasUnsafeConstructorIdentifier(source: string): boolean {
  for (const constructorIndex of readIdentifierIndexes(source, 'constructor')) {
    const previousIndex = skipBackwardTrivia(source, constructorIndex - 1, 0)
    const previousCharacter = source[previousIndex]
    const nextIndex = skipTrivia(source, constructorIndex + 'constructor'.length)
    const nextCharacter = source[nextIndex]

    if (nextCharacter === '(' && (previousCharacter === '{' || previousCharacter === ',')) {
      continue
    }

    return true
  }

  return false
}

function isBuiltinImport(specifier: string): boolean {
  return allowedBuiltinModuleNames.has(specifier)
}

function isCallKeywordContext(source: string, calleeIndex: number): boolean {
  const previousIndex = skipBackwardTrivia(source, calleeIndex - 1, 0)
  const previousCharacter = source[previousIndex]

  if (previousCharacter === '.' || previousCharacter === '?' || previousCharacter === '"' || previousCharacter === '\'' || previousCharacter === '`') {
    return false
  }

  return true
}

function isComputedMemberAccess(
  source: string,
  openBracketIndex: number,
  startIndex: number,
  nearestOpenContainer: string | undefined,
): boolean {
  const index = skipBackwardTrivia(source, openBracketIndex - 1, startIndex)
  const character = source[index]

  if (character === undefined) {
    return false
  }

  if (character === '{') {
    return true
  }

  if (character === '.' && source[index - 1] === '?') {
    return true
  }

  if (character === ')' || character === ']' || character === '}') {
    return true
  }

  if (isIdentifierPart(character) || isLowSurrogate(character)) {
    const identifier = readPreviousIdentifier(source, index)

    return !['const', 'export', 'for', 'function', 'import', 'let', 'return', 'var', 'yield'].includes(identifier.value)
  }

  if (character === ',') {
    return nearestOpenContainer === '{'
  }

  return !'([{=,:;!&|?+-*%^~<>'.includes(character)
}

function isDeclarationFrom(source: string, fromIndex: number): boolean {
  let index = fromIndex - 1

  while (index >= 0) {
    index = skipBackwardTrivia(source, index, 0)
    const character = source[index]

    if (character === undefined || character === ';' || character === '=' || character === '(' || character === ')') {
      return false
    }

    if (isIdentifierPart(character) || isLowSurrogate(character)) {
      const identifier = readPreviousIdentifier(source, index)

      if (identifier.value === 'export' || identifier.value === 'import') {
        return true
      }

      if (['const', 'function', 'let', 'return', 'throw', 'var'].includes(identifier.value)) {
        return false
      }

      index -= identifier.value.length
      continue
    }

    if (character === '}') {
      const openBraceIndex = findOpeningBrace(source, index)

      if (openBraceIndex === -1) {
        return false
      }

      index = openBraceIndex - 1
      continue
    }

    if (character === '*' || character === ',' || character === '\n' || character === '\r') {
      index -= 1
      continue
    }

    return false
  }

  return false
}

function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[$\p{ID_Continue}]/u.test(value)
}

function isLowSurrogate(value: string | undefined): boolean {
  if (value === undefined) {
    return false
  }

  const code = value.charCodeAt(0)

  return code >= 0xDC00 && code <= 0xDFFF
}

function isPathOutside(location: string): boolean {
  return location === '' || location === '..' || location.startsWith('../') || isAbsolute(location)
}

function isRegexLiteralStart(source: string, slashIndex: number, startIndex: number): boolean {
  const index = skipBackwardTrivia(source, slashIndex - 1, startIndex)
  const character = source[index]

  if (character === undefined) {
    return true
  }

  if (isIdentifierPart(character)) {
    const identifier = readPreviousIdentifier(source, index)

    return ['case', 'delete', 'in', 'instanceof', 'return', 'throw', 'typeof', 'void', 'yield'].includes(identifier.value)
  }

  if ((character === '+' || character === '-') && source[index - 1] === character) {
    return false
  }

  return '([{=,:;!&|?+-*%^~<>'.includes(character)
}

function isStringLiteralPropertyName(source: string, afterStringIndex: number): boolean {
  const index = skipTrivia(source, afterStringIndex)
  const character = source[index]

  if (character === ':') {
    return true
  }

  return false
}

function readCallSpecifiers(
  source: string,
  modulePath: string,
  packageDir: string,
  callee: 'getBuiltinModule' | 'import' | 'require',
  errorLabel: string,
): string[] {
  const specifiers: string[] = []

  for (const calleeIndex of readIdentifierIndexes(source, callee)) {
    if (!isCallKeywordContext(source, calleeIndex)) {
      continue
    }

    const openIndex = skipTrivia(source, calleeIndex + callee.length)

    if (source[openIndex] !== '(') {
      continue
    }

    const closeIndex = findClosingParen(source, openIndex)

    if (closeIndex === -1) {
      throw new Error(`Plugin package entry ${relative(packageDir, modulePath)} uses ${errorLabel}.`)
    }

    const specifier = readStringLiteralArgument(source.slice(openIndex + 1, closeIndex))

    if (specifier === undefined) {
      throw new Error(`Plugin package entry ${relative(packageDir, modulePath)} uses ${errorLabel}.`)
    }

    specifiers.push(specifier)
  }

  return specifiers
}

function readDynamicImportSpecifiers(source: string, modulePath: string, packageDir: string): string[] {
  return readCallSpecifiers(source, modulePath, packageDir, 'import', 'computed dynamic import')
}

function readEscapedIdentifierCharacter(source: string, startIndex: number): ReadIdentifierResult | undefined {
  if (!source.startsWith('\\u', startIndex)) {
    return undefined
  }

  if (source[startIndex + 2] === '{') {
    const closeIndex = source.indexOf('}', startIndex + 3)

    if (closeIndex === -1) {
      return undefined
    }

    const codePoint = Number.parseInt(source.slice(startIndex + 3, closeIndex), 16)

    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
      return undefined
    }

    return {
      endIndex: closeIndex + 1,
      value: String.fromCodePoint(codePoint),
    }
  }

  const hex = source.slice(startIndex + 2, startIndex + 6)

  if (!/^[\da-f]{4}$/i.test(hex)) {
    return undefined
  }

  return {
    endIndex: startIndex + 6,
    value: String.fromCodePoint(Number.parseInt(hex, 16)),
  }
}

function readFromSpecifiers(source: string): string[] {
  const specifiers: string[] = []

  for (const fromIndex of readIdentifierIndexes(source, 'from')) {
    if (!isDeclarationFrom(source, fromIndex)) {
      continue
    }

    const specifier = readQuotedSpecifier(source, fromIndex + 'from'.length)

    if (specifier !== undefined) {
      specifiers.push(specifier)
    }
  }

  return specifiers
}

function readIdentifier(source: string, startIndex: number): ReadIdentifierResult {
  let index = startIndex
  let value = ''

  while (index < source.length) {
    const escapedCharacter = readEscapedIdentifierCharacter(source, index)

    if (escapedCharacter !== undefined) {
      value += escapedCharacter.value
      index = escapedCharacter.endIndex
      continue
    }

    if (!isIdentifierPart(source[index])) {
      break
    }

    value += source[index]
    index += 1
  }

  return {
    endIndex: index,
    value,
  }
}

function readIdentifierIndexes(source: string, identifier: string): number[] {
  const indexes: number[] = []
  scanCodeIdentifierIndexes(source, 0, source.length, identifier, indexes)

  return indexes
}

function readImportSpecifiers(source: string, modulePath: string, packageDir: string): string[] {
  const specifiers = importSpecifierPatterns.flatMap((pattern) => {
    pattern.lastIndex = 0
    return Array.from(source.matchAll(pattern), match => match[2]).filter(specifier => specifier !== undefined)
  })

  specifiers.push(...readDynamicImportSpecifiers(source, modulePath, packageDir))
  specifiers.push(...readFromSpecifiers(source))
  specifiers.push(...readRequireSpecifiers(source, modulePath, packageDir))
  specifiers.push(...readSideEffectImportSpecifiers(source))

  return specifiers
}

async function readPackageJson(packageDir: string): Promise<PluginPackageJson> {
  const packageJsonPath = resolve(packageDir, 'package.json')

  try {
    return JSON.parse(await readFile(packageJsonPath, 'utf8')) as PluginPackageJson
  }
  catch {
    throw new Error('Plugin package must include a readable package.json.')
  }
}

function readPreviousIdentifier(source: string, endIndex: number): ReadIdentifierResult {
  let index = isLowSurrogate(source[endIndex]) && endIndex > 0 ? endIndex - 1 : endIndex

  while (index >= 0 && isIdentifierPart(source[index])) {
    index -= 1
  }

  return {
    endIndex: endIndex + 1,
    value: source.slice(index + 1, endIndex + 1),
  }
}

function readQuotedSpecifier(source: string, startIndex: number): string | undefined {
  const quoteIndex = skipTrivia(source, startIndex)
  const quote = source[quoteIndex]

  if (quote !== '"' && quote !== '\'') {
    return undefined
  }

  const endQuoteIndex = source.indexOf(quote, quoteIndex + 1)

  if (endQuoteIndex === -1) {
    return undefined
  }

  return source.slice(quoteIndex + 1, endQuoteIndex)
}

function readRequireSpecifiers(source: string, modulePath: string, packageDir: string): string[] {
  return readCallSpecifiers(source, modulePath, packageDir, 'require', 'computed require')
}

function readSideEffectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []

  for (const importIndex of readIdentifierIndexes(source, 'import')) {
    const specifier = readQuotedSpecifier(source, importIndex + 'import'.length)

    if (specifier !== undefined) {
      specifiers.push(specifier)
    }
  }

  return specifiers
}

function readStringLiteralArgument(argument: string): string | undefined {
  const argumentIndex = skipTrivia(argument, 0)
  const endIndex = skipBackwardTrivia(argument, argument.length - 1, argumentIndex)
  const trimmed = argument.slice(argumentIndex, endIndex + 1).trim()
  const quote = trimmed[0]

  if ((quote !== '"' && quote !== '\'') || trimmed.at(-1) !== quote) {
    return undefined
  }

  const value = trimmed.slice(1, -1)

  if (value.includes(quote) || value.includes('\\')) {
    return undefined
  }

  return value
}

function readStringLiteralPropertyNames(source: string): string[] {
  const names: string[] = []

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (character === '/' && nextCharacter === '/') {
      const newlineIndex = findLineTerminator(source, index + 2, source.length)
      index = newlineIndex === -1 ? source.length : newlineIndex
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      const commentEndIndex = source.indexOf('*/', index + 2)
      index = commentEndIndex === -1 ? source.length : commentEndIndex + 1
      continue
    }

    if (character === '/' && isRegexLiteralStart(source, index, 0)) {
      index = skipRegexLiteral(source, index, source.length) - 1
      continue
    }

    if (character === '`') {
      index = skipTemplateLiteral(source, index, source.length) - 1
      continue
    }

    const quote = source[index]

    if (quote !== '"' && quote !== '\'') {
      continue
    }

    const endIndex = skipQuotedText(source, index, quote) - 1

    if (endIndex <= index || endIndex >= source.length) {
      break
    }

    const value = readStringLiteralValue(source.slice(index + 1, endIndex))

    if (value !== undefined && isStringLiteralPropertyName(source, endIndex + 1)) {
      names.push(value)
    }

    index = endIndex
  }

  return names
}

function readStringLiteralValue(raw: string): string | undefined {
  let value = ''

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]

    if (character !== '\\') {
      value += character
      continue
    }

    const nextCharacter = raw[index + 1]

    if (nextCharacter === undefined) {
      return undefined
    }

    if (nextCharacter === '\r' || nextCharacter === '\n' || nextCharacter === '\u2028' || nextCharacter === '\u2029') {
      if (nextCharacter === '\r' && raw[index + 2] === '\n') {
        index += 2
        continue
      }

      index += 1
      continue
    }

    if (nextCharacter === 'u' && raw[index + 2] === '{') {
      const closeIndex = raw.indexOf('}', index + 3)

      if (closeIndex === -1) {
        return undefined
      }

      const codePoint = Number.parseInt(raw.slice(index + 3, closeIndex), 16)

      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
        return undefined
      }

      value += String.fromCodePoint(codePoint)
      index = closeIndex
      continue
    }

    if (nextCharacter === 'u') {
      const hex = raw.slice(index + 2, index + 6)

      if (!/^[\da-f]{4}$/i.test(hex)) {
        return undefined
      }

      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 5
      continue
    }

    if (nextCharacter === 'x') {
      const hex = raw.slice(index + 2, index + 4)

      if (!/^[\da-f]{2}$/i.test(hex)) {
        return undefined
      }

      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 3
      continue
    }

    value += nextCharacter
    index += 1
  }

  return value
}

function resolveInside(root: string, path: string, label: string): string {
  const resolved = isAbsolute(path)
    ? resolve(path)
    : resolve(root, path)
  const location = relative(resolve(root), resolved)

  if (isPathOutside(location)) {
    throw new Error(`Plugin package ${label} escapes package root.`)
  }

  return resolved
}

function resolvePluginPackageEntry(
  packageJson: PluginPackageJson,
  expectedName: string,
  expectedVersion: string,
): string {
  let entries

  try {
    entries = resolvePackageExport(packageJson, '.', {
      browser: false,
      require: false,
    })
  }
  catch (error) {
    throw new Error(`Plugin package ${expectedName}@${expectedVersion} must export an ESM entry at ".".`, {
      cause: error,
    })
  }

  const entry = entries?.[0]

  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error(`Plugin package ${expectedName}@${expectedVersion} must export an ESM entry at ".".`)
  }

  return entry
}

function scanCodeComputedMemberAccess(source: string, startIndex: number, endIndex: number): boolean {
  let index = startIndex
  const containerStack: string[] = []

  while (index < endIndex) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (character === '/' && nextCharacter === '/') {
      const newlineIndex = findLineTerminator(source, index + 2, endIndex)
      index = newlineIndex === -1 ? source.length : newlineIndex + 1
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      const commentEndIndex = source.indexOf('*/', index + 2)
      index = commentEndIndex === -1 ? source.length : commentEndIndex + 2
      continue
    }

    if (character === '/' && isRegexLiteralStart(source, index, startIndex)) {
      index = skipRegexLiteral(source, index, endIndex)
      continue
    }

    if (character === '"' || character === '\'') {
      index = skipQuotedText(source, index, character)
      continue
    }

    if (character === '`') {
      const templateResult = scanTemplateComputedMemberAccess(source, index, endIndex)

      if (templateResult.hasComputedMemberAccess) {
        return true
      }

      index = templateResult.endIndex
      continue
    }

    if (character === '[') {
      if (isComputedMemberAccess(source, index, startIndex, containerStack.at(-1))) {
        return true
      }

      containerStack.push(character)
      index += 1
      continue
    }

    if (character === '(' || character === '{') {
      containerStack.push(character)
      index += 1
      continue
    }

    if (character === ')' || character === ']' || character === '}') {
      containerStack.pop()
      index += 1
      continue
    }

    index += 1
  }

  return false
}

function scanCodeIdentifierIndexes(
  source: string,
  startIndex: number,
  endIndex: number,
  identifier: string,
  indexes: number[],
): void {
  let index = startIndex

  while (index < endIndex) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (character === '/' && nextCharacter === '/') {
      const newlineIndex = findLineTerminator(source, index + 2, endIndex)
      index = newlineIndex === -1 ? source.length : newlineIndex + 1
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      const commentEndIndex = source.indexOf('*/', index + 2)
      index = commentEndIndex === -1 ? source.length : commentEndIndex + 2
      continue
    }

    if (character === '/' && isRegexLiteralStart(source, index, startIndex)) {
      index = skipRegexLiteral(source, index, endIndex)
      continue
    }

    if (character === '"' || character === '\'') {
      index = skipQuotedText(source, index, character)
      continue
    }

    if (character === '`') {
      index = scanTemplateIdentifierIndexes(source, index, endIndex, identifier, indexes)
      continue
    }

    if (!isIdentifierPart(character) && !source.startsWith('\\u', index)) {
      index += 1
      continue
    }

    const currentIdentifier = readIdentifier(source, index)

    if (currentIdentifier.endIndex === index) {
      index += 1
      continue
    }

    if (currentIdentifier.value === identifier) {
      indexes.push(index)
    }

    index = currentIdentifier.endIndex
  }
}

async function scanPackageLocalImports(
  modulePath: string,
  packageDir: string,
  packageJson: PluginPackageJson,
  visited: Set<string>,
): Promise<void> {
  if (visited.has(modulePath)) {
    return
  }

  visited.add(modulePath)

  const source = await readFile(modulePath, 'utf8')
  assertNoRuntimeEscapeAccess(source, modulePath, packageDir)

  for (const specifier of readImportSpecifiers(source, modulePath, packageDir)) {
    if (isBuiltinImport(specifier)) {
      continue
    }

    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      assertSafeLocalImportSpecifier(specifier)

      const importedPath = isAbsolute(specifier)
        ? resolve(specifier)
        : resolveInside(packageDir, resolve(dirname(modulePath), specifier), `import "${specifier}"`)

      assertEsmEntry(importedPath, packageJson)
      const canonicalImportedPath = await assertFileExists(importedPath, `import "${specifier}"`, packageDir)
      await scanPackageLocalImports(canonicalImportedPath, packageDir, packageJson, visited)
      continue
    }

    throw new Error(`Plugin package entry ${relative(packageDir, modulePath)} imports external package "${specifier}".`)
  }
}

function scanTemplateComputedMemberAccess(
  source: string,
  startIndex: number,
  endIndex: number,
): ScanTemplateComputedMemberAccessResult {
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (character === '\\') {
      index += 1
      continue
    }

    if (character === '$' && nextCharacter === '{') {
      const expressionStartIndex = index + 2
      const expressionEndIndex = findTemplateExpressionEnd(source, expressionStartIndex, endIndex)

      if (expressionEndIndex === -1) {
        return {
          endIndex,
          hasComputedMemberAccess: false,
        }
      }

      if (scanCodeComputedMemberAccess(source, expressionStartIndex, expressionEndIndex)) {
        return {
          endIndex: expressionEndIndex,
          hasComputedMemberAccess: true,
        }
      }

      index = expressionEndIndex
      continue
    }

    if (character === '`') {
      return {
        endIndex: index + 1,
        hasComputedMemberAccess: false,
      }
    }
  }

  return {
    endIndex,
    hasComputedMemberAccess: false,
  }
}

function scanTemplateIdentifierIndexes(
  source: string,
  startIndex: number,
  endIndex: number,
  identifier: string,
  indexes: number[],
): number {
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (character === '\\') {
      index += 1
      continue
    }

    if (character === '$' && nextCharacter === '{') {
      const expressionStartIndex = index + 2
      const expressionEndIndex = findTemplateExpressionEnd(source, expressionStartIndex, endIndex)

      if (expressionEndIndex === -1) {
        return endIndex
      }

      scanCodeIdentifierIndexes(source, expressionStartIndex, expressionEndIndex, identifier, indexes)
      index = expressionEndIndex
      continue
    }

    if (character === '`') {
      return index + 1
    }
  }

  return endIndex
}

function skipBackwardTrivia(source: string, startIndex: number, endIndex: number): number {
  let index = startIndex

  while (index >= endIndex) {
    while (index >= endIndex && /\s/.test(source[index] ?? '')) {
      index -= 1
    }

    if (index < endIndex) {
      return index
    }

    if (source[index] === '/' && source[index - 1] === '*') {
      const commentStartIndex = source.lastIndexOf('/*', index - 2)

      if (commentStartIndex < endIndex) {
        return index
      }

      index = commentStartIndex - 1
      continue
    }

    const lineStartIndex = findPreviousLineTerminator(source, index)
    const lineCommentIndex = source.lastIndexOf('//', index)

    if (
      lineCommentIndex > lineStartIndex
      && lineCommentIndex >= endIndex
      && source[lineCommentIndex - 1] !== '"'
      && source[lineCommentIndex - 1] !== '\''
      && source[lineCommentIndex - 1] !== '`'
    ) {
      index = lineCommentIndex - 1
      continue
    }

    return index
  }

  return index
}

function skipQuotedText(source: string, startIndex: number, quote: string): number {
  for (let index = startIndex + 1; index < source.length; index += 1) {
    const character = source[index]

    if (character === '\\') {
      index += 1
      continue
    }

    if (character === quote) {
      return index + 1
    }
  }

  return source.length
}

function skipRegexCharacterClass(source: string, startIndex: number, endIndex: number): number {
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const character = source[index]

    if (character === '\\') {
      index += 1
      continue
    }

    if (character === ']') {
      return index + 1
    }
  }

  return endIndex
}

function skipRegexLiteral(source: string, startIndex: number, endIndex: number): number {
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const character = source[index]

    if (character === '\\') {
      index += 1
      continue
    }

    if (character === '[') {
      const classEndIndex = skipRegexCharacterClass(source, index, endIndex)
      index = classEndIndex - 1
      continue
    }

    if (character === '/') {
      return index + 1
    }

    if (character === '\n' || character === '\r') {
      return startIndex + 1
    }
  }

  return startIndex + 1
}

function skipTemplateLiteral(source: string, startIndex: number, endIndex: number): number {
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (character === '\\') {
      index += 1
      continue
    }

    if (character === '$' && nextCharacter === '{') {
      const expressionEndIndex = findTemplateExpressionEnd(source, index + 2, endIndex)

      if (expressionEndIndex === -1) {
        return endIndex
      }

      index = expressionEndIndex
      continue
    }

    if (character === '`') {
      return index + 1
    }
  }

  return endIndex
}

function skipTrivia(source: string, startIndex: number): number {
  let index = skipWhitespace(source, startIndex)

  while (source.startsWith('/*', index) || source.startsWith('//', index)) {
    if (source.startsWith('//', index)) {
      const newlineIndex = findLineTerminator(source, index + 2, source.length)

      if (newlineIndex === -1) {
        return source.length
      }

      index = skipWhitespace(source, newlineIndex + 1)
      continue
    }

    const blockCommentEndIndex = source.indexOf('*/', index + 2)

    if (blockCommentEndIndex === -1) {
      return index
    }

    index = skipWhitespace(source, blockCommentEndIndex + 2)
  }

  return index
}

function skipWhitespace(source: string, startIndex: number): number {
  let index = startIndex

  while (/\s/.test(source[index] ?? '')) {
    index += 1
  }

  return index
}
