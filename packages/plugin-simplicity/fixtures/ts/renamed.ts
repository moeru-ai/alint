import { stat } from 'node:fs/promises'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)

    return true
  }
  catch (failure) {
    if (hasErrorCode(failure) && failure.code === 'ENOENT') {
      return false
    }

    throw failure
  }
}

// The renamed-match twin of `isNodeError`: only the names it declares are changed.
function hasErrorCode(failure: unknown): failure is NodeJS.ErrnoException {
  return failure instanceof Error && 'code' in failure
}
