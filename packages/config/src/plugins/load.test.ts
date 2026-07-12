import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createLockedPluginResolver } from './load'
import { writePluginLockFile } from './lock'
import { parsePluginSpecifier } from './spec'

describe('createLockedPluginResolver', () => {
  it('loads a plugin by alias and specifier from the lock file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-'))
    const entry = join(cwd, '.alint', 'plugins', 'store', 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default { rules: {} }\n')
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })

    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).resolves.toEqual({ rules: {} })
  })

  it('rejects missing lock entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-'))
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" requires @alint-js/plugin-python@0.3.1, but no matching lock entry exists.')
  })

  it('loads the lock lazily only when resolving a static plugin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-lazy-'))
    await mkdir(join(cwd, '.alint', 'plugins'), { recursive: true })
    await writeFile(join(cwd, '.alint', 'plugins', 'lock.json'), '{')

    await expect(createLockedPluginResolver(cwd)).resolves.toBeTypeOf('function')
  })

  it('rejects lock entries for a different specifier', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-'))
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.0/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.0',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.0',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" is locked to @alint-js/plugin-python@0.3.0, but config requires @alint-js/plugin-python@0.3.1.')
  })

  it('rejects modules without a plugin object default export', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-'))
    const entry = join(cwd, '.alint', 'plugins', 'store', 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default null\n')
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" default export must be an alint plugin object.')
  })

  it('rejects lock entries outside the plugin store', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-path-'))
    const entry = join(cwd, 'outside.mjs')
    await writeFile(entry, 'export default { rules: {} }\n')
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: 'outside.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry must point inside .alint/plugins/store.')
  })

  it('rejects absolute lock entry paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-absolute-'))
    const entry = join(cwd, 'outside.mjs')
    await writeFile(entry, 'export default { rules: {} }\n')
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry,
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry must point inside .alint/plugins/store.')
  })

  it('rejects traversal lock entry paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-traversal-'))
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/../outside.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry must point inside .alint/plugins/store.')
  })

  it('rejects nested symlink lock entry escapes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-entry-link-'))
    const outside = join(await mkdtemp(join(tmpdir(), 'alint-plugin-load-outside-')), 'index.mjs')
    const entry = join(cwd, '.alint', 'plugins', 'store', 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(outside, 'export default { rules: {} }\n')
    await symlink(outside, entry)
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry must point inside .alint/plugins/store.')
  })

  it('rejects symlinked plugin store roots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-store-link-'))
    const external = await mkdtemp(join(tmpdir(), 'alint-plugin-load-external-'))
    const entry = join(external, 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default { rules: {} }\n')
    await mkdir(join(cwd, '.alint', 'plugins'), { recursive: true })
    await symlink(external, join(cwd, '.alint', 'plugins', 'store'))
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry must point inside .alint/plugins/store.')
  })

  it('rejects symlinked .alint roots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-alint-link-'))
    const external = await mkdtemp(join(tmpdir(), 'alint-plugin-load-external-'))
    const entry = join(external, 'plugins', 'store', 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default { rules: {} }\n')
    await symlink(external, join(cwd, '.alint'))
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry must point inside .alint/plugins/store.')
  })

  it('rejects symlinked .alint/plugins roots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-plugins-link-'))
    const external = await mkdtemp(join(tmpdir(), 'alint-plugin-load-external-'))
    const entry = join(external, 'store', 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default { rules: {} }\n')
    await mkdir(join(cwd, '.alint'), { recursive: true })
    await symlink(external, join(cwd, '.alint', 'plugins'))
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry must point inside .alint/plugins/store.')
  })

  it('reports missing locked entry files with install guidance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-missing-entry-'))
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" lock entry is missing from .alint/plugins/store.\nRun: alint plugin install')
  })

  it('rejects malformed plugin object fields', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-shape-'))
    const entry = join(cwd, '.alint', 'plugins', 'store', 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default { rules: [] }\n')
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" default export must be an alint plugin object.')
  })

  it('rejects array plugin default exports', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-load-array-'))
    const entry = join(cwd, '.alint', 'plugins', 'store', 'python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default []\n')
    await writePluginLockFile(cwd, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    const resolver = await createLockedPluginResolver(cwd)

    await expect(resolver({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).rejects.toThrow('Plugin "python" default export must be an alint plugin object.')
  })
})
