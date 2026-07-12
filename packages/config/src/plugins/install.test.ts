import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import tar from 'tar-stream'

import { describe, expect, it } from 'vitest'

import { installStaticPlugin } from './install'
import { loadPluginLockFile } from './lock'
import { parsePluginSpecifier } from './spec'

const gzipAsync = promisify(gzip)

describe('installStaticPlugin', () => {
  it('downloads, extracts, and locks a plugin package', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-'))
    const tarball = await createTarball({
      'package/dist/chunk.mjs': 'export const rules = {}\n',
      'package/dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity,
                tarball: `${endpoint}/plugin-python-0.3.1.tgz`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(tarball)
    })
    endpoint = await listen(server)

    try {
      const entry = await installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })
      const lock = await loadPluginLockFile(cwd)

      await expect(readFile(entry.entry, 'utf8')).resolves.toContain('export default')
      expect(lock.plugins.python).toMatchObject({
        alias: 'python',
        integrity,
        name: '@alint-js/plugin-python',
        registry: `${endpoint}/`,
        specifier: '@alint-js/plugin-python@0.3.1',
        version: '0.3.1',
      })
      expect(lock.plugins.python?.entry).toBe('.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs')
    }
    finally {
      await close(server)
    }
  })

  it('requires package.json exports for the plugin entry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-exports-'))
    const tarball = await createTarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        main: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity,
                tarball: `${endpoint}/plugin-python-0.3.1.tgz`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(tarball)
    })
    endpoint = await listen(server)

    try {
      await expect(installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('must export "." in package.json')
    }
    finally {
      await close(server)
    }
  })

  it('keeps an existing package when replacement integrity differs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-keep-'))
    const goodTarball = await createTarball({
      'package/dist/index.mjs': 'export const marker = "old"\nexport default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const badTarball = await createTarball({
      'package/dist/index.mjs': 'export const marker = "new"\nexport default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const goodIntegrity = `sha512-${createHash('sha512').update(goodTarball).digest('base64')}`
    const badIntegrity = `sha512-${createHash('sha512').update(badTarball).digest('base64')}`
    let installCount = 0
    let currentIntegrity = goodIntegrity
    let currentTarball = goodTarball
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        installCount += 1
        currentIntegrity = installCount > 1 ? badIntegrity : goodIntegrity
        currentTarball = installCount > 1 ? badTarball : goodTarball
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity: currentIntegrity,
                tarball: `${endpoint}/plugin-python-0.3.1.tgz`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(currentTarball)
    })
    endpoint = await listen(server)

    try {
      const entry = await installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })

      await expect(installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('already installed with different integrity')

      const lock = await loadPluginLockFile(cwd)

      await expect(readFile(entry.entry, 'utf8')).resolves.toContain('"old"')
      expect(lock.plugins.python?.integrity).toBe(goodIntegrity)
    }
    finally {
      await close(server)
    }
  })

  it('preserves lock entries from concurrent installs in the same project', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-concurrent-'))
    const tarball = await createTarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity,
                tarball: `${endpoint}/plugin-python-0.3.1.tgz`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(tarball)
    })
    endpoint = await listen(server)

    try {
      await Promise.all(['python', 'py'].map(alias => installStaticPlugin(cwd, {
        alias,
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })))
      const lock = await loadPluginLockFile(cwd)

      expect(lock.plugins.python).toMatchObject({ alias: 'python', integrity })
      expect(lock.plugins.py).toMatchObject({ alias: 'py', integrity })
    }
    finally {
      await close(server)
    }
  })

  it('reuses an existing package instead of replacing live files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-reuse-'))
    const oldTarball = await createTarball({
      'package/dist/index.mjs': 'export const marker = "old"\nexport default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const newTarball = await createTarball({
      'package/dist/index.mjs': 'export const marker = "new"\nexport default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const oldIntegrity = `sha512-${createHash('sha512').update(oldTarball).digest('base64')}`
    const newIntegrity = `sha512-${createHash('sha512').update(newTarball).digest('base64')}`
    let installCount = 0
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        installCount += 1
        const integrity = installCount > 1 ? newIntegrity : oldIntegrity
        const tarballName = installCount > 1 ? 'new.tgz' : 'old.tgz'
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity,
                tarball: `${endpoint}/${tarballName}`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(request.url === '/new.tgz' ? newTarball : oldTarball)
    })
    endpoint = await listen(server)

    try {
      const first = await installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })

      await expect(installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('already installed with different integrity')

      await expect(readFile(first.entry, 'utf8')).resolves.toContain('"old"')
    }
    finally {
      await close(server)
    }
  })

  it('rejects an orphaned package directory with different integrity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-orphan-'))
    const oldTarball = await createTarball({
      'package/dist/index.mjs': 'export const marker = "old"\nexport default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const newTarball = await createTarball({
      'package/dist/index.mjs': 'export const marker = "new"\nexport default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const oldIntegrity = `sha512-${createHash('sha512').update(oldTarball).digest('base64')}`
    const newIntegrity = `sha512-${createHash('sha512').update(newTarball).digest('base64')}`
    let installCount = 0
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        installCount += 1
        const integrity = installCount > 1 ? newIntegrity : oldIntegrity
        const tarballName = installCount > 1 ? 'new.tgz' : 'old.tgz'
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity,
                tarball: `${endpoint}/${tarballName}`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(request.url === '/new.tgz' ? newTarball : oldTarball)
    })
    endpoint = await listen(server)

    try {
      const first = await installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })

      await rm(join(cwd, '.alint', 'plugins', 'lock.json'))

      await expect(installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('already installed with different integrity')

      await expect(readFile(first.entry, 'utf8')).resolves.toContain('"old"')
      await expect(loadPluginLockFile(cwd)).resolves.toEqual({
        plugins: {},
        version: 1,
      })
    }
    finally {
      await close(server)
    }
  })

  it('fails instead of waiting forever on a stale install lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-lock-'))
    const tarball = await createTarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity,
                tarball: `${endpoint}/plugin-python-0.3.1.tgz`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(tarball)
    })
    endpoint = await listen(server)
    await mkdir(join(cwd, '.alint', 'plugins', 'install.lock'), { recursive: true })

    try {
      await expect(installStaticPlugin(cwd, {
        alias: 'python',
        installLockTimeoutMs: 1,
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('Timed out waiting for plugin install lock')
    }
    finally {
      await close(server)
    }
  })

  it('rejects tarballs with mismatched integrity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-install-integrity-'))
    const tarball = await createTarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        exports: './dist/index.mjs',
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    let endpoint = ''
    const server = createServer((request, response) => {
      if (request.url === '/@alint-js%2fplugin-python') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          versions: {
            '0.3.1': {
              dist: {
                integrity: `sha512-${createHash('sha512').update('wrong').digest('base64')}`,
                tarball: `${endpoint}/plugin-python-0.3.1.tgz`,
              },
            },
          },
        }))
        return
      }

      response.setHeader('content-type', 'application/octet-stream')
      response.end(tarball)
    })
    endpoint = await listen(server)

    try {
      await expect(installStaticPlugin(cwd, {
        alias: 'python',
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('Tarball integrity mismatch')
    }
    finally {
      await close(server)
    }
  })
})

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function createTarball(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    Readable.from(pack)
      .on('data', chunk => chunks.push(Buffer.from(chunk)))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)))
  })

  for (const [name, content] of Object.entries(files)) {
    pack.entry({ name }, content)
  }

  pack.finalize()
  return gzipAsync(await done)
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('Expected TCP server address.')
  }

  return `http://127.0.0.1:${address.port}`
}
