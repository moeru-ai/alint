import type { RunResult } from '@alint-js/core'
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver'

import type { RunSession } from '../../runtime/session'
import type { CliIo } from '../../types'

import { realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AlintRunCancelledError, AlintRunError } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std'

import { createRunSession } from '../../runtime/session'
import { toLspDiagnostic } from './diagnostics'

/** One config write arrives as several filesystem events. Wait for them before running a pass. */
const WORKSPACE_PASS_DEBOUNCE_MS = 500

export interface CreateFolderSessionOptions {
  folderUri: string
  io: CliIo
  /** Receives document URIs, ready to publish. */
  onChanged?: (uris: string[]) => void
}

export interface FolderSession {
  cwd: string
  /** Document URI to its diagnostics. A workspace pass replaces the whole map. */
  readonly diagnostics: ReadonlyMap<string, LspDiagnostic[]>
  dispose: () => Promise<void>
  folderUri: string
  /**
   * Re-reads one file and returns the document URIs to publish.
   *
   * A returned URI can have no diagnostics left, and then the map holds no entry for it. This is
   * the usual result after an edit: the changed target misses the cache and its job is skipped.
   * The caller must publish the empty list, or the editor keeps showing the old diagnostics.
   */
  refreshFile: (uri: string) => Promise<string[]>
  refreshFromCache: () => Promise<void>
  /** Builds a new run session, which is how the config on disk is re-read. */
  reloadConfig: () => Promise<void>
  /** Requests a whole-workspace pass. Requests that arrive together produce one pass. */
  scheduleWorkspacePass: () => void
}

/**
 * One workspace folder. It keeps two paths, and they are not interchangeable.
 *
 * Runs use `cwd`, the resolved path, because `process.cwd()` is always canonical and the lint
 * command therefore always runs under a resolved path. Under any other path each target gets a
 * different identity: the cache file is found, no entry matches, and no error is reported.
 *
 * Published diagnostics use `folderPath`, the path the client sent. See `toDocumentUri`.
 */
export async function createFolderSession(
  options: CreateFolderSessionOptions,
): Promise<FolderSession> {
  const folderPath = fileURLToPath(options.folderUri)
  const cwd = await realpath(folderPath)
  const runIo = { ...options.io, cwd }
  const paths = { cwd, folderPath }
  let session = await createRunSession(runIo)
  let diagnostics: Map<string, LspDiagnostic[]> = new Map()
  let scheduled: ReturnType<typeof setTimeout> | undefined

  const replaceMap = (next: Map<string, LspDiagnostic[]>): string[] => {
    // A document that lost its last diagnostic must still be published, as an empty list.
    const changed = new Set([...next.keys(), ...diagnostics.keys()])
    diagnostics = next

    return [...changed]
  }

  return {
    cwd,
    get diagnostics() {
      return diagnostics
    },
    dispose: async () => {
      // A pass that starts after disposal runs against a closed session.
      if (scheduled !== undefined) {
        clearTimeout(scheduled)
        scheduled = undefined
      }

      await session.shutdown()
    },
    folderUri: options.folderUri,
    refreshFile: async (uri) => {
      const filePath = toRunPath(uri, paths)

      if (filePath === undefined) {
        return []
      }

      const result = await runFromCache(session, { inputs: [filePath] })
      const found = groupByUri(result, paths)
      const changed = new Set([...found.keys()])

      // The pass covers one file, so only that file's entry may change.
      const documentUri = toDocumentUri(filePath, paths)

      if (!found.has(documentUri) && diagnostics.delete(documentUri)) {
        changed.add(documentUri)
      }

      for (const [key, value] of found) {
        diagnostics.set(key, value)
      }

      return [...changed]
    },
    refreshFromCache: async () => {
      replaceMap(groupByUri(await runFromCache(session), paths))
    },
    reloadConfig: async () => {
      const replaced = session

      session = await createRunSession(runIo)

      // Close the old session last. If the new config fails to load, the folder keeps a usable one.
      await replaced.shutdown()
    },
    scheduleWorkspacePass: () => {
      if (scheduled !== undefined) {
        return
      }

      scheduled = setTimeout(() => {
        scheduled = undefined

        void (async () => {
          try {
            options.onChanged?.(replaceMap(groupByUri(await runFromCache(session), paths)))
          }
          catch (error) {
            options.io.stderr.write(`alint lsp: workspace pass failed: ${errorMessageFrom(error) ?? 'unknown error'}\n`)
          }
        })()
      }, WORKSPACE_PASS_DEBOUNCE_MS)
    },
  }
}

/** A project rule reports diagnostics for files it did not target, so group by the named file. */
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

async function runFromCache(
  session: RunSession,
  options: { inputs?: string[] } = {},
): Promise<RunResult> {
  try {
    return await session.run({
      cacheOnly: true,
      inputs: options.inputs,
      // An edit changes the project target's identity, so its jobs miss the cache at any scope.
      projectTargets: options.inputs === undefined ? undefined : false,
      // This pass runs on every load and save and calls no model. Do not record it as a run.
      runner: { ...session.runner, stats: false },
    })
  }
  catch (error) {
    // A failed run still carries the diagnostics it produced. Without them, one unreadable file
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
 * An editor matches diagnostics by exact URI. A resolved URI attaches them to a document the editor
 * did not open.
 */
function toDocumentUri(filePath: string, paths: { cwd: string, folderPath: string }): string {
  if (paths.cwd === paths.folderPath || !filePath.startsWith(`${paths.cwd}${sep}`)) {
    return pathToFileURL(filePath).toString()
  }

  return pathToFileURL(join(paths.folderPath, relative(paths.cwd, filePath))).toString()
}

/**
 * Converts a document URI into the path a run uses. The inverse of `toDocumentUri`.
 *
 * Returns undefined for a URI outside this folder. A server with several folders uses that to find
 * the folder that owns the file.
 */
function toRunPath(uri: string, paths: { cwd: string, folderPath: string }): string | undefined {
  const filePath = fileURLToPath(uri)

  if (!filePath.startsWith(`${paths.folderPath}${sep}`)) {
    return undefined
  }

  return join(paths.cwd, relative(paths.folderPath, filePath))
}
