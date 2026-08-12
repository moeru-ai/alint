import type { ExtensionContext } from 'vscode'

import process from 'node:process'

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

import { window, workspace } from 'vscode'
import { LanguageClient, TransportKind } from 'vscode-languageclient/node'

const PATH_SETTING = 'alint.path'
const WORKSPACE_BIN = join('node_modules', '.bin', 'alint')

let client: LanguageClient | undefined

export async function activate(_context: ExtensionContext): Promise<void> {
  const command = await resolveAlintBinary()

  if (command === undefined) {
    // A silent failure looks the same as "alint found nothing". Name every location checked.
    await window.showErrorMessage(
      `alint could not be found. Checked the ${PATH_SETTING} setting, ${WORKSPACE_BIN} in the workspace folder, and alint on PATH.`,
    )
    return
  }

  client = new LanguageClient(
    'alint',
    'alint',
    // The server is the installed alint, on the user's own Node. Its cache keys and cwd then match
    // a terminal run, and no native binding loads inside the extension host.
    { args: ['lsp'], command, transport: TransportKind.stdio },
    // Broad selector: the alint config decides what to lint. The client only syncs open documents.
    { documentSelector: [{ scheme: 'file' }] },
  )

  await client.start()
}

export async function deactivate(): Promise<void> {
  await client?.stop()
  client = undefined
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') {
      continue
    }

    for (const candidate of withExecutableSuffixes(name)) {
      const path = join(directory, candidate)

      if (await isExecutable(path)) {
        return path
      }
    }
  }

  return undefined
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

/**
 * Finds alint: the configured path, then the workspace install, then PATH.
 *
 * The workspace install wins over a global one. The server then has the same version, cache
 * format, and `modelHash` inputs as the alint the user runs in a terminal.
 */
async function resolveAlintBinary(): Promise<string | undefined> {
  const configured = workspace.getConfiguration().get<string>(PATH_SETTING)?.trim()

  if (configured !== undefined && configured !== '') {
    return configured
  }

  for (const folder of workspace.workspaceFolders ?? []) {
    for (const candidate of withExecutableSuffixes(join(folder.uri.fsPath, WORKSPACE_BIN))) {
      if (await isExecutable(candidate)) {
        return candidate
      }
    }
  }

  return findOnPath('alint')
}

/**
 * Candidates for one command, from a bare name or a full path.
 *
 * Windows resolves executables through PATHEXT, and npm writes `alint.cmd` into `node_modules/.bin`.
 */
function withExecutableSuffixes(command: string): string[] {
  return process.platform === 'win32'
    ? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
    : [command]
}
