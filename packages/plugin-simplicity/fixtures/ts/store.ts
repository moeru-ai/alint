import { readFile } from 'node:fs/promises'

export async function readStore(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return ''
    }

    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
