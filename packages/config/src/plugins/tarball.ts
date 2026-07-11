import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import tar from 'tar-stream'

import { dirname, isAbsolute, normalize, relative, resolve } from 'pathe'

export async function extractNpmTarball(
  body: Buffer,
  targetDir: string,
): Promise<void> {
  const extract = tar.extract()
  let extractionError: Error | undefined

  extract.on('entry', (header, stream, next) => {
    void extractEntry(targetDir, header, stream)
      .then(() => next())
      .catch((error: unknown) => {
        extractionError ??= error instanceof Error ? error : new Error(String(error))
        void drainEntry(stream)
          .then(() => next())
          .catch(drainError => next(drainError instanceof Error ? drainError : new Error(String(drainError))))
      })
  })

  await pipeline(Readable.from([body]), createGunzip(), extract)

  if (extractionError) {
    throw extractionError
  }
}

export function verifyIntegrity(body: Buffer, integrity: string): void {
  const [algorithm, expectedBase64] = integrity.split('-', 2)

  if (algorithm !== 'sha512' || expectedBase64 === undefined || expectedBase64.length === 0) {
    throw new Error(`Unsupported tarball integrity "${integrity}".`)
  }

  const actual = createHash('sha512').update(body).digest()
  const expected = Buffer.from(expectedBase64, 'base64')

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Tarball integrity mismatch.')
  }
}

function drainEntry(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
    stream.resume()
  })
}

async function extractEntry(
  targetDir: string,
  header: tar.Headers,
  stream: NodeJS.ReadableStream,
): Promise<void> {
  const relativePath = packageRelativePath(header.name)
  const targetPath = resolve(targetDir, relativePath)

  if (!isInside(targetDir, targetPath)) {
    throw new Error('Tarball entry escapes package root.')
  }

  if (header.type !== 'file') {
    stream.resume()
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    return
  }

  await mkdir(dirname(targetPath), { recursive: true })
  await pipeline(stream, createWriteStream(targetPath))
}

function isInside(root: string, child: string): boolean {
  const location = relative(resolve(root), resolve(child))

  return location === '' || (!location.startsWith('..') && !isAbsolute(location))
}

function packageRelativePath(path: string): string {
  if (isAbsolute(path)) {
    throw new Error('Tarball entry escapes package root.')
  }

  if (!path.startsWith('package/')) {
    throw new Error('Tarball entry does not use npm package/ prefix.')
  }

  const relativePath = normalize(path.slice('package/'.length))

  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error('Tarball entry escapes package root.')
  }

  return relativePath
}
