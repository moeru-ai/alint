import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { fetchNpmPackageVersion } from './npm'
import { parsePluginSpecifier } from './spec'

describe('fetchNpmPackageVersion', () => {
  it('fetches exact scoped package metadata from a registry', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        versions: {
          '0.3.1': {
            dist: {
              integrity: 'sha512-test',
              tarball: 'http://registry.local/plugin.tgz',
            },
            name: '@alint-js/plugin-python',
            version: '0.3.1',
          },
        },
      }))
    })
    const endpoint = await listen(server)

    try {
      await expect(fetchNpmPackageVersion({
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).resolves.toEqual({
        integrity: 'sha512-test',
        name: '@alint-js/plugin-python',
        tarball: 'http://registry.local/plugin.tgz',
        version: '0.3.1',
      })
      expect(requests).toEqual(['/@alint-js%2fplugin-python'])
    }
    finally {
      await close(server)
    }
  })

  it('fetches exact unscoped package metadata from a registry', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        versions: {
          '1.2.3': {
            dist: {
              integrity: 'sha512-test',
              tarball: 'http://registry.local/plugin-go.tgz',
            },
            name: 'alint-plugin-go',
            version: '1.2.3',
          },
        },
      }))
    })
    const endpoint = await listen(server)

    try {
      await fetchNpmPackageVersion({
        registry: endpoint,
        specifier: parsePluginSpecifier('alint-plugin-go@1.2.3'),
      })

      expect(requests).toEqual(['/alint-plugin-go'])
    }
    finally {
      await close(server)
    }
  })

  it('preserves registry base paths without trailing slashes', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        versions: {
          '0.3.1': {
            dist: {
              integrity: 'sha512-test',
              tarball: 'http://registry.local/plugin.tgz',
            },
          },
        },
      }))
    })
    const endpoint = await listen(server)

    try {
      await fetchNpmPackageVersion({
        registry: `${endpoint}npm`,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })

      expect(requests).toEqual(['/npm/@alint-js%2fplugin-python'])
    }
    finally {
      await close(server)
    }
  })

  it('rejects missing package versions', async () => {
    const server = createServer((_, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ versions: {} }))
    })
    const endpoint = await listen(server)

    try {
      await expect(fetchNpmPackageVersion({
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@9.9.9'),
      })).rejects.toThrow('Package @alint-js/plugin-python does not have version 9.9.9.')
    }
    finally {
      await close(server)
    }
  })

  it('rejects package versions without complete dist metadata', async () => {
    const server = createServer((_, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        versions: {
          '0.3.1': {
            dist: {
              tarball: 'http://registry.local/plugin.tgz',
            },
          },
        },
      }))
    })
    const endpoint = await listen(server)

    try {
      await expect(fetchNpmPackageVersion({
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('Package @alint-js/plugin-python@0.3.1 is missing tarball integrity metadata.')
    }
    finally {
      await close(server)
    }
  })

  it('rejects registry HTTP failures', async () => {
    const server = createServer((_, response) => {
      response.statusCode = 404
      response.end()
    })
    const endpoint = await listen(server)

    try {
      await expect(fetchNpmPackageVersion({
        registry: endpoint,
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      })).rejects.toThrow('Failed to fetch npm metadata for @alint-js/plugin-python: HTTP 404.')
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

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('Expected TCP server address.')
  }

  return `http://127.0.0.1:${address.port}/`
}
