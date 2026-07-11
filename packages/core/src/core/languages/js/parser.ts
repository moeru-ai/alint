import { parseSync as parseOxcSync } from 'oxc-parser'

type OxcParseSyncOptions = Parameters<typeof parseOxcSync>[2]
type OxcParseSyncResult = ReturnType<typeof parseOxcSync>

export function parseSync(
  filename: string,
  sourceText: string,
  options?: OxcParseSyncOptions,
): OxcParseSyncResult {
  // NOTICE: Keep all direct `oxc-parser` access behind this boundary. Bun's
  // standalone executable builder only embeds N-API `.node` files when a
  // platform bootstrap imports the binding as a file and sets
  // `NAPI_RS_NATIVE_LIBRARY_PATH` before this module is loaded.
  return parseOxcSync(filename, sourceText, options)
}
