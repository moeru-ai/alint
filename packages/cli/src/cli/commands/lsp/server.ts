import type { InitializeParams } from 'vscode-languageserver'

import type { CliIo, CliWritable } from '../../types'
import type { FolderSession } from './folder'

import { Writable } from 'node:stream'

import { errorMessageFrom } from '@moeru/std'

import { createFolderSession } from './folder'

/** Two commands, because a workspace run can cost orders of magnitude more than one file. */
export const RUN_FILE_COMMAND = 'alint.runFile'
export const RUN_WORKSPACE_COMMAND = 'alint.runWorkspace'

export async function startLspServer(io: CliIo): Promise<number> {
  const { stdin } = io

  if (!stdin) {
    io.stderr.write('alint lsp needs a readable stdin to speak JSON-RPC over.\n')
    return 2
  }

  // NOTICE: two reasons for the dynamic import. It keeps the protocol stack out of the cold start
  // of every other command. And `vscode-languageserver/node` is CommonJS that re-exports its
  // protocol package with `__exportStar`
  // (`packages/cli/node_modules/vscode-languageserver/lib/node/main.js`). A namespace import reads
  // those names at run time; a static named import needs cjs-module-lexer to resolve the star.
  const { createConnection, TextDocumentSyncKind } = await import('vscode-languageserver/node')
  const connection = createConnection(stdin, toWritableStream(io.stdout))
  const folders = new Map<string, FolderSession>()
  let folderUris: string[] = []

  const openFolder = async (folderUri: string): Promise<void> => {
    const folder = await createFolderSession({ folderUri, io })
    folders.set(folderUri, folder)

    await folder.refreshFromCache()

    for (const [uri, diagnostics] of folder.diagnostics) {
      connection.sendDiagnostics({ diagnostics, uri })
    }
  }

  connection.onInitialize((params) => {
    folderUris = resolveFolderUris(params)

    return {
      capabilities: {
        executeCommandProvider: {
          commands: [RUN_FILE_COMMAND, RUN_WORKSPACE_COMMAND],
          workDoneProgress: true,
        },
        // `change: None` is intended. A diagnostic is keyed by the target content hash, so
        // diagnostics for an edited region stay stale until the user saves the file.
        textDocumentSync: {
          change: TextDocumentSyncKind.None,
          openClose: true,
          save: true,
        },
        workspace: {
          workspaceFolders: { changeNotifications: true, supported: true },
        },
      },
    }
  })

  // The client accepts no notification before `initialized`.
  connection.onInitialized(() => {
    void Promise.all(folderUris.map(async (folderUri) => {
      try {
        await openFolder(folderUri)
      }
      catch (error) {
        // A handler that throws ends the session. A folder whose config fails to load must not
        // stop the other folders.
        connection.console.error(
          `alint: ${folderUri}: ${errorMessageFrom(error) ?? 'could not read cached diagnostics'}`,
        )
      }
    }))
  })

  connection.onShutdown(async () => {
    // Disposal stops the ACP gateway. Without it the port and its child processes stay open.
    await Promise.all([...folders.values()].map(folder => folder.dispose()))
    folders.clear()
  })

  connection.listen()

  // NOTICE: this promise rarely resolves. `vscode-languageserver` answers the `exit` notification
  // with `process.exit`
  // (`packages/cli/node_modules/vscode-languageserver/lib/node/main.js:136-139`).
  //
  // It must stay pending anyway. If it resolves, `executeCli` returns and restores the console
  // interception, and a rule that logs then writes to stdout and corrupts the JSON-RPC stream.
  return new Promise<number>((resolve) => {
    connection.onExit(() => resolve(0))
  })
}

/**
 * A client can send `workspaceFolders`, the older `rootUri`, or both.
 *
 * Only a `file:` URI has a directory. A remote or untitled root has no cwd and no cache.
 */
function resolveFolderUris(params: InitializeParams): string[] {
  const uris = params.workspaceFolders?.map(folder => folder.uri)
    ?? (params.rootUri === null ? [] : [params.rootUri])

  return [...new Set(uris)].filter(uri => uri.startsWith('file://'))
}

/**
 * Adapts the CLI string output to the byte stream that `createConnection` requires.
 *
 * `String(chunk)` cannot split a UTF-8 sequence. The message writer sends one ASCII header, then
 * one complete body, so each chunk is whole.
 */
function toWritableStream(sink: CliWritable): Writable {
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      sink.write(String(chunk))
      callback()
    },
  })
}
