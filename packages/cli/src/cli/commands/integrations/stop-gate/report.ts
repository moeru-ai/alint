import type { AlintRunFailure, RunResult, StopGateTarget } from '@alint-js/core'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isNodeErrorCode } from '@alint-js/utils/node'

const reportFileName = 'report.json'
const reportLimitBytes = 100 * 1024 * 1024
const stopGateTempRoot = join(tmpdir(), 'alint-stop-gate')

export interface StopGateReport {
  cwd: string
  diagnostics: RunResult['diagnostics']
  execution: RunResult['execution']
  failure?: {
    details: AlintRunFailure[]
    message: string
  }
  files: string[]
  schemaVersion: 1
  target: StopGateTarget
  usage: RunResult['usage']
}

export class StopGateReportTooLargeError extends Error {
  constructor() {
    super('Stop Gate report exceeds the 100 MB limit.')
    this.name = 'StopGateReportTooLargeError'
  }
}

export async function removeStopGateReport(sessionId: string): Promise<void> {
  await rm(getReportPath(sessionId), { force: true })
}

export async function writeStopGateReport(
  sessionId: string,
  report: StopGateReport,
): Promise<string> {
  const content = `${JSON.stringify(report, null, 2)}\n`

  if (Buffer.byteLength(content) > reportLimitBytes) {
    throw new StopGateReportTooLargeError()
  }

  const sessionDirectory = getSessionDirectory(sessionId)
  const reportPath = getReportPath(sessionId)
  const tempPath = join(sessionDirectory, `report-${randomUUID()}.tmp`)
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o644 })
  await chmod(tempPath, 0o644)
  await rename(tempPath, reportPath)
  await enforceReportBudget(reportPath)
  return reportPath
}

async function enforceReportBudget(currentReportPath: string): Promise<void> {
  let entries

  try {
    entries = await readdir(stopGateTempRoot, { withFileTypes: true })
  }
  catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return
    }

    throw error
  }

  const reports = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const path = join(stopGateTempRoot, entry.name, reportFileName)

    try {
      const stats = await stat(path)
      reports.push({ mtimeMs: stats.mtimeMs, path, size: stats.size })
    }
    catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        throw error
      }
    }
  }

  let total = reports.reduce((sum, report) => sum + report.size, 0)

  for (const report of reports.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= reportLimitBytes) {
      break
    }

    if (report.path === currentReportPath) {
      continue
    }

    await rm(report.path, { force: true })
    total -= report.size
  }
}

function getReportPath(sessionId: string): string {
  return join(getSessionDirectory(sessionId), reportFileName)
}

function getSessionDirectory(sessionId: string): string {
  if (
    sessionId === '.'
    || sessionId === '..'
    || !/^[\w.-]+$/u.test(sessionId)
  ) {
    throw new Error('Invalid Stop hook session id.')
  }

  return join(stopGateTempRoot, sessionId)
}
