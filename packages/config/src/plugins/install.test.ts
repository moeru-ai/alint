import type { AddressInfo } from 'node:net'

import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzip } from 'node:zlib'

import tar from 'tar-stream'

import { afterEach, describe, expect, it } from 'vitest'

import { installStaticPlugins } from './install'

interface RegistryServer {
  close: () => Promise<void>
  metadataRequests: () => number
  registry: string
  tarballRequests: () => number
}

describe('static plugin installation', () => {
  const tempRoots: string[] = []
  const servers: RegistryServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  async function createProject(config: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-install-'))
    tempRoots.push(root)
    await writeFile(join(root, 'alint.config.ts'), config, 'utf8')
    return root
  }

  async function createTarball(entries: Record<string, string>): Promise<Buffer> {
    const pack = tar.pack()
    const chunks: Buffer[] = []

    pack.on('data', chunk => chunks.push(Buffer.from(chunk)))

    for (const [name, content] of Object.entries(entries)) {
      pack.entry({ name }, content)
    }

    pack.finalize()
    await new Promise<void>((resolve, reject) => {
      pack.on('end', resolve)
      pack.on('error', reject)
    })

    return new Promise((resolve, reject) => {
      gzip(Buffer.concat(chunks), (error, result) => {
        if (error) {
          reject(error)
          return
        }

        resolve(result)
      })
    })
  }

  async function startRegistry(tarball: Buffer): Promise<RegistryServer> {
    let metadataRequests = 0
    let tarballRequests = 0

    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        metadataRequests += 1
        const host = request.headers.host

        if (host === undefined) {
          response.statusCode = 400
          response.end('missing host')
          return
        }

        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity: 'sha512-test',
                tarball: `http://${host}/plugin-python-0.3.1.tgz`,
              },
            },
          },
        }))
        return
      }

      if (request.url === '/plugin-python-0.3.1.tgz') {
        tarballRequests += 1
        response.setHeader('content-type', 'application/octet-stream')
        response.end(tarball)
        return
      }

      response.statusCode = 404
      response.end('not found')
    })

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve)
      server.on('error', reject)
    })

    const { port } = server.address() as AddressInfo
    const registry = `http://127.0.0.1:${port}/`
    servers.push({
      close: () => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      }),
      metadataRequests: () => metadataRequests,
      registry,
      tarballRequests: () => tarballRequests,
    })

    return servers.at(-1)!
  }

  async function createPluginTarball(): Promise<Buffer> {
    return createTarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: { '.': './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        type: 'module',
        version: '0.3.1',
      }),
    })
  }

  it('downloads, extracts, resolves, and locks configured static plugin packages', async () => {
    const projectRoot = await createProject(`
export default [
  {
    plugins: {
      python: '@alint-js/plugin-python@0.3.1',
    },
  },
]
`)
    const registry = await startRegistry(await createPluginTarball())

    const result = await installStaticPlugins({ cwd: projectRoot, registry: registry.registry })
    const lock = JSON.parse(await readFile(join(projectRoot, '.alint', 'plugins', 'lock.json'), 'utf8')) as unknown

    expect(result.installedCount).toBe(1)
    expect(lock).toEqual({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: registry.registry,
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: `${registry.registry}plugin-python-0.3.1.tgz`,
          version: '0.3.1',
        },
      },
      version: 1,
    })
    await expect(readFile(join(projectRoot, '.alint', 'plugins', 'store', '@alint-js', 'plugin-python', '0.3.1', 'package', 'dist', 'index.mjs'), 'utf8'))
      .resolves
      .toBe('export default { rules: {} }\n')
  })

  it('downloads each repeated package specifier once while locking every alias', async () => {
    const projectRoot = await createProject(`
export default [
  { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
  { plugins: { py: '@alint-js/plugin-python@0.3.1' } },
]
`)
    const registry = await startRegistry(await createPluginTarball())

    const result = await installStaticPlugins({ cwd: projectRoot, registry: registry.registry })

    expect(result.installedCount).toBe(1)
    expect(registry.metadataRequests()).toBe(1)
    expect(registry.tarballRequests()).toBe(1)
    expect(Object.keys(result.lock.plugins)).toEqual(['python', 'py'])
    expect(result.lock.plugins.python?.entry).toBe(result.lock.plugins.py?.entry)
  })

  it('writes an empty lock file when there are no static plugin references', async () => {
    const projectRoot = await createProject('export default [{ rules: {} }]\n')

    const result = await installStaticPlugins({ cwd: projectRoot })
    const lock = JSON.parse(await readFile(join(projectRoot, '.alint', 'plugins', 'lock.json'), 'utf8')) as unknown

    expect(result.installedCount).toBe(0)
    expect(result.referenceCount).toBe(0)
    expect(lock).toEqual({ plugins: {}, version: 1 })
  })

  it('rejects tarball entries that escape the package directory', async () => {
    const projectRoot = await createProject(`
export default [
  { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
]
`)
    const registry = await startRegistry(await createTarball({
      'package/../evil.txt': 'escape',
      'package/package.json': '{}',
    }))

    await expect(installStaticPlugins({ cwd: projectRoot, registry: registry.registry }))
      .rejects
      .toThrow('Plugin tarball entry "package/../evil.txt" escapes the package directory.')
  })
})
