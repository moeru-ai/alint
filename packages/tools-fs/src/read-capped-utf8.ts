import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'

export type CappedUtf8ReadResult = ContentReadResult | NotFileReadResult | TooLargeReadResult

interface ContentReadResult {
  status: 'content'
  text: string
}

interface NotFileReadResult {
  status: 'not-file'
}

interface TooLargeReadResult {
  status: 'too-large'
}

// Read through one stable handle and reserve one extra byte so size checks and
// file-growth handling stay identical for direct reads and content searches.
export async function readCappedUtf8(filePath: string, maxBytes: number): Promise<CappedUtf8ReadResult> {
  const handle = await open(filePath, 'r')

  try {
    const stats = await handle.stat()

    if (!stats.isFile()) {
      return { status: 'not-file' }
    }

    if (stats.size > maxBytes) {
      return { status: 'too-large' }
    }

    const buffer = Buffer.alloc(maxBytes + 1)
    let bytesRead = 0

    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)

      if (result.bytesRead === 0) {
        break
      }

      bytesRead += result.bytesRead
    }

    return bytesRead > maxBytes
      ? { status: 'too-large' }
      : { status: 'content', text: buffer.subarray(0, bytesRead).toString('utf8') }
  }
  finally {
    await handle.close()
  }
}
