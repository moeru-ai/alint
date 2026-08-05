import type { StopGateEnvelope } from './types'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { x } from 'tinyexec'

const startupTimeoutMs = 60_000
const stderrExcerptLimitBytes = 4 * 1024
const stderrTruncationMarker = '\n... stderr truncated ...\n'

export interface ResolvedAlintStopGate {
  enabled: boolean
  run: (sessionId: string) => Promise<StopGateEnvelope>
}

interface Command {
  args: string[]
  executable: string
  source: 'local' | 'package-manager' | 'path'
}

interface ProbedStopGateConfig {
  enabled: boolean
  timeoutMs: number
}

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  const execution = x('git', ['rev-parse', '--show-toplevel'], commandOptions(cwd, startupTimeoutMs))
  const result = await execution

  if (execution.killed) {
    throw new Error('Git root discovery exceeded the 1 minute startup limit.')
  }

  if (result.exitCode !== 0) {
    return undefined
  }

  return result.stdout.trim() || undefined
}

export async function hasProjectConfig(gitRoot: string): Promise<boolean> {
  const entries = await readdir(gitRoot, { withFileTypes: true })

  return entries.some(entry => entry.isFile() && entry.name.startsWith('alint.config.'))
}

export async function resolveAlintStopGate(
  gitRoot: string,
): Promise<ResolvedAlintStopGate> {
  const commands = await resolveCommands(gitRoot)
  const startupDeadline = Date.now() + startupTimeoutMs

  for (const command of commands) {
    const config = await probeStopGateConfig(command, gitRoot, startupDeadline)

    if (config === undefined) {
      continue
    }

    return {
      enabled: config.enabled,
      run: sessionId => executeStopGate(command, gitRoot, sessionId, config.timeoutMs),
    }
  }

  throw new Error([
    'Could not find an alint CLI that supports `integrations stop-gate`.',
    'Ask the user for approval before installing or updating @alint-js/cli in this repository.',
  ].join(' '))
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

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode)
    return true
  }
  catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EACCES')) {
      return false
    }

    throw error
  }
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

async function detectPackageManager(gitRoot: string): Promise<'bun' | 'npm' | 'pnpm' | 'yarn' | undefined> {
  const packageManager = await readPackageManagerField(gitRoot)

  if (packageManager !== undefined) {
    return packageManager
  }

  const lockfiles = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ] as const

  for (const [lockfile, manager] of lockfiles) {
    if (await pathExists(join(gitRoot, lockfile))) {
      return manager
    }
  }

  return undefined
}

async function executeStopGate(
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

function incompatibleAlintError(): Error {
  return new Error('The resolved alint CLI does not support the Stop Gate protocol. Update @alint-js/cli before using this plugin.')
}

async function isExecutable(path: string): Promise<boolean> {
  return canAccess(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
}

function isExpectedStopGateExitCode(
  exitCode: number | undefined,
  status: StopGateEnvelope['status'],
): boolean {
  return exitCode === (status === 'runtime-error' ? 1 : 0)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isStopGateStatus(value: unknown): value is StopGateEnvelope['status'] {
  return value === 'clean'
    || value === 'errors'
    || value === 'inactive'
    || value === 'no-dirty-files'
    || value === 'runtime-error'
    || value === 'warnings'
}

function packageManagerCommand(manager: 'bun' | 'npm' | 'pnpm' | 'yarn'): Command {
  if (manager === 'npm') {
    return { args: ['exec', '--offline', '--yes=false', '--', 'alint'], executable: 'npm', source: 'package-manager' }
  }

  if (manager === 'bun') {
    return { args: ['x', '--no-install', 'alint'], executable: 'bun', source: 'package-manager' }
  }

  return { args: ['exec', 'alint'], executable: manager, source: 'package-manager' }
}

function packageManagerTimeoutError(command: Command): Error {
  const subject = command.source === 'package-manager'
    ? `${command.executable} package-manager exec`
    : `${command.executable} startup`
  return new Error(`${subject} exceeded the 1 minute startup limit. Run the Stop Gate config command manually and fix the local installation before retrying.`)
}

function parseEnvelope(stdout: string): StopGateEnvelope | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as Partial<StopGateEnvelope>

    if (
      value.schemaVersion !== 2
      || !isStopGateStatus(value.status)
      || typeof value.errorCount !== 'number'
      || typeof value.warningCount !== 'number'
      || ((value.status === 'errors' || value.status === 'warnings')
        && (typeof value.findingsHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.findingsHash)))
    ) {
      return undefined
    }

    return value as StopGateEnvelope
  }
  catch {
    return undefined
  }
}

function parseStopGateConfig(stdout: string): ProbedStopGateConfig | undefined {
  const enabled = /^enabled: (true|false)(?: |$)/mu.exec(stdout)?.[1]
  const timeoutMs = Number(/^timeoutMs: (\S+)/mu.exec(stdout)?.[1])

  if (enabled === undefined || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return undefined
  }

  return { enabled: enabled === 'true', timeoutMs }
}

async function pathExists(path: string): Promise<boolean> {
  return canAccess(path, constants.F_OK)
}

async function probeStopGateConfig(
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
        throw new Error('The repository-local alint could not read Stop Gate configuration. Run `alint config integrations stop-gate show` manually.')
      }

      return undefined
    }

    const config = parseStopGateConfig(result.stdout)

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

async function readPackageManagerField(gitRoot: string): Promise<'bun' | 'npm' | 'pnpm' | 'yarn' | undefined> {
  try {
    const packageJson = JSON.parse(await readFile(join(gitRoot, 'package.json'), 'utf8')) as { packageManager?: unknown }

    if (typeof packageJson.packageManager !== 'string') {
      return undefined
    }

    const name = packageJson.packageManager.split('@', 1)[0]
    return name === 'bun' || name === 'npm' || name === 'pnpm' || name === 'yarn'
      ? name
      : undefined
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

async function resolveCommands(gitRoot: string): Promise<Command[]> {
  const commands: Command[] = []
  const local = join(gitRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'alint.cmd' : 'alint')

  if (await isExecutable(local)) {
    commands.push({ args: [], executable: local, source: 'local' })
  }

  const packageManager = await detectPackageManager(gitRoot)

  if (packageManager !== undefined) {
    commands.push(packageManagerCommand(packageManager))
  }

  commands.push({ args: [], executable: 'alint', source: 'path' })
  return commands
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
