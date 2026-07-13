import { rm } from 'node:fs/promises'

export async function dropArchive(path: string): Promise<boolean> {
  try {
    await rm(path)

    return true
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

// The exact-match twin of `store.ts`: copied character for character.
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
