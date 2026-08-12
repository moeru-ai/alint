import type { Diagnostic, RunResult } from '@alint-js/core'

import type { CliIo } from '../../types'

import process from 'node:process'

import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import * as alintCore from '@alint-js/core'

import { WHOLE_LINE } from './diagnostics'
import { createFolderSession } from './folder'

async function createFolder(): Promise<{ cwd: string, folderUri: string, io: CliIo }> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-folder-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-folder-home-'))

  await writeFile(join(cwd, 'date.ts'), 'export function format() {\n  return 1\n}\n')
  await writeFile(join(cwd, 'report.ts'), 'export function render() {\n  return 2\n}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    runner: { cache: { location: '.project-alintcache' } },
    plugins: {
      company: { rules: {} },
    },
  },
]
`)

  return {
    cwd,
    // The server receives URIs, not paths.
    folderUri: pathToFileURL(cwd).toString(),
    io: {
      cwd: process.cwd(),
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
      stderr: { write: () => true },
      stdout: { write: () => true },
    },
  }
}

/**
 * The same fixture behind a directory symlink.
 *
 * `/tmp` is a real directory on Linux and a symlink on macOS. Only an explicit link tests the
 * resolved path against the opened path on both systems.
 */
async function createSymlinkedFolder(): Promise<{ io: CliIo, linkPath: string }> {
  const { cwd, io } = await createFolder()
  const linkPath = `${cwd}-link`

  await symlink(cwd, linkPath, 'dir')

  return { io, linkPath }
}

function runResultWith(diagnostics: Diagnostic[]): RunResult {
  return {
    diagnostics,
    execution: {
      cached: 0,
      cancelled: 0,
      completed: 0,
      failed: 0,
      planned: 0,
      queued: 0,
      running: 0,
      skipped: 0,
    },
    usage: { inputTokens: 0, outputTokens: 0, records: [], totalTokens: 0 },
  }
}

describe('createFolderSession', () => {
  it('runs the workspace pass with cacheOnly and stats disabled', async () => {
    // This pass runs on every workspace load. It must spend nothing and record nothing.
    const { folderUri, io } = await createFolder()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.refreshFromCache()

      expect(runAlint).toHaveBeenCalledWith(expect.objectContaining({
        cacheOnly: true,
        cwd: folder.cwd,
      }))
      expect(runAlint.mock.calls[0]?.[0]?.runner?.stats).toBe(false)
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('keeps the project cache location so the editor reads the CLI cache file', async () => {
    // A different cache location gives an empty editor with no error.
    const { folderUri, io } = await createFolder()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.refreshFromCache()

      expect(runAlint.mock.calls[0]?.[0]?.runner?.cache).toEqual({ location: '.project-alintcache' })
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('runs in the resolved folder root, not the process cwd', async () => {
    // `process.cwd()` returns a canonical path, so the lint command always runs under one. If the
    // server used the client path, a symlinked folder would give every target a different key.
    const { cwd, folderUri, io } = await createFolder()
    const folder = await createFolderSession({ folderUri, io })

    try {
      expect(folder.cwd).not.toBe(io.cwd)
      expect(folder.cwd).toBe(await realpath(cwd))
    }
    finally {
      await folder.dispose()
    }
  })

  // Creating a directory symlink needs elevation or Developer Mode on Windows.
  it.skipIf(process.platform === 'win32')('publishes under the path the client opened, not the resolved one', async () => {
    // An editor matches diagnostics by exact URI.
    const { io, linkPath } = await createSymlinkedFolder()
    const resolvedCwd = await realpath(linkPath)
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([{
      filePath: join(resolvedCwd, 'date.ts'),
      message: 'helper is duplicated',
      ruleId: 'js/no-duplicated-helper',
      severity: 'warn',
    }]))
    const folder = await createFolderSession({ folderUri: pathToFileURL(linkPath).toString(), io })

    try {
      await folder.refreshFromCache()

      expect(folder.cwd).toBe(resolvedCwd)
      expect([...folder.diagnostics.keys()]).toEqual([
        pathToFileURL(join(linkPath, 'date.ts')).toString(),
      ])
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('addresses each finding to the file it names, not the target that produced it', async () => {
    // A project rule reports two files in one pass. Each diagnostic goes to its own document.
    const { cwd, folderUri, io } = await createFolder()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([
      {
        filePath: join(cwd, 'date.ts'),
        loc: { end: { column: 9, line: 1 }, start: { column: 0, line: 1 } },
        message: 'helper is duplicated in report.ts',
        ruleId: 'js/no-duplicated-helper',
        severity: 'warn',
      },
      {
        filePath: join(cwd, 'report.ts'),
        loc: { start: { column: 0, line: 2 } },
        message: 'helper is duplicated in date.ts',
        ruleId: 'js/no-duplicated-helper',
        severity: 'error',
      },
    ]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.refreshFromCache()

      const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
      const reportUri = pathToFileURL(join(cwd, 'report.ts')).toString()

      expect([...folder.diagnostics.keys()].sort()).toEqual([dateUri, reportUri].sort())
      expect(folder.diagnostics.get(dateUri)).toEqual([{
        code: 'js/no-duplicated-helper',
        message: 'helper is duplicated in report.ts',
        range: { end: { character: 9, line: 0 }, start: { character: 0, line: 0 } },
        severity: 2,
        source: 'alint',
      }])
      expect(folder.diagnostics.get(reportUri)).toEqual([{
        code: 'js/no-duplicated-helper',
        message: 'helper is duplicated in date.ts',
        range: { end: { character: WHOLE_LINE, line: 1 }, start: { character: 0, line: 1 } },
        severity: 1,
        source: 'alint',
      }])
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('keeps the findings a failed run did produce', async () => {
    // One unreadable file must not clear the diagnostics of every other file.
    const { cwd, folderUri, io } = await createFolder()
    const partial = runResultWith([{
      filePath: join(cwd, 'date.ts'),
      message: 'survived the failure',
      ruleId: 'js/no-duplicated-helper',
      severity: 'warn',
    }])
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockRejectedValue(
      new alintCore.AlintRunError('one file failed to read', partial),
    )
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.refreshFromCache()

      expect([...folder.diagnostics.values()].flat()).toHaveLength(1)
      expect([...folder.diagnostics.values()].flat()[0]?.message).toBe('survived the failure')
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })
})
