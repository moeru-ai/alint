// Node.js exposes errno codes on Error instances without a shared base error type.
export function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
