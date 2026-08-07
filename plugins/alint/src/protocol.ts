import type { Command } from './resolve-command'
import type { StopGateEnvelope } from './types'

import { Buffer } from 'node:buffer'

import { x } from 'tinyexec'

export const startupTimeoutMs = 60_000

const maximumStopGateTimeoutMs = (23 * 60 + 55) * 60 * 1000
const stderrExcerptLimitBytes = 4 * 1024
const stderrTruncationMarker = '\n... stderr truncated ...\n'

export interface ProbedStopGateConfig {
  enabled: boolean
  target: 'all' | 'dirty-files'
  timeoutMs: number
}

export async function executeStopGate(
  command: Command,
  gitRoot: string,
  sessionId: string,
  lintTimeoutMs: number,
): Promise<StopGateEnvelope> {
  const timeout = createLongTimeout(addStartupAllowance(lintTimeoutMs))
  const execution = x(command.executable, [
    ...command.args,
    'integrations',
    'stop-gate',
    '--session-id',
    sessionId,
  ], {
    nodeOptions: { cwd: gitRoot },
    nodePath: false,
    signal: timeout.signal,
  })
  let result

  try {
    result = await execution
  }
  finally {
    timeout.dispose()
  }

  if (execution.aborted) {
    throw new Error('alint did not finish within its configured lint timeout plus the 1 minute startup allowance.')
  }

  const envelope = parseEnvelope(result.stdout)

  if (envelope === undefined) {
    if (result.exitCode === 1) {
      throw new Error(abnormalAlintMessage(result.stderr))
    }

    throw incompatibleAlintError()
  }

  if (!isExpectedStopGateExitCode(result.exitCode, envelope.status)) {
    throw new Error(`alint Stop Gate returned status "${envelope.status}" with unexpected exit code ${result.exitCode ?? 'unknown'}.`)
  }

  return envelope
}

export function parseConfigOutput(stdout: string): ProbedStopGateConfig | undefined {
  const enabled = /^enabled: (true|false)(?: |$)/mu.exec(stdout)?.[1]
  const target = /^target: (all|dirty-files)(?: |$)/mu.exec(stdout)?.[1]
  const timeoutMs = Number(/^timeoutMs: (\S+)/mu.exec(stdout)?.[1])

  if (
    enabled === undefined
    || (target !== 'all' && target !== 'dirty-files')
    || !Number.isInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > maximumStopGateTimeoutMs
  ) {
    return undefined
  }

  return { enabled: enabled === 'true', target, timeoutMs }
}

export function parseEnvelope(stdout: string): StopGateEnvelope | undefined {
  let value: unknown

  try {
    value = JSON.parse(stdout.trim())
  }
  catch {
    return undefined
  }

  if (!isEnvelopeRecord(value)) {
    return undefined
  }

  const base = {
    errorCount: value.errorCount,
    schemaVersion: 2 as const,
    warningCount: value.warningCount,
  }

  if (value.status === 'clean' || value.status === 'inactive' || value.status === 'no-dirty-files') {
    return value.errorCount === 0 && value.warningCount === 0
      ? { ...base, status: value.status }
      : undefined
  }

  if (value.status === 'runtime-error') {
    return value.errorCount === 0
      && value.warningCount === 0
      && typeof value.message === 'string'
      && value.message.length > 0
      ? { ...base, message: value.message, status: value.status }
      : undefined
  }

  if (value.status === 'errors' || value.status === 'warnings') {
    const validCounts = value.status === 'errors'
      ? value.errorCount > 0
      : value.errorCount === 0 && value.warningCount > 0

    return validCounts
      && typeof value.findingsHash === 'string'
      && /^[a-f0-9]{64}$/u.test(value.findingsHash)
      && typeof value.reportPath === 'string'
      && value.reportPath.length > 0
      ? {
          ...base,
          findingsHash: value.findingsHash,
          reportPath: value.reportPath,
          status: value.status,
        }
      : undefined
  }

  return undefined
}

