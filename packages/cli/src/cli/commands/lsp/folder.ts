import type { RunResult } from '@alint-js/core'
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver'

import type { RunSession } from '../../runtime/session'
import type { CliIo } from '../../types'

import { realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AlintRunCancelledError, AlintRunError } from '@alint-js/core'

import { createRunSession } from '../../runtime/session'
import { toLspDiagnostic } from './diagnostics'

export interface CreateFolderSessionOptions {
  folderUri: string
  io: CliIo
}

export interface FolderSession {
  cwd: string
  /** Document URI to its diagnostics. Each pass replaces the whole map. */
  readonly diagnostics: ReadonlyMap<string, LspDiagnostic[]>
  dispose: () => Promise<void>
  folderUri: string
  refreshFromCache: () => Promise<void>
}

/**
 * One workspace folder. Keeps two paths for it, and they are not interchangeable.
 *
 * `cwd` is the resolved path. Runs use it, because `process.cwd()` is always canonical and the
 * lint command therefore always runs under a resolved path. If the two differ, every target gets
 * a different identity: the cache file is found, no entry in it matches, and there is no error.
 *
 * `folderPath` is the path the client sent. Published diagnostics use it. See `toDocumentUri`.
 */
export async function createFolderSession(
  options: CreateFolderSessionOptions,
): Promise<FolderSession> {
  const folderPath = fileURLToPath(options.folderUri)
  const cwd = await realpath(folderPath)
  const session = await createRunSession({ ...options.io, cwd })
  let diagnostics: ReadonlyMap<string, LspDiagnostic[]> = new Map()

  return {
    cwd,
    get diagnostics() {
      return diagnostics
    },
    dispose: session.shutdown,
    folderUri: options.folderUri,
    refreshFromCache: async () => {
      diagnostics = groupByUri(await runFromCache(session), { cwd, folderPath })
    },
  }
}

/** Groups by the file each diagnostic names. A project rule reports files it did not target. */
function groupByUri(
  result: RunResult,
  paths: { cwd: string, folderPath: string },
): Map<string, LspDiagnostic[]> {
  const grouped = new Map<string, LspDiagnostic[]>()

  for (const diagnostic of result.diagnostics) {
    const uri = toDocumentUri(diagnostic.filePath, paths)
    const existing = grouped.get(uri)

    if (existing) {
      existing.push(toLspDiagnostic(diagnostic))
      continue
    }

    grouped.set(uri, [toLspDiagnostic(diagnostic)])
  }

  return grouped
}

async function runFromCache(session: RunSession): Promise<RunResult> {
  try {
    return await session.run({
      cacheOnly: true,
      // This pass runs on every workspace load and spends nothing. Do not record it as a run.
      runner: { ...session.runner, stats: false },
    })
  }
  catch (error) {
    // A failed run still carries the diagnostics it produced. Keep them, or one unreadable file
    // clears every diagnostic in the workspace.
    if (error instanceof AlintRunError || error instanceof AlintRunCancelledError) {
      return error.result
    }

    throw error
  }
}

/**
 * Converts a run path back to the path the client sent.
 *
 * An editor matches diagnostics by exact URI. A resolved URI attaches them to a document the
 * editor did not open.
 */
function toDocumentUri(filePath: string, paths: { cwd: string, folderPath: string }): string {
  if (paths.cwd === paths.folderPath || !filePath.startsWith(`${paths.cwd}${sep}`)) {
    return pathToFileURL(filePath).toString()
  }

  return pathToFileURL(join(paths.folderPath, relative(paths.cwd, filePath))).toString()
}
