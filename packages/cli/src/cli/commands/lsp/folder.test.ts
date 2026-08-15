import type { Diagnostic, RunResult } from '@alint-js/core'

import type { CliIo } from '../../types'

import process from 'node:process'

import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
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
    // This pass runs on every workspace load. It must call no model and record no run.
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
    // `process.cwd()` returns a canonical path, so the lint command always runs under one. Under
    // the client path, a symlinked folder gives every target a different key.
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
    // A project rule reports two files in one pass. Each diagnostic goes to the file it names.
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

describe('folderSession.refreshFile', () => {
  it('lints the saved file under the run path, not the path the client sent', async () => {
    // The client sends a URI under the folder it opened. Discovery runs under the resolved path,
    // so an unconverted path matches no file and the pass lints nothing.
    const { io, linkPath } = await createSymlinkedFolder()
    const resolvedCwd = await realpath(linkPath)
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri: pathToFileURL(linkPath).toString(), io })

    try {
      await folder.refreshFile(pathToFileURL(join(linkPath, 'date.ts')).toString())

      expect(runAlint.mock.calls[0]?.[0]?.files).toEqual([join(resolvedCwd, 'date.ts')])
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('reads the cache and skips project targets', async () => {
    // An edit changes the project target's identity, so its jobs miss the cache at any scope.
    const { cwd, folderUri, io } = await createFolder()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      // Built from the folder the client opened, which is what didSave sends.
      await folder.refreshFile(pathToFileURL(join(cwd, 'date.ts')).toString())

      expect(runAlint.mock.calls[0]?.[0]?.cacheOnly).toBe(true)
      expect(runAlint.mock.calls[0]?.[0]?.projectTargets).toBe(false)
      expect(runAlint.mock.calls[0]?.[0]?.runner?.stats).toBe(false)
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('reports the saved file as changed when its diagnostics disappear', async () => {
    // The usual result after an edit: the changed target misses the cache and its job is skipped.
    // The editor drops the diagnostic only if the file is published again, empty.
    const { cwd, folderUri, io } = await createFolder()
    const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
    const runAlint = vi.spyOn(alintCore, 'runAlint')
      .mockResolvedValueOnce(runResultWith([{
        filePath: join(cwd, 'date.ts'),
        message: 'stale finding',
        ruleId: 'js/no-duplicated-helper',
        severity: 'warn',
      }]))
      .mockResolvedValueOnce(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.refreshFromCache()
      expect(folder.diagnostics.get(dateUri)).toHaveLength(1)

      const changed = await folder.refreshFile(dateUri)

      expect(changed).toEqual([dateUri])
      expect(folder.diagnostics.has(dateUri)).toBe(false)
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('leaves every other file alone', async () => {
    const { cwd, folderUri, io } = await createFolder()
    const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
    const reportUri = pathToFileURL(join(cwd, 'report.ts')).toString()
    const runAlint = vi.spyOn(alintCore, 'runAlint')
      .mockResolvedValueOnce(runResultWith([
        { filePath: join(cwd, 'date.ts'), message: 'on date', ruleId: 'r', severity: 'warn' },
        { filePath: join(cwd, 'report.ts'), message: 'on report', ruleId: 'r', severity: 'warn' },
      ]))
      .mockResolvedValueOnce(runResultWith([
        { filePath: join(cwd, 'date.ts'), message: 'still on date', ruleId: 'r', severity: 'warn' },
      ]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.refreshFromCache()
      await folder.refreshFile(dateUri)

      expect(folder.diagnostics.get(dateUri)?.[0]?.message).toBe('still on date')
      expect(folder.diagnostics.get(reportUri)?.[0]?.message).toBe('on report')
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('ignores a uri outside the folder', async () => {
    const { folderUri, io } = await createFolder()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      const changed = await folder.refreshFile(pathToFileURL('/elsewhere/date.ts').toString())

      expect(changed).toEqual([])
      expect(runAlint).not.toHaveBeenCalled()
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })
})

describe('folderSession.scheduleWorkspacePass', () => {
  it('coalesces a burst of requests into one pass', async () => {
    // One config write arrives as several events. One pass per event repeats the same work.
    const { folderUri, io } = await createFolder()
    const changed: string[][] = []
    let passed: (uris: string[]) => void = () => {}
    // The pass reads the filesystem, which fake timers do not drive. Advancing the clock starts
    // the pass; this promise waits for it to finish.
    const nextPass = new Promise<string[]>((resolve) => {
      passed = resolve
    })
    const folder = await createFolderSession({
      folderUri,
      io,
      onChanged: (uris) => {
        changed.push(uris)
        passed(uris)
      },
    })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))

    vi.useFakeTimers()

    try {
      folder.scheduleWorkspacePass()
      folder.scheduleWorkspacePass()
      folder.scheduleWorkspacePass()

      expect(runAlint).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(500)
      await nextPass

      expect(runAlint).toHaveBeenCalledTimes(1)
      expect(changed).toHaveLength(1)
    }
    finally {
      vi.useRealTimers()
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('reports every document the pass touched, including ones it emptied', async () => {
    const { cwd, folderUri, io } = await createFolder()
    const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
    const changed: string[][] = []
    let passed: (uris: string[]) => void = () => {}
    const nextPass = new Promise<string[]>((resolve) => {
      passed = resolve
    })
    const folder = await createFolderSession({
      folderUri,
      io,
      onChanged: (uris) => {
        changed.push(uris)
        passed(uris)
      },
    })
    const runAlint = vi.spyOn(alintCore, 'runAlint')
      .mockResolvedValueOnce(runResultWith([
        { filePath: join(cwd, 'date.ts'), message: 'first', ruleId: 'r', severity: 'warn' },
      ]))
      .mockResolvedValueOnce(runResultWith([]))

    try {
      await folder.refreshFromCache()

      vi.useFakeTimers()
      folder.scheduleWorkspacePass()
      await vi.advanceTimersByTimeAsync(500)
      await nextPass

      expect(changed.at(-1)).toEqual([dateUri])
      expect(folder.diagnostics.has(dateUri)).toBe(false)
    }
    finally {
      vi.useRealTimers()
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('drops a scheduled pass when the folder is disposed', async () => {
    // A pass that starts after disposal runs against a closed session.
    const { folderUri, io } = await createFolder()
    const folder = await createFolderSession({ folderUri, io })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))

    vi.useFakeTimers()

    try {
      folder.scheduleWorkspacePass()
      await folder.dispose()
      await vi.advanceTimersByTimeAsync(500)

      expect(runAlint).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
      runAlint.mockRestore()
    }
  })
})

describe('folderSession.reloadConfig', () => {
  it('re-reads the config file and runs a fresh pass against it', async () => {
    // c12 loads through jiti with `moduleCache: false`, so a new session reads the file again
    // instead of reusing the module it imported before.
    const { cwd, folderUri, io } = await createFolder()
    const folder = await createFolderSession({ folderUri, io })
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))

    try {
      await folder.refreshFromCache()

      const before = runAlint.mock.calls[0]?.[0]?.runner?.cache

      await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    runner: { cache: { location: '.reloaded-alintcache' } },
    plugins: { company: { rules: {} } },
  },
]
`)

      await folder.reloadConfig()
      await folder.refreshFromCache()

      expect(before).toEqual({ location: '.project-alintcache' })
      expect(runAlint.mock.calls.at(-1)?.[0]?.runner?.cache).toEqual({ location: '.reloaded-alintcache' })
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('shuts the previous session down so its gateway does not leak', async () => {
    const { folderUri, io } = await createFolder()
    const folder = await createFolderSession({ folderUri, io })

    await folder.reloadConfig()
    await folder.dispose()

    // The replaced session is already closed, and the current one closes exactly once.
    await expect(folder.dispose()).resolves.toBeUndefined()
  })
})

describe('folderSession.runExplicit', () => {
  it('calls models and records the run', async () => {
    // Passive passes read the cache and disable stats. This path spends, so it records the run.
    const { folderUri, io } = await createFolder()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.runExplicit({})

      expect(runAlint.mock.calls[0]?.[0]?.cacheOnly).toBeFalsy()
      expect(runAlint.mock.calls[0]?.[0]?.runner?.stats).not.toBe(false)
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('runs one file under the run path and leaves project rules out', async () => {
    // The user asked for one file. A project rule would plan the whole project and bill for it.
    const { io, linkPath } = await createSymlinkedFolder()
    const resolvedCwd = await realpath(linkPath)
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri: pathToFileURL(linkPath).toString(), io })

    try {
      await folder.runExplicit({ files: [pathToFileURL(join(linkPath, 'date.ts')).toString()] })

      expect(runAlint.mock.calls[0]?.[0]?.files).toEqual([join(resolvedCwd, 'date.ts')])
      expect(runAlint.mock.calls[0]?.[0]?.projectTargets).toBe(false)
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('keeps project rules for a workspace run', async () => {
    const { folderUri, io } = await createFolder()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.runExplicit({})

      expect(runAlint.mock.calls[0]?.[0]?.projectTargets).not.toBe(false)
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('publishes each finding as it arrives instead of only at the end', async () => {
    // A workspace run takes minutes. Each diagnostic must reach the editor when it arrives.
    const { cwd, folderUri, io } = await createFolder()
    const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
    const seen: string[][] = []
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockImplementation(async (options) => {
      options?.progress?.onDiagnostic?.({
        diagnostic: {
          filePath: join(cwd, 'date.ts'),
          message: 'streamed',
          ruleId: 'r',
          severity: 'warn',
        },
        job: {} as never,
        progress: {} as never,
      })

      return runResultWith([])
    })
    const folder = await createFolderSession({ folderUri, io, onChanged: uris => seen.push(uris) })

    try {
      await folder.runExplicit({})

      expect(seen[0]).toEqual([dateUri])
      expect(folder.diagnostics.get(dateUri)?.[0]?.message).toBe('streamed')
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('keeps the findings a failed run produced', async () => {
    const { cwd, folderUri, io } = await createFolder()
    const partial = runResultWith([
      { filePath: join(cwd, 'date.ts'), message: 'paid for', ruleId: 'r', severity: 'warn' },
    ])
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockRejectedValue(
      new alintCore.AlintRunError('a rule threw', partial),
    )
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.runExplicit({})

      expect([...folder.diagnostics.values()].flat()[0]?.message).toBe('paid for')
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })
})

describe('folderSession.runExplicit progress and cancellation', () => {
  it('reports how far the run has got', async () => {
    const { folderUri, io } = await createFolder()
    const reported: Array<{ inputPath: string, percentage: number }> = []
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockImplementation(async (options) => {
      options?.progress?.onJobStart?.({
        job: { id: 'j', index: 0, inputPath: 'date.ts', ruleId: 'r', target: { identity: 'file', kind: 'file' } },
        progress: { jobsCompleted: 3, jobsTotal: 12 } as never,
      })

      return runResultWith([])
    })
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.runExplicit({
        onProgress: (progress, inputPath) => reported.push({
          inputPath,
          percentage: Math.round((progress.jobsCompleted / progress.jobsTotal) * 100),
        }),
      })

      expect(reported).toEqual([{ inputPath: 'date.ts', percentage: 25 }])
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('passes the caller signal to the run', async () => {
    // The signal reaches the model call, not only the scheduler. Without it, a cancelled run
    // keeps spending until every job ends.
    const { folderUri, io } = await createFolder()
    const controller = new AbortController()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.runExplicit({ signal: controller.signal })

      expect(runAlint.mock.calls[0]?.[0]?.signal).toBe(controller.signal)
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('publishes what a cancelled run already produced', async () => {
    const { cwd, folderUri, io } = await createFolder()
    const partial = runResultWith([
      { filePath: join(cwd, 'date.ts'), message: 'paid for before cancel', ruleId: 'r', severity: 'warn' },
    ])
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockRejectedValue(
      new alintCore.AlintAbortError(partial),
    )
    const folder = await createFolderSession({ folderUri, io })

    try {
      await folder.runExplicit({})

      expect([...folder.diagnostics.values()].flat()[0]?.message).toBe('paid for before cancel')
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })
})

describe('folderSession run concurrency', () => {
  it('runs one explicit run at a time', async () => {
    // The cache file is rewritten whole, so two runs at once discard each other's paid results.
    const { folderUri, io } = await createFolder()
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const runAlint = vi.spyOn(alintCore, 'runAlint')
      .mockImplementationOnce(async () => {
        order.push('first start')
        await firstStarted
        order.push('first end')
        return runResultWith([])
      })
      .mockImplementationOnce(async () => {
        order.push('second start')
        return runResultWith([])
      })
    const folder = await createFolderSession({ folderUri, io })

    try {
      const first = folder.runExplicit({})
      const second = folder.runExplicit({})

      await new Promise(resolve => setTimeout(resolve, 20))
      releaseFirst()
      await Promise.all([first, second])

      expect(order).toEqual(['first start', 'first end', 'second start'])
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('skips a cache pass while an explicit run is in flight', async () => {
    // The explicit run is already publishing newer diagnostics. A cache read would publish older
    // values over them.
    const { folderUri, io } = await createFolder()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const runAlint = vi.spyOn(alintCore, 'runAlint')
      .mockImplementationOnce(async () => {
        await held
        return runResultWith([])
      })
      .mockResolvedValue(runResultWith([]))
    const folder = await createFolderSession({ folderUri, io })

    try {
      const explicit = folder.runExplicit({})
      await new Promise(resolve => setTimeout(resolve, 20))

      await folder.refreshFromCache()

      expect(runAlint).toHaveBeenCalledTimes(1)

      release()
      await explicit
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })
})

describe('folderSession.clearCache', () => {
  it('deletes the cache file and reports every document it emptied', async () => {
    const { cwd, folderUri, io } = await createFolder()
    const dateUri = pathToFileURL(join(cwd, 'date.ts')).toString()
    const runAlint = vi.spyOn(alintCore, 'runAlint').mockResolvedValue(runResultWith([
      { filePath: join(cwd, 'date.ts'), message: 'cached', ruleId: 'r', severity: 'warn' },
    ]))
    const folder = await createFolderSession({ folderUri, io })
    const cachePath = join(await realpath(cwd), '.project-alintcache')

    await writeFile(cachePath, '{}')

    try {
      await folder.refreshFromCache()
      expect(folder.diagnostics.has(dateUri)).toBe(true)

      const changed = await folder.clearCache()

      expect(changed).toEqual([dateUri])
      expect(folder.diagnostics.size).toBe(0)
      await expect(readFile(cachePath, 'utf8')).rejects.toThrow()
    }
    finally {
      runAlint.mockRestore()
      await folder.dispose()
    }
  })

  it('succeeds when no cache file was ever written', async () => {
    // A project that has never run, or one with caching turned off, has no file to delete.
    const { folderUri, io } = await createFolder()
    const folder = await createFolderSession({ folderUri, io })

    try {
      await expect(folder.clearCache()).resolves.toEqual([])
    }
    finally {
      await folder.dispose()
    }
  })
})
