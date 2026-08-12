import type { InitializeParams, Diagnostic as LspDiagnostic } from 'vscode-languageserver'

import type { CliIo, CliWritable } from '../../types'
import type { FolderSession } from './folder'

import { Writable } from 'node:stream'

import { errorMessageFrom } from '@moeru/std'
import { DidChangeWatchedFilesNotification } from 'vscode-languageserver'

import { createFolderSession } from './folder'
import { createPublisher } from './publisher'

/** Long enough to collect a workspace pass into few messages, short enough to keep a save prompt. */
const PUBLISH_FLUSH_MS = 200

/** Two commands, because a workspace run can cost orders of magnitude more than one file. */
export const RUN_FILE_COMMAND = 'alint.runFile'
export const RUN_WORKSPACE_COMMAND = 'alint.runWorkspace'

export async function startLspServer(io: CliIo): Promise<number> {
  const { stdin } = io

  if (!stdin) {
    io.stderr.write('alint lsp needs a readable stdin to speak JSON-RPC over.\n')
    return 2
  }

  // NOTICE: the import is dynamic for two reasons. It keeps the protocol stack out of the start-up
  // of every other command. And `vscode-languageserver/node` is CommonJS that re-exports its
  // protocol package with `__exportStar`
  // (`packages/cli/node_modules/vscode-languageserver/lib/node/main.js`). A namespace import reads
  // those names at run time; a static named import needs cjs-module-lexer to resolve the star.
  const { createConnection, TextDocumentSyncKind } = await import('vscode-languageserver/node')
  const connection = createConnection(stdin, toWritableStream(io.stdout))
  const folders = new Map<string, FolderSession>()
  let folderUris: string[] = []
  let watchesConfig = false

  /** A document belongs to one folder at most, so the first folder that holds it is the owner. */
  const diagnosticsFor = (uri: string): LspDiagnostic[] => {
    for (const folder of folders.values()) {
      const diagnostics = folder.diagnostics.get(uri)

      if (diagnostics) {
        return diagnostics
      }
    }

    // An empty list is not a failure. It clears what the editor still shows for the document.
    return []
  }

  const publisher = createPublisher({
    flushMs: PUBLISH_FLUSH_MS,
    publish: uri => connection.sendDiagnostics({ diagnostics: diagnosticsFor(uri), uri }),
  })

  const openFolder = async (folderUri: string): Promise<void> => {
    const folder = await createFolderSession({
      folderUri,
      io,
      onChanged: uris => uris.forEach(publisher.queue),
    })
    folders.set(folderUri, folder)

    await folder.refreshFromCache()

    for (const uri of folder.diagnostics.keys()) {
      publisher.queue(uri)
    }
  }

  connection.onInitialize((params) => {
    folderUris = resolveFolderUris(params)
    watchesConfig = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true

    return {
      capabilities: {
        executeCommandProvider: {
          commands: [RUN_FILE_COMMAND, RUN_WORKSPACE_COMMAND],
          workDoneProgress: true,
        },
        // `change: None` is intended. A diagnostic is keyed by the target content, so diagnostics
        // for an edited region stay stale until the user saves the file.
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
    if (watchesConfig) {
      // A static server capability cannot carry a glob, so the watcher is registered here. A
      // client without dynamic registration reports no changes.
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern: '**/alint.config.*' }],
      })
    }

    void Promise.all(folderUris.map(async (folderUri) => {
      try {
        await openFolder(folderUri)
      }
      catch (error) {
        // A handler that throws ends the session. One folder with a bad config must not stop the
        // other folders.
        connection.console.error(
          `alint: ${folderUri}: ${errorMessageFrom(error) ?? 'could not read cached diagnostics'}`,
        )
      }
    }))
  })

  // A saved file is on disk, so the pass reads it and the client sends no text.
  connection.onDidSaveTextDocument(({ textDocument }) => {
    void Promise.all([...folders.values()].map(async (folder) => {
      try {
        for (const uri of await folder.refreshFile(textDocument.uri)) {
          publisher.queue(uri)
        }
      }
      catch (error) {
        connection.console.error(
          `alint: ${textDocument.uri}: ${errorMessageFrom(error) ?? 'could not refresh the saved file'}`,
        )
      }
    }))
  })

  // Opening a file starts no run. The last pass already put its diagnostics in the map.
  connection.onDidOpenTextDocument(({ textDocument }) => {
    publisher.setOpen(textDocument.uri, true)
    publisher.queue(textDocument.uri)
  })

  // A closed document keeps its diagnostics. Only its order in a flush changes.
  connection.onDidCloseTextDocument(({ textDocument }) => {
    publisher.setOpen(textDocument.uri, false)
  })

  connection.onDidChangeWatchedFiles(() => {
    void Promise.all([...folders.values()].map(async (folder) => {
      try {
        await folder.reloadConfig()
        folder.scheduleWorkspacePass()
      }
      catch (error) {
        connection.console.error(
          `alint: ${folder.folderUri}: ${errorMessageFrom(error) ?? 'could not reload the config'}`,
        )
      }
    }))

    // A new config changes `configHash` for every affected target, so the pass that follows finds
    // nothing and the editor empties. The result is correct but it looks like a failure.
    // TODO: send an `alint/status` notification with the skipped count instead of this log line.
    connection.console.info('alint: config changed; cached diagnostics were cleared and need a new run')
  })

  connection.onShutdown(async () => {
    publisher.dispose()
    // Disposal stops the ACP gateway. Without it, the port and its child processes stay open.
    await Promise.all([...folders.values()].map(folder => folder.dispose()))
    folders.clear()
  })

  connection.listen()

  // NOTICE: this promise rarely resolves. `vscode-languageserver` answers the `exit` notification
  // with `process.exit`
  // (`packages/cli/node_modules/vscode-languageserver/lib/node/main.js:136-139`).
  //
  // It must stay pending. If it resolves, `executeCli` returns and restores console output to
  // stdout, and a rule that logs then corrupts the JSON-RPC stream.
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
 * `String(chunk)` cannot split a UTF-8 sequence here. The message writer sends one ASCII header,
 * then one complete body, so every chunk is whole.
 */
function toWritableStream(sink: CliWritable): Writable {
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      sink.write(String(chunk))
      callback()
    },
  })
}
