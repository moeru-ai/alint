import { stat } from 'node:fs/promises'

import { isError } from '@moeru/std/error'

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch (error) {
    if (isENOENTError(error)) {
      return false
    }

    throw error
  }
}

export function isENOENTError(error: unknown): boolean {
  return isNodeErrorCode(error, 'ENOENT')
}

export function isNodeErrorCode(error: unknown, code: string): boolean {
  return isError(error) && 'code' in error && error.code === code
}
