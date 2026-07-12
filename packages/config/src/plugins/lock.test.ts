import { describe, expect, it } from 'vitest'

import { parsePluginLockFile } from './lock'
import { parsePluginSpecifier } from './spec'

describe('plugin lock parsing', () => {
  it('parses lock entries and finds matching static plugin references', () => {
    const lock = parsePluginLockFile({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    }, { cwd: '/repo' })

    const entry = lock.get({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })

    expect(entry.alias).toBe('python')
    expect(entry.specifier).toEqual(parsePluginSpecifier('@alint-js/plugin-python@0.3.1'))
    expect(entry.lockEntry.entry).toBe('.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs')
  })

  it('reports missing lock entries with install guidance', () => {
    const lock = parsePluginLockFile({ plugins: {}, version: 1 }, { cwd: '/repo' })

    expect(() => lock.get({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).toThrow('Plugin "python" requires @alint-js/plugin-python@0.3.1, but no matching lock entry exists.')
  })

  it('reports lock specifier mismatches with install guidance', () => {
    const lock = parsePluginLockFile({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.0/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.0',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.0',
        },
      },
      version: 1,
    }, { cwd: '/repo' })

    expect(() => lock.get({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).toThrow('Plugin "python" is locked to @alint-js/plugin-python@0.3.0, but config requires @alint-js/plugin-python@0.3.1.')
  })
})
