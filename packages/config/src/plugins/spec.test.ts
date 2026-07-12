import { describe, expect, it } from 'vitest'

import { formatPluginSpecifier, parsePluginSpecifier } from './spec'

describe('parsePluginSpecifier', () => {
  it('parses scoped package exact versions', () => {
    expect(parsePluginSpecifier('@alint-js/plugin-python@0.3.1')).toEqual({
      name: '@alint-js/plugin-python',
      packageName: {
        name: '@alint-js/plugin-python',
        registryPath: '@alint-js%2fplugin-python',
        scope: 'alint-js',
        unscopedName: 'plugin-python',
      },
      raw: '@alint-js/plugin-python@0.3.1',
      version: '0.3.1',
    })
  })

  it('parses unscoped package exact versions', () => {
    expect(parsePluginSpecifier('alint-plugin-go@1.2.3')).toEqual({
      name: 'alint-plugin-go',
      packageName: {
        name: 'alint-plugin-go',
        registryPath: 'alint-plugin-go',
        unscopedName: 'alint-plugin-go',
      },
      raw: 'alint-plugin-go@1.2.3',
      version: '1.2.3',
    })
  })

  it('parses exact versions with prerelease and build metadata', () => {
    expect(parsePluginSpecifier('@alint-js/plugin-python@1.2.3-beta.1+build.7')).toEqual({
      name: '@alint-js/plugin-python',
      packageName: {
        name: '@alint-js/plugin-python',
        registryPath: '@alint-js%2fplugin-python',
        scope: 'alint-js',
        unscopedName: 'plugin-python',
      },
      raw: '@alint-js/plugin-python@1.2.3-beta.1+build.7',
      version: '1.2.3-beta.1+build.7',
    })
    expect(parsePluginSpecifier('@alint-js/plugin-python@1.2.3-0A')).toEqual({
      name: '@alint-js/plugin-python',
      packageName: {
        name: '@alint-js/plugin-python',
        registryPath: '@alint-js%2fplugin-python',
        scope: 'alint-js',
        unscopedName: 'plugin-python',
      },
      raw: '@alint-js/plugin-python@1.2.3-0A',
      version: '1.2.3-0A',
    })
  })

  it('rejects missing versions', () => {
    expect(() => parsePluginSpecifier('@alint-js/plugin-python')).toThrow(
      'Static plugin specifier "@alint-js/plugin-python" must include an exact version.',
    )
  })

  it('rejects version ranges', () => {
    expect(() => parsePluginSpecifier('@alint-js/plugin-python@^0.3.1')).toThrow(
      'Static plugin specifier "@alint-js/plugin-python@^0.3.1" must use an exact version.',
    )
  })

  it('rejects package names that can alter registry request URLs', () => {
    for (const name of [
      '../escape',
      '../../escape',
      'foo?bar',
      'foo#bar',
      '@scope/pkg/extra',
      '@scope/',
      'scope/pkg',
    ]) {
      expect(() => parsePluginSpecifier(`${name}@1.2.3`)).toThrow(`Invalid npm package name "${name}".`)
    }
  })

  it('rejects malformed semver versions', () => {
    for (const version of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-alpha..1',
      '1.2.3-alpha.',
      '1.2.3+.build',
      '1.2.3-01',
    ]) {
      const specifier = `@alint-js/plugin-python@${version}`

      expect(() => parsePluginSpecifier(specifier)).toThrow(
        `Static plugin specifier "${specifier}" must use an exact version.`,
      )
    }
  })

  it('formats parsed specifiers', () => {
    expect(formatPluginSpecifier({
      name: '@alint-js/plugin-python',
      packageName: {
        name: '@alint-js/plugin-python',
        registryPath: '@alint-js%2fplugin-python',
        scope: 'alint-js',
        unscopedName: 'plugin-python',
      },
      raw: '@alint-js/plugin-python@0.3.1',
      version: '0.3.1',
    })).toBe('@alint-js/plugin-python@0.3.1')
  })
})
