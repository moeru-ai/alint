import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { parsePluginLockFile } from './lock'
import { resolvePluginImportTarget } from './resolve'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alint-plugin-selector-'))
  tempRoots.push(root)
  return root
}

it('dispatches directory entries to the content-cached local resolver', async () => {
  const cwd = await createProject()
  const packageDir = join(cwd, 'plugin')
  await mkdir(join(packageDir, 'dist'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ exports: { '.': './dist/index.mjs' }, name: 'local' }))
  await writeFile(join(packageDir, 'dist', 'index.mjs'), 'export default {}\n')
  const lock = parsePluginLockFile({ plugins: { local: { alias: 'local', path: packageDir, specifier: './plugin', type: 'directory' } }, version: 2 }, { cwd })

  await expect(resolvePluginImportTarget(lock.entries[0]!)).resolves.toEqual({
    cache: 'content',
    entry: join(await realpath(packageDir), 'dist', 'index.mjs'),
  })
})

it('dispatches registry entries to the default-cached package resolver', async () => {
  const cwd = await createProject()
  const packageDir = join(cwd, '.alint', 'plugins', 'store', 'plugin', '1.0.0', 'package')
  await mkdir(join(packageDir, 'dist'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ exports: { '.': './dist/index.mjs' }, name: 'plugin' }))
  await writeFile(join(packageDir, 'dist', 'index.mjs'), 'export default {}\n')
  const entry = '.alint/plugins/store/plugin/1.0.0/package/dist/index.mjs'
  const lock = parsePluginLockFile({ plugins: { plugin: { alias: 'plugin', entry, integrity: 'sha512-test', name: 'plugin', registry: 'https://registry.npmjs.org/', specifier: 'plugin@1.0.0', tarball: 'https://registry.npmjs.org/plugin.tgz', type: 'registry', version: '1.0.0' } }, version: 2 }, { cwd })

  await expect(resolvePluginImportTarget(lock.entries[0]!)).resolves.toEqual({
    cache: 'default',
    entry: join(packageDir, 'dist', 'index.mjs'),
  })
})
