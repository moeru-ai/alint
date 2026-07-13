import { isError } from '@moeru/std/error'

// Must be reported, and only the agent can reach it: no fingerprint pairs this with
// `isNodeError` in `store.ts`. It takes an extra parameter, calls `isError` instead of
// using `instanceof`, and compares the code rather than testing for the key. PR #31
// left exactly this shape behind in `packages/config/src/utils/fs.ts`.
export function isNodeErrorCode(error: unknown, code: string): boolean {
  return isError(error) && 'code' in error && error.code === code
}
