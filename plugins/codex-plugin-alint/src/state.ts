import type { FindingSummary, SessionState } from './types'

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isNodeErrorCode } from '@alint-js/utils/node'

const retentionMs = 365 * 24 * 60 * 60 * 1000
const stateSchemaVersion = 2

export interface StateStore {
  load: (sessionId: string) => Promise<SessionState>
  save: (sessionId: string, state: SessionState) => Promise<void>
}

export function createStateStore(
  pluginDataDirectory: string,
  now: () => Date = () => new Date(),
): StateStore {
  const stopGateDirectory = join(pluginDataDirectory, 'stop-gate')
  const sessionsDirectory = join(stopGateDirectory, `sessions-v${stateSchemaVersion}`)

  return {
    async load(sessionId) {
      const statePath = getStatePath(sessionsDirectory, sessionId)

      try {
        return parseState(JSON.parse(await readFile(statePath, 'utf8')))
      }
      catch (error) {
        if (isNodeErrorCode(error, 'ENOENT')) {
          return emptyState()
        }

        throw error
      }
    },
    async save(sessionId, state) {
      const statePath = getStatePath(sessionsDirectory, sessionId)
      const tempPath = join(sessionsDirectory, `${sessionId}-${randomUUID()}.tmp`)
      await mkdir(sessionsDirectory, { recursive: true })
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(tempPath, statePath)
      await pruneExpiredStateDirectories(stopGateDirectory, now().getTime())
    },
  }
}

export function emptyState(): SessionState {
  return {
    lintRounds: 0,
    runtimeFailures: 0,
    schemaVersion: stateSchemaVersion,
    updatedAt: new Date(0).toISOString(),
  }
}

function getStatePath(directory: string, sessionId: string): string {
  if (
    sessionId === '.'
    || sessionId === '..'
    || !/^[\w.-]+$/u.test(sessionId)
  ) {
    throw new Error('Invalid Stop hook session id.')
  }

  return join(directory, `${sessionId}.json`)
}

function isFindingSummary(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const finding = value as Partial<FindingSummary>
  return Number.isInteger(finding.errorCount)
    && (finding.errorCount ?? -1) >= 0
    && typeof finding.findingsHash === 'string'
    && /^[a-f0-9]{64}$/u.test(finding.findingsHash)
    && typeof finding.reportPath === 'string'
    && (finding.status === 'errors' || finding.status === 'warnings')
    && Number.isInteger(finding.warningCount)
    && (finding.warningCount ?? -1) >= 0
}

function parseState(value: unknown): SessionState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid Stop Gate session state.')
  }

  const state = value as Partial<SessionState>

  if (
    state.schemaVersion !== 2
    || !Number.isInteger(state.lintRounds)
    || (state.lintRounds ?? -1) < 0
    || !Number.isInteger(state.runtimeFailures)
    || (state.runtimeFailures ?? -1) < 0
    || typeof state.updatedAt !== 'string'
  ) {
    throw new TypeError('Invalid Stop Gate session state.')
  }

  if (state.lastFindings !== undefined && !isFindingSummary(state.lastFindings)) {
    throw new TypeError('Invalid Stop Gate session state.')
  }

  return state as SessionState
}

async function pruneExpiredStateDirectories(directory: string, nowMs: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^sessions(?:-v\d+)?$/u.test(entry.name)) {
      continue
    }

    await pruneExpiredStates(join(directory, entry.name), nowMs)
  }
}

async function pruneExpiredStates(directory: string, nowMs: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    const path = join(directory, entry.name)
    const file = await stat(path)

    if (nowMs - file.mtimeMs > retentionMs) {
      await rm(path, { force: true })
    }
  }
}
