import { describe, expect, it } from 'vitest'

import { createSourceFile, createSourceRuntime, sliceLines } from '../../source/runtime'
import { extractJsSourceTargets } from './extract'

describe('js source targets', () => {
  it('extracts a file target followed by functions and classes with source text', () => {
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

    const targets = extractJsSourceTargets(file)
    const classes = targets.filter(target => target.kind === 'class')
    const functions = targets.filter(target => target.kind === 'function')
    const load = functions.find(target => target.name === 'load')

    expect(targets[0]).toMatchObject({
      file,
      identity: 'file',
      kind: 'file',
      language: 'typescript',
      origin: { physicalPath: '/project/src/demo.ts' },
      text: file.text,
    })
    expect(classes.map(target => target.name)).toEqual(['Service'])
    expect(functions.map(target => target.name)).toContain('load')
    expect(load?.metadata).toEqual({ async: true, exported: true })
    expect(load?.identity).toBe('function:load')
  })

  it('keeps named target identities stable when unrelated code is inserted above', () => {
    const source = [
      'class Service {}',
      '',
      'function load() {',
      '  return 1',
      '}',
    ].join('\n')
    const shiftedSource = [
      'const unrelated = true',
      '',
      source,
    ].join('\n')

    const targets = extractJsSourceTargets(createSourceFile('/project/src/demo.ts', source))
    const shiftedTargets = extractJsSourceTargets(createSourceFile('/project/src/demo.ts', shiftedSource))

    expect(targets.find(target => target.kind === 'class' && target.name === 'Service')?.identity).toBe('class:Service')
    expect(shiftedTargets.find(target => target.kind === 'class' && target.name === 'Service')?.identity).toBe('class:Service')
    expect(targets.find(target => target.kind === 'function' && target.name === 'load')?.identity).toBe('function:load')
    expect(shiftedTargets.find(target => target.kind === 'function' && target.name === 'load')?.identity).toBe('function:load')
  })

  it('slices one-based line ranges', () => {
    const file = createSourceFile('/project/src/demo.ts', 'a\nb\nc\n')
    expect(sliceLines(file, { endLine: 3, startLine: 2 }).text).toBe('b\nc')
  })

  it('returns source text from runtime targets without reading files', () => {
    const runtime = createSourceRuntime()
    const file = createSourceFile('/project/src/demo.ts', 'function load() {}')
    const target = extractJsSourceTargets(file).find(item => item.kind === 'function')

    expect(runtime.getText(file)).toBe(file.text)
    expect(target && runtime.getText(target)).toBe('function load() {}')
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

    const targets = extractJsSourceTargets(file)

    expect(targets.find(target => target.kind === 'function' && target.name === 'f')?.metadata?.exported).toBe(true)
  })

  it('marks default identifier exports on their module binding', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'function f() {',
      '  return 1',
      '}',
      '',
      'export default f',
    ].join('\n'))

    const targets = extractJsSourceTargets(file)

    expect(targets.find(target => target.kind === 'function' && target.name === 'f')?.metadata?.exported).toBe(true)
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

    const targets = extractJsSourceTargets(file)
    const namedFunctions = targets.filter(target => target.kind === 'function' && target.name === 'f')

    expect(namedFunctions.map(target => target.metadata?.exported)).toEqual([true, false])
  })

  it('does not mark local bindings exported by same-name re-exports', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'function f() {}',
      '',
      'export { f } from "./external"',
    ].join('\n'))

    const targets = extractJsSourceTargets(file)

    expect(targets.find(target => target.kind === 'function' && target.name === 'f')?.metadata?.exported).toBe(false)
  })

  it('extracts nested functions inside class methods without duplicating method values', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'class A {',
      '  m() {',
      '    function inner() {}',
      '  }',
      '}',
    ].join('\n'))

    const targets = extractJsSourceTargets(file)

    expect(targets.filter(target => target.kind === 'function').map(target => target.name)).toEqual(['m', 'inner'])
  })

  it('infers object method names and async flags', () => {
    const file = createSourceFile('/project/src/demo.ts', [
      'const obj = {',
      '  m() {},',
      '  async n() {},',
      '}',
    ].join('\n'))

    const targets = extractJsSourceTargets(file)
    const functions = targets.filter(target => target.kind === 'function')

    expect(functions.map(target => target.name)).toEqual(['m', 'n'])
    expect(functions.find(target => target.name === 'n')?.metadata?.async).toBe(true)
  })
})