export async function probeStopGateConfig(
  command: Command,
  gitRoot: string,
  deadline: number,
): Promise<ProbedStopGateConfig | undefined> {
  const remainingMs = deadline - Date.now()

  if (remainingMs <= 0) {
    throw packageManagerTimeoutError(command)
  }

  let execution

  try {
    execution = x(command.executable, [
      ...command.args,
      'config',
      'integrations',
      'stop-gate',
      'show',
    ], commandOptions(gitRoot, remainingMs))
    const result = await execution

    if (execution.killed) {
      throw packageManagerTimeoutError(command)
    }

    if (result.exitCode !== 0) {
      if (command.source === 'local') {
        throw repositoryConfigError(result)
      }

      return undefined
    }

    if (result.stdout.trim().length === 0) {
      throw emptyConfigOutputError(result.stderr)
    }

    const config = parseConfigOutput(result.stdout)

    if (config === undefined) {
      throw incompatibleAlintError()
    }

    return config
  }
  catch (error) {
    if (execution?.killed) {
      throw packageManagerTimeoutError(command)
    }

    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

function abnormalAlintMessage(stderr: string): string {
  const detail = truncateStderr(stderr.trim())

  return detail.length === 0
    ? 'alint Stop Gate exited abnormally with exit code 1 and produced no stderr output.'
    : `alint Stop Gate exited abnormally with exit code 1: ${detail}`
}

function addStartupAllowance(lintTimeoutMs: number): number {
  // NOTICE: The public config limit reserves five minutes beneath Codex's 24-hour hook timeout.
  // One of those minutes belongs here so CLI startup does not consume the configured lint budget;
  // the remaining reserve covers Git discovery, CLI probing, state I/O, and scheduling overhead.
  return Math.min(lintTimeoutMs + startupTimeoutMs, Number.MAX_SAFE_INTEGER)
}

function commandOptions(cwd: string, timeout: number) {
  return {
    nodeOptions: { cwd },
    nodePath: false,
    timeout,
  } as const
}

function createLongTimeout(timeoutMs: number): { dispose: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  let remainingMs = timeoutMs
  let timer: NodeJS.Timeout | undefined

  const schedule = () => {
    const delay = Math.min(remainingMs, 2_147_483_647)
    timer = setTimeout(() => {
      remainingMs -= delay

      if (remainingMs > 0) {
        schedule()
        return
      }

      controller.abort(new DOMException('alint Stop Gate timed out.', 'TimeoutError'))
    }, delay)
  }

  schedule()

  return {
    dispose: () => clearTimeout(timer),
    signal: controller.signal,
  }
}

function emptyConfigOutputError(stderr: string): Error {
  const detail = truncateStderr(stderr.trim())
  const stderrContext = detail.length === 0 ? '' : ` alint wrote to stderr: ${detail}`

  return new Error(`alint exited successfully but produced no Stop Gate configuration output. Run \`alint config integrations stop-gate show\` manually and make sure it writes the resolved configuration to stdout.${stderrContext}`)
}

function incompatibleAlintError(): Error {
  return new Error('The resolved alint CLI does not support the Stop Gate protocol. Update @alint-js/cli before using this plugin.')
}

function isEnvelopeRecord(value: unknown): value is Record<string, unknown> & {
  errorCount: number
  schemaVersion: 2
  warningCount: number
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const record = value as Record<string, unknown>
  return record.schemaVersion === 2
    && typeof record.errorCount === 'number'
    && Number.isInteger(record.errorCount)
    && record.errorCount >= 0
    && typeof record.warningCount === 'number'
    && Number.isInteger(record.warningCount)
    && record.warningCount >= 0
}

function isExpectedStopGateExitCode(exitCode: number | undefined, status: StopGateEnvelope['status']): boolean {
  return exitCode === (status === 'runtime-error' ? 1 : 0)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function packageManagerTimeoutError(command: Command): Error {
  const subject = command.source === 'package-manager'
    ? `${command.executable} package-manager exec`
    : `${command.executable} startup`
  return new Error(`${subject} exceeded the 1 minute startup limit. Run the Stop Gate config command manually and fix the local installation before retrying.`)
}

function repositoryConfigError(result: { exitCode?: number, stderr: string }): Error {
  const detail = truncateStderr(result.stderr.trim())
  const exitCode = result.exitCode ?? 'unknown'
  const reason = detail.length === 0
    ? `exit code ${exitCode} with no stderr output`
    : `exit code ${exitCode}: ${detail}`

  return new Error(`The repository-local alint could not read Stop Gate configuration due to ${reason}. Run \`alint config integrations stop-gate show\` manually.`)
}

function truncateStderr(stderr: string): string {
  const bytes = Buffer.from(stderr, 'utf8')

  if (bytes.length <= stderrExcerptLimitBytes) {
    return stderr
  }

  const markerBytes = Buffer.byteLength(stderrTruncationMarker)
  const excerptBytes = stderrExcerptLimitBytes - markerBytes
  const headBytes = Math.ceil(excerptBytes / 2)
  const tailBytes = Math.floor(excerptBytes / 2)
  let headEnd = headBytes
  let tailStart = bytes.length - tailBytes

  // Byte budgets may land inside a UTF-8 continuation sequence. Move both cuts inward so the
  // excerpt never substitutes a split code point with U+FFFD or exceeds the agreed byte limit.
  while (headEnd > 0 && ((bytes[headEnd] ?? 0) & 0xC0) === 0x80) {
    headEnd -= 1
  }
  while (tailStart < bytes.length && ((bytes[tailStart] ?? 0) & 0xC0) === 0x80) {
    tailStart += 1
  }

  return `${bytes.toString('utf8', 0, headEnd)}${stderrTruncationMarker}${bytes.toString('utf8', tailStart)}`
}
