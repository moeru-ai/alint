/**
 * Command ids the language server declares in `executeCommandProvider`.
 *
 * They are part of the protocol surface, so any editor integration needs them, not only the VS
 * Code extension in this repository. This module imports nothing, so a client can bundle it
 * without pulling in the CLI.
 */

/** Deletes cached diagnostics. A client asks the user before it sends this. */
export const CLEAR_CACHE_COMMAND = 'alint.clearCache'

/** Runs one file. The argument is the document URI. */
export const RUN_FILE_COMMAND = 'alint.runFile'

/** Runs every file the config matches. It takes no arguments. */
export const RUN_WORKSPACE_COMMAND = 'alint.runWorkspace'
