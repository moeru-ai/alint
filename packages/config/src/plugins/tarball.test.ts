import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import tar from 'tar-stream'

import { describe, expect, it } from 'vitest'

import { extractNpmTarball, verifyIntegrity } from './tarball'

const gzipAsync = promisify(gzip)

describe('extractNpmTarball', () => {
  it('extracts package files under the target directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-tarball-'))
    const target = join(root, 'package')
    const tarball = await createTarball({
      'package/dist/index.mjs': 'export default { rules: {} }\n',
      'package/package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await extractNpmTarball(tarball, target)

    await expect(readFile(join(target, 'dist', 'index.mjs'), 'utf8'))
      .resolves
      .toBe('export default { rules: {} }\n')
  })

  it('ignores directories and non-file entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-tarball-'))
    const target = join(root, 'package')
    const tarball = await createTarball({
      'package/dist/': { content: '', type: 'directory' },
      'package/dist/index.mjs': { content: 'export default { rules: {} }\n', type: 'file' },
    })

    await extractNpmTarball(tarball, target)

    await expect(readFile(join(target, 'dist', 'index.mjs'), 'utf8'))
      .resolves
      .toBe('export default { rules: {} }\n')
  })

  it('rejects entries outside the npm package prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-tarball-'))
    const tarball = await createTarball({
      'other/package.json': '{}',
    })

    await expect(extractNpmTarball(tarball, join(root, 'package')))
      .rejects
      .toThrow('Tarball entry does not use npm package/ prefix.')
  })

  it('rejects large invalid entries without unhandled stream errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-tarball-'))
    const tarball = await createTarball({
      'other/large.bin': 'x'.repeat(10 * 1024 * 1024),
    })

    await expect(extractNpmTarball(tarball, join(root, 'package')))
      .rejects
      .toThrow('Tarball entry does not use npm package/ prefix.')
  })

  it('rejects path traversal entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-tarball-'))
    const tarball = await createTarball({
      'package/../escape.txt': 'bad',
    })

    await expect(extractNpmTarball(tarball, join(root, 'package')))
      .rejects
      .toThrow('Tarball entry escapes package root.')
  })

  it('rejects absolute path entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-tarball-'))
    const tarball = await createTarball({
      '/package/escape.txt': 'bad',
    })

    await expect(extractNpmTarball(tarball, join(root, 'package')))
      .rejects
      .toThrow('Tarball entry escapes package root.')
  })
})

describe('verifyIntegrity', () => {
  it('accepts matching sha512 integrity', () => {
    const body = Buffer.from('hello')
    const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`

    expect(() => verifyIntegrity(body, integrity)).not.toThrow()
  })

  it('rejects mismatched sha512 integrity', () => {
    const body = Buffer.from('hello')
    const integrity = `sha512-${Buffer.from('wrong').toString('base64')}`

    expect(() => verifyIntegrity(body, integrity)).toThrow('Tarball integrity mismatch.')
  })

  it('rejects unsupported integrity algorithms', () => {
    const body = Buffer.from('hello')

    expect(() => verifyIntegrity(body, 'sha1-test')).toThrow('Unsupported tarball integrity "sha1-test".')
  })
})

type TarballEntry = string | {
  content: string
  type: 'directory' | 'file' | 'symlink'
}

async function createTarball(files: Record<string, TarballEntry>): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    Readable.from(pack)
      .on('data', chunk => chunks.push(Buffer.from(chunk)))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)))
  })

  for (const [name, value] of Object.entries(files)) {
    if (typeof value === 'string') {
      pack.entry({ name, type: 'file' }, value)
      continue
    }

    pack.entry({ name, type: value.type }, value.content)
  }

  pack.finalize()

  return gzipAsync(await done)
}
