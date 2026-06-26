import { describe, expect, it } from 'vitest'

import { extractJsSourceUnits } from './js'
import { createSourceFile, createSourceRuntime, sliceLines } from './runtime'

describe('js source units', () => {
  it('extracts functions and classes with source text', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'export class Service {',
      '  run() {',
      '    return 1',
      '  }',
      '}',
      '',
      'export async function load() {',
      '  return 2',
      '}',
    ].join('\n'))

    const units = extractJsSourceUnits(file)

    expect(units.classes.map(unit => unit.name)).toEqual(['Service'])
    expect(units.functions.map(unit => unit.name)).toContain('load')
    expect(units.functions.find(unit => unit.name === 'load')?.async).toBe(true)
  })

  it('slices one-based line ranges', () => {
    const file = createSourceFile('/project/src/demo.ts', 'a\nb\nc\n')
    expect(sliceLines(file, { endLine: 3, startLine: 2 }).text).toBe('b\nc')
  })

  it('returns source text from runtime targets without reading files', () => {
    const runtime = createSourceRuntime()
    const file = createSourceFile('/project/src/demo.ts', 'function load() {}')
    const [unit] = extractJsSourceUnits(file).functions

    expect(runtime.getText(file)).toBe(file.text)
    expect(unit && runtime.getText(unit)).toBe('function load() {}')
  })

  it('slices lines with trailing newline normalization and clamped ranges', () => {
    const file = createSourceFile('/project/src/demo.ts', 'a\r\nb\r\nc\r\n')

    expect(sliceLines(file, { endLine: 4, startLine: 2 }).text).toBe('b\nc\n')
    expect(sliceLines(file, { endLine: 2, startLine: 3 }).text).toBe('b\nc')
    expect(sliceLines(file, { endLine: 20, startLine: -5 }).text).toBe('a\nb\nc\n')
  })

  it('marks named export specifier bindings as exported', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'function f() {',
      '  return 1',
      '}',
      '',
      'export { f }',
    ].join('\n'))

    const units = extractJsSourceUnits(file)

    expect(units.functions.find(unit => unit.name === 'f')?.exported).toBe(true)
  })

  it('marks default identifier exports on their module binding', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'function f() {',
      '  return 1',
      '}',
      '',
      'export default f',
    ].join('\n'))

    const units = extractJsSourceUnits(file)

    expect(units.functions.find(unit => unit.name === 'f')?.exported).toBe(true)
  })

  it('does not mark shadowed nested functions as exported by name', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'function f() {}',
      'function outer() {',
      '  function f() {}',
      '}',
      '',
      'export { f }',
    ].join('\n'))

    const units = extractJsSourceUnits(file)
    const namedFunctions = units.functions.filter(unit => unit.name === 'f')

    expect(namedFunctions.map(unit => unit.exported)).toEqual([true, false])
  })

  it('does not mark local bindings exported by same-name re-exports', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'function f() {}',
      '',
      'export { f } from "./external"',
    ].join('\n'))

    const units = extractJsSourceUnits(file)

    expect(units.functions.find(unit => unit.name === 'f')?.exported).toBe(false)
  })

  it('extracts nested functions inside class methods without duplicating method values', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'class A {',
      '  m() {',
      '    function inner() {}',
      '  }',
      '}',
    ].join('\n'))

    const units = extractJsSourceUnits(file)

    expect(units.functions.map(unit => unit.name)).toEqual(['m', 'inner'])
  })

  it('infers object method names and async flags', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'const obj = {',
      '  m() {},',
      '  async n() {},',
      '}',
    ].join('\n'))

    const units = extractJsSourceUnits(file)

    expect(units.functions.map(unit => unit.name)).toEqual(['m', 'n'])
    expect(units.functions.find(unit => unit.name === 'n')?.async).toBe(true)
  })
})
