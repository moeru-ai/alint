import type { ExtractedFunction } from './types'

import { describe, expect, it } from 'vitest'

import { alphaFingerprint } from '../fingerprint'
import { extractSource } from './extract'
import { resolveExtractLanguage } from './language'

function alphaOf(fn: ExtractedFunction): string {
  return alphaFingerprint(fn.text, fn.commentRanges, fn.identifierRanges, fn.binderNames)
}

describe('extractSource', () => {
  it('captures TypeScript declared functions with their names, ranges and inner tokens', async () => {
    const source = [
      '// module note',
      'function walkFiles(root: string): string[] {',
      '  const entries = readDir(root) // inline note',
      '  return entries',
      '}',
      '',
      'class Walker {',
      '  walk(root: string) {',
      '    return walkFiles(root)',
      '  }',
      '}',
    ].join('\n')

    const { calls, functions } = await extractSource(source, 'typescript')

    expect(functions).toHaveLength(2)

    const [walkFiles, walk] = functions
    expect(walkFiles.name).toBe('walkFiles')
    expect(walkFiles.loc.start.line).toBe(2)
    expect(walkFiles.loc.start.column).toBe(0)
    expect(walkFiles.loc.end.line).toBe(5)
    expect(source.slice(walkFiles.range.start, walkFiles.range.end)).toBe(walkFiles.text)
    expect(walkFiles.text.startsWith('function walkFiles')).toBe(true)
    expect(walkFiles.text.endsWith('}')).toBe(true)

    // The module-level comment sits outside the function, so only the inline one is attributed to it.
    expect(walkFiles.commentRanges).toHaveLength(1)
    const [comment] = walkFiles.commentRanges
    expect(walkFiles.text.slice(comment.start, comment.end)).toBe('// inline note')

    const identifiers = walkFiles.identifierRanges.map(range => walkFiles.text.slice(range.start, range.end))
    expect(identifiers).toStrictEqual(['walkFiles', 'root', 'entries', 'readDir', 'root', 'entries'])

    expect(walk.name).toBe('walk')
    expect(walk.loc.start.line).toBe(8)
    expect(walk.text.startsWith('walk(root: string)')).toBe(true)
    expect(walk.commentRanges).toStrictEqual([])

    expect(calls.map(call => call.name)).toStrictEqual(['readDir', 'walkFiles'])
    expect(source.slice(calls[0].range.start, calls[0].range.end)).toBe('readDir')
  })

  it('captures TSX functions through the tsx grammar', async () => {
    const source = [
      'function Badge(props: BadgeProps) {',
      '  return <span className="badge">{formatLabel(props.label)}</span>',
      '}',
    ].join('\n')

    const { calls, functions } = await extractSource(source, 'tsx')

    expect(functions).toHaveLength(1)
    expect(functions[0].name).toBe('Badge')
    expect(functions[0].loc.start.line).toBe(1)
    expect(calls.map(call => call.name)).toStrictEqual(['formatLabel'])
  })

  it('captures JavaScript functions through the TypeScript grammar', async () => {
    const source = 'function walkFiles(root) {\n  return readDir(root)\n}'

    const { calls, functions } = await extractSource(source, 'javascript')

    expect(functions).toHaveLength(1)
    expect(functions[0].name).toBe('walkFiles')
    expect(calls.map(call => call.name)).toStrictEqual(['readDir'])
  })

  it('captures a named arrow function bound by a variable declarator', async () => {
    const source = [
      'const stringify = (value: unknown): string => String(value)',
      '',
      'const collect = (root: string): number => {',
      '  const entries = readDir(root)',
      '',
      '  return entries.length',
      '}',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    expect(functions).toHaveLength(2)

    const [stringify, collect] = functions
    expect(stringify.name).toBe('stringify')
    expect(stringify.loc.start.line).toBe(1)
    // The span is the declarator, so it starts at the name rather than at `const`.
    expect(stringify.loc.start.column).toBe(6)
    expect(stringify.text).toBe('stringify = (value: unknown): string => String(value)')
    // An expression body counts as one statement.
    expect(stringify.bodyStatements).toBe(1)
    expect(stringify.exported).toBe(false)

    expect(collect.name).toBe('collect')
    expect(collect.bodyStatements).toBe(2)
    expect(collect.binderNames).toContain('collect')
    expect(collect.binderNames).toContain('root')
    expect(collect.binderNames).toContain('entries')
    expect(collect.binderNames).not.toContain('readDir')
  })

  it('captures a function expression bound by a variable declarator', async () => {
    const source = [
      'const load = function (path: string): string {',
      '  return readFile(path)',
      '}',
    ].join('\n')

    const { calls, functions } = await extractSource(source, 'typescript')

    expect(functions).toHaveLength(1)

    const [load] = functions
    expect(load.name).toBe('load')
    expect(load.bodyStatements).toBe(1)
    expect(load.text.startsWith('load = function')).toBe(true)
    expect(load.binderNames).toContain('load')
    expect(load.binderNames).toContain('path')
    expect(calls.map(call => call.name)).toStrictEqual(['readFile'])
  })

  // Covers both query constraints: a value that is not a function, and a name that is not a name.
  it('does not treat a plain value or a destructuring declarator as a function', async () => {
    const source = [
      'const total = 5',
      // The arrow belongs to the object, and the declarator binds a pattern rather than a name.
      'const { stringify } = { stringify: (value: unknown): string => String(value) }',
      'const [first] = handlers',
      'const trim = (text: string): string => text.trim()',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    expect(functions.map(fn => fn.name)).toStrictEqual(['trim'])
  })

  // `export const f = () => {}` leaves the declarator one level deeper than a declared function, so an
  // export check written for `function` alone gets it wrong.
  it('marks an arrow helper exported however the file spells the export', async () => {
    const source = [
      'export const inline = (value: string): string => value.trim()',
      'const hidden = (value: string): string => value.trim()',
      'const listed = (value: string): string => value.trim()',
      'export const first = 1, alongside = (value: string): string => value.trim()',
      'export { listed }',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    const exported = new Map(functions.map(fn => [fn.name, fn.exported]))
    expect(exported.get('inline')).toBe(true)
    expect(exported.get('hidden')).toBe(false)
    expect(exported.get('listed')).toBe(true)
    // Every declarator of an exported statement is exported, not only the first.
    expect(exported.get('alongside')).toBe(true)
  })

  it('gives two arrow twins the same alpha fingerprint', async () => {
    const source = [
      'const trimLines = (text: string): string[] => {',
      '  const lines = text.split(\'\\n\')',
      '',
      '  return lines.map(line => line.trim()).filter(line => line !== \'\')',
      '}',
      '',
      'const cleanRows = (raw: string): string[] => {',
      '  const rows = raw.split(\'\\n\')',
      '',
      '  return rows.map(row => row.trim()).filter(row => row !== \'\')',
      '}',
      '',
      'const shoutRows = (raw: string): string[] => {',
      '  const rows = raw.split(\'\\n\')',
      '',
      '  return rows.map(row => row.toUpperCase()).filter(row => row !== \'\')',
      '}',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    // The arrows inside the bodies are bound by nobody, so they are nobody's helper.
    expect(functions).toHaveLength(3)

    const [trimLines, cleanRows, shoutRows] = functions
    expect(trimLines.binderNames).toStrictEqual(['trimLines', 'text', 'lines', 'line'])
    expect(cleanRows.binderNames).toStrictEqual(['cleanRows', 'raw', 'rows', 'row'])

    expect(alphaOf(trimLines)).toBe(alphaOf(cleanRows))
    // A copy cannot rename what it calls: `shoutRows` calls `toUpperCase` where the twins call `trim`.
    expect(alphaOf(shoutRows)).not.toBe(alphaOf(trimLines))
  })

  // An export list sits nowhere near the function it exports, so `exported` cannot be read off the
  // function node alone.
  it('marks a TypeScript function exported however the file spells the export', async () => {
    const source = [
      'function listed() {}',
      'function aliased() {}',
      'function defaulted() {}',
      'function hidden() {}',
      'export function inline() {}',
      'export { listed }',
      'export { aliased as renamed }',
      'export default defaulted',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    const exported = new Map(functions.map(fn => [fn.name, fn.exported]))
    expect(exported.get('listed')).toBe(true)
    // The alias is what the outside calls it; the local name is still reachable.
    expect(exported.get('aliased')).toBe(true)
    expect(exported.get('defaulted')).toBe(true)
    expect(exported.get('inline')).toBe(true)
    expect(exported.get('hidden')).toBe(false)
  })

  // `export { parse } from './other'` re-exports another module's `parse`; the local one stays private.
  it('does not treat a re-export from another module as exporting the local name', async () => {
    const source = [
      'function parse() {}',
      'export { parse } from \'./other\'',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    expect(functions).toHaveLength(1)
    expect(functions[0].name).toBe('parse')
    expect(functions[0].exported).toBe(false)
  })

  it('captures Rust functions, comments, binders, identifiers and calls', async () => {
    const source = [
      'fn walk_files(root: &Path) -> Vec<PathBuf> {',
      '    // read the directory',
      '    let entries = read_dir(root);',
      '    entries.collect()',
      '}',
    ].join('\n')

    const { calls, functions } = await extractSource(source, 'rust')

    expect(functions).toHaveLength(1)

    const [walkFiles] = functions
    expect(walkFiles.name).toBe('walk_files')
    expect(walkFiles.loc.start.line).toBe(1)
    expect(walkFiles.loc.end.line).toBe(5)
    expect(source.slice(walkFiles.range.start, walkFiles.range.end)).toBe(walkFiles.text)

    expect(walkFiles.commentRanges).toHaveLength(1)
    const [comment] = walkFiles.commentRanges
    expect(walkFiles.text.slice(comment.start, comment.end)).toBe('// read the directory')

    expect(walkFiles.binderNames).toContain('walk_files')
    expect(walkFiles.binderNames).toContain('root')
    expect(walkFiles.binderNames).toContain('entries')
    expect(walkFiles.binderNames).not.toContain('read_dir')

    const identifiers = walkFiles.identifierRanges.map(range => walkFiles.text.slice(range.start, range.end))
    expect(identifiers).toContain('walk_files')
    expect(identifiers).toContain('entries')
    expect(identifiers).toContain('read_dir')
    // A copy cannot rename a type and stay a copy, so `PathBuf` is never renameable.
    expect(identifiers).not.toContain('PathBuf')

    // `collect` is a method call, `read_dir` a plain one; both count as usages.
    expect(calls.map(call => call.name)).toStrictEqual(['read_dir', 'collect'])
  })

  it('captures Go functions, keeping field names out of the renameable set', async () => {
    const source = [
      'func isMissing(err error) bool {',
      '\treturn errors.Is(err, fs.ErrNotExist)',
      '}',
    ].join('\n')

    const { calls, functions } = await extractSource(source, 'go')

    expect(functions).toHaveLength(1)
    expect(functions[0].name).toBe('isMissing')
    expect(functions[0].binderNames).toContain('isMissing')
    expect(functions[0].binderNames).toContain('err')
    expect(functions[0].binderNames).not.toContain('errors')
    expect(calls.map(call => call.name)).toStrictEqual(['Is'])
  })

  // Python is the reason `@anchor` exists: it spells `entry.name` with a plain `identifier`, so without
  // the anchor a parameter named `name` would drag the attribute into the placeholder with it.
  it('captures Python functions, and never treats an attribute as renameable', async () => {
    const source = 'def read(name):\n    return self.name + name'

    const { functions } = await extractSource(source, 'python')

    expect(functions).toHaveLength(1)

    const [read] = functions
    expect(read.name).toBe('read')
    expect(read.binderNames).toContain('name')

    const identifiers = read.identifierRanges.map(range => read.text.slice(range.start, range.end))
    // The parameter and its use, but not the attribute `name` in `self.name`.
    expect(identifiers.filter(text => text === 'name')).toHaveLength(2)
    expect(identifiers).toContain('read')
    expect(identifiers).toContain('self')
  })
})

// A comment is a named child of its block in every grammar here, so an uncounted comment used to take a
// one-line helper to two statements and hide it from `no-needless-helper`.
describe('a comment is not a statement', () => {
  it.each([
    ['typescript', 'function f(e: E): number {\n  return e.name.length\n}', 'function f(e: E): number {\n  // why\n  return e.name.length\n}'],
    ['rust', 'fn f(e: &E) -> usize {\n    e.name.len()\n}', 'fn f(e: &E) -> usize {\n    // why\n    e.name.len()\n}'],
    ['go', 'func f(e E) int {\n\treturn len(e.Name)\n}', 'func f(e E) int {\n\t// why\n\treturn len(e.Name)\n}'],
    ['python', 'def f(e):\n    return len(e.name)', 'def f(e):\n    # why\n    return len(e.name)'],
  ] as const)('does not count a comment in a %s body', async (language, plain, commented) => {
    const bare = await extractSource(plain, language)
    const documented = await extractSource(commented, language)

    expect(bare.functions[0].bodyStatements).toBe(1)
    expect(documented.functions[0].bodyStatements).toBe(1)
  })
})

// A Python docstring is a string statement, not a comment. Treated as code it counts as a statement and
// lands in the fingerprint, so rewording a docstring would break the match.
describe('a Python docstring is documentation, not code', () => {
  it('does not count towards the body\'s statements', async () => {
    const { functions } = await extractSource('def f(e):\n    """Return the length."""\n    return len(e.name)', 'python')

    expect(functions[0].bodyStatements).toBe(1)
  })

  it('leaves the fingerprint of a copy unchanged when its docstring is reworded', async () => {
    const documented = await extractSource('def name_length(entry):\n    """Return the length."""\n    return len(entry.name)', 'python')
    const reworded = await extractSource('def name_len(item):\n    """Says the same thing in other words."""\n    return len(item.name)', 'python')
    const undocumented = await extractSource('def name_length(entry):\n    return len(entry.name)', 'python')

    expect(alphaOf(documented.functions[0])).toBe(alphaOf(reworded.functions[0]))
    expect(alphaOf(documented.functions[0])).toBe(alphaOf(undocumented.functions[0]))
  })

  it('still treats a string that is not the first statement as code', async () => {
    const { functions } = await extractSource('def f(e):\n    x = "not a docstring"\n    return x', 'python')

    expect(functions[0].bodyStatements).toBe(2)
  })
})

// In destructuring one token is both the property read and the local declared. Filing it as a binder
// blinds it, and then two accessors of different properties of the same type hash alike.
describe('a destructured property is not a name the function declares', () => {
  it('keeps two accessors of the same type apart', async () => {
    const source = [
      'function readTitle(doc: Doc): string {',
      '  const { title } = doc',
      '  return title',
      '}',
      'function readAuthor(doc: Doc): string {',
      '  const { author } = doc',
      '  return author',
      '}',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    expect(functions).toHaveLength(2)
    expect(alphaOf(functions[0])).not.toBe(alphaOf(functions[1]))
  })

  it('still matches a genuine renamed copy, which cannot rename the property it reads', async () => {
    const source = [
      'function readTitle(doc: Doc): string {',
      '  const { title } = doc',
      '  return title',
      '}',
      'function getTitle(record: Doc): string {',
      '  const { title } = record',
      '  return title',
      '}',
    ].join('\n')

    const { functions } = await extractSource(source, 'typescript')

    expect(alphaOf(functions[0])).toBe(alphaOf(functions[1]))
  })
})

describe('resolveExtractLanguage', () => {
  it('maps supported extensions', () => {
    expect(resolveExtractLanguage('src/walk.ts')).toBe('typescript')
    expect(resolveExtractLanguage('src/badge.tsx')).toBe('tsx')
    expect(resolveExtractLanguage('src/badge.jsx')).toBe('tsx')
    expect(resolveExtractLanguage('src/walk.js')).toBe('javascript')
    expect(resolveExtractLanguage('src/walk.rs')).toBe('rust')
    expect(resolveExtractLanguage('src/walk.go')).toBe('go')
    expect(resolveExtractLanguage('src/walk.py')).toBe('python')
    expect(resolveExtractLanguage('README.md')).toBeUndefined()
  })
})
