import type { SourceFile, SourceTarget } from '../source/types'

import { describe, expect, it } from 'vitest'

import { createSourceFile } from '../source/runtime'
import { requireLanguage } from './require'

function fileTarget(file: SourceFile, language: string): SourceTarget {
  return {
    file,
    identity: 'file',
    kind: 'file',
    language,
    origin: { physicalPath: file.path },
    text: file.text,
  }
}

describe('requireLanguage', () => {
  it('hands the targets through when a language claimed the file', () => {
    const file = createSourceFile('src/walk.go', 'func Walk() {}')
    const targets = [fileTarget(file, 'go')]

    expect(requireLanguage(file.path, targets)).toBe(targets)
  })

  it('names the extension, the file and the pack when nothing claimed it', () => {
    const file = createSourceFile('src/walk.go', 'func Walk() {}')

    expect(() => requireLanguage(file.path, [fileTarget(file, 'text/plain')]))
      .toThrow(/No language registered for "\.go", so "src\/walk\.go" was extracted as text\/plain\./)
  })

  it('points at the pack and where to put it, not at the mechanism', () => {
    const file = createSourceFile('src/walk.rs', 'fn walk() {}')

    expect(() => requireLanguage(file.path, [fileTarget(file, 'text/plain')]))
      .toThrow(/Install @alint-js\/languages-treesitter and add it to "plugins" in alint config\./)
  })

  it('throws a TypeError, as a missing agent does', () => {
    const file = createSourceFile('src/walk.py', 'def walk(): pass')

    expect(() => requireLanguage(file.path, [fileTarget(file, 'text/plain')])).toThrow(TypeError)
  })

  // Silence is what this guard exists to prevent: a rule finding no functions in a `.go` file reads
  // exactly like a `.go` file with nothing wrong in it.
  it('does not accept a file target alone as proof a language ran', () => {
    const file = createSourceFile('src/walk.go', 'func Walk() {}')

    expect(() => requireLanguage(file.path, [fileTarget(file, 'text/plain')])).toThrow()
  })

  it('says nothing about a file the config ignored, which extracts to nothing at all', () => {
    // Not a missing language: the config excluded the file, so a caller sweeping a tree should skip
    // it rather than fail.
    expect(requireLanguage('vendor/walk.go', [])).toStrictEqual([])
  })

  it('reads the extension off the path, not off the target', () => {
    const file = createSourceFile('/abs/path/to/mod.rs', 'fn walk() {}')

    expect(() => requireLanguage(file.path, [fileTarget(file, 'text/plain')])).toThrow(/for "\.rs"/)
  })
})
