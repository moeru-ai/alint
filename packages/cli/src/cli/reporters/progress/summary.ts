import type {
  Diagnostic,
  DiagnosticProgressPayload,
  ProgressFilePath,
  ProgressReporter,
  RuleEndPayload,
  RuleStartPayload,
  RunEndPayload,
  RunStartPayload,
  TargetProgressPayload,
  UsageProgressPayload,
} from '@alint-js/core'

import { relative } from 'node:path'

import { createColors } from 'tinyrainbow'

const colors = createColors({ force: true })

export interface SummaryProgressReporter extends ProgressReporter {
  getRows: () => string[]
  tick: () => void
}

export interface SummaryProgressReporterOptions {
  color: boolean
  columns: number
  cwd?: string
  spinnerFrames: string[]
}

interface ActiveRuleState {
  id: string
  startedAt: number
  target: string
}

interface FileState {
  cached: number
  completed: number
  endedAt?: number
  errored: number
  file: ProgressFilePath
  rule?: ActiveRuleState
  startedAt?: number
  target?: string
}

interface SummaryState {
  cached: number
  completed: number
  diagnostics: Diagnostic[]
  endedAt?: number
  errored: number
  files: Map<string, FileState>
  planned: number
  runStartedAt?: number
  spinnerIndex: number
  totalTokens: number
}

export function createSummaryProgressReporter(options: SummaryProgressReporterOptions): SummaryProgressReporter {
  const now = Date.now
  const state: SummaryState = {
    cached: 0,
    completed: 0,
    diagnostics: [],
    errored: 0,
    files: new Map(),
    planned: 0,
    spinnerIndex: 0,
    totalTokens: 0,
  }

  return {
    getRows: () => createRows(state, options, now()),
    onDiagnostic: (payload: DiagnosticProgressPayload) => {
      state.diagnostics = payload.diagnostics
    },
    onFileEnd: (payload) => {
      const file = getFileState(state, payload.file)

      file.endedAt = payload.endedAt ?? now()
      file.rule = undefined
      file.target = undefined
    },
    onFileStart: (payload) => {
      const file = getFileState(state, payload.file)

      file.startedAt = payload.startedAt ?? now()
      file.endedAt = undefined
    },
    onRuleEnd: (payload: RuleEndPayload) => {
      const file = getFileState(state, payload.path.file)

      if (payload.cache === 'hit') {
        state.cached += 1
        file.cached += 1
      }

      if (payload.state === 'completed') {
        state.completed += 1
        file.completed += 1
      }

      if (payload.state === 'errored') {
        state.errored += 1
        file.errored += 1
      }

      if (file.rule?.id === payload.path.rule.id) {
        file.rule = undefined
      }
    },
    onRuleStart: (payload: RuleStartPayload) => {
      const file = getFileState(state, payload.path.file)

      file.startedAt ??= payload.startedAt ?? now()
      file.rule = {
        id: payload.path.rule.id,
        startedAt: payload.startedAt ?? now(),
        target: formatTarget(payload),
      }
      file.target = file.rule.target
    },
    onRunEnd: (payload: RunEndPayload) => {
      state.cached = payload.cached
      state.completed = payload.completed
      state.diagnostics = payload.diagnostics
      state.endedAt = payload.endedAt ?? now()
      state.errored = payload.errored
      state.planned = payload.planned
      state.runStartedAt = payload.startedAt ?? state.runStartedAt
      state.totalTokens = payload.usage.totalTokens
    },
    onRunStart: (payload: RunStartPayload) => {
      state.cached = 0
      state.completed = 0
      state.diagnostics = []
      state.endedAt = undefined
      state.errored = 0
      state.files = new Map()
      state.planned = payload.planned
      state.runStartedAt = payload.startedAt ?? now()
      state.spinnerIndex = 0
      state.totalTokens = 0

      for (const file of payload.files ?? []) {
        state.files.set(file.path, createFileState(file))
      }
    },
    onTargetEnd: (payload: TargetProgressPayload) => {
      const file = getFileState(state, payload.path.file)
      const target = formatTarget(payload)

      if (file.target === target) {
        file.target = undefined
      }
    },
    onTargetStart: (payload: TargetProgressPayload) => {
      const file = getFileState(state, payload.path.file)

      file.startedAt ??= payload.startedAt ?? now()
      file.target = formatTarget(payload)
    },
    onUsage: (payload: UsageProgressPayload) => {
      state.totalTokens = payload.total.totalTokens
    },
    tick: () => {
      state.spinnerIndex = (state.spinnerIndex + 1) % Math.max(options.spinnerFrames.length, 1)
    },
  }
}

function countDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity).length
}

function countQueuedFiles(state: SummaryState): number {
  return [...state.files.values()].filter(file =>
    file.startedAt === undefined && file.endedAt === undefined && (file.file.planned ?? 0) > 0,
  ).length
}

function createFileState(file: ProgressFilePath): FileState {
  return {
    cached: 0,
    completed: 0,
    errored: 0,
    file,
  }
}

function createRows(state: SummaryState, options: SummaryProgressReporterOptions, now: number): string[] {
  const activeFiles = getActiveFiles(state)
  const rows = activeFiles.flatMap(file => formatFileRows(file, state, options, now))
  const queued = countQueuedFiles(state)
  const warnCount = countDiagnostics(state.diagnostics, 'warn')
  const errorCount = countDiagnostics(state.diagnostics, 'error')
  const footer = formatFooter(state, warnCount, errorCount, queued, options, now)

  if (queued > 0) {
    rows.push(formatQueuedRow(queued, options))
  }

  if (rows.length === 0) {
    rows.push(formatIdleRow(state, options))
  }

  rows.push('', footer)

  return options.color
    ? rows.map(row => styleRow(row, state, warnCount, errorCount, options))
    : rows
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function estimateTotal(elapsedMs: number, completed: number, planned: number): number | undefined {
  if (completed <= 0 || planned <= 0) {
    return undefined
  }

  return elapsedMs * planned / completed
}

function fitRow(row: string, columns: number): string {
  if (columns <= 0)
    return ''

  if (row.length <= columns)
    return row

  if (columns === 1)
    return '…'

  return `${row.slice(0, columns - 1)}…`
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return '?'
  }

  return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`
}

function formatEstimatedDuration(ms: number | undefined): string {
  return `~${formatDuration(ms)}`
}

function formatFilePath(filePath: string, cwd: string | undefined): string {
  if (!cwd)
    return filePath

  return relative(cwd, filePath) || filePath
}

function formatFileRows(
  file: FileState,
  state: SummaryState,
  options: SummaryProgressReporterOptions,
  now: number,
): string[] {
  const firstRow = formatFileSummaryRow(file, state, options)

  if (!file.rule) {
    return [firstRow]
  }

  const elapsed = now - file.rule.startedAt
  const done = file.completed + file.cached + file.errored
  const estimated = estimateTotal(
    file.startedAt === undefined ? elapsed : now - file.startedAt,
    done,
    file.file.planned ?? 0,
  )

  return [
    firstRow,
    fitRow(`    ${file.rule.target} > ${file.rule.id} (${formatDuration(elapsed)}, ${formatEstimatedDuration(estimated)})`, options.columns),
  ]
}

function formatFileSummaryRow(
  file: FileState,
  state: SummaryState,
  options: SummaryProgressReporterOptions,
): string {
  const spinner = options.spinnerFrames[state.spinnerIndex] ?? ''
  const path = formatFilePath(file.file.path, options.cwd)
  const prefix = `${spinner} ${path}`
  const counter = `${file.completed}/${file.cached}/${file.errored}/${file.file.planned ?? 0}`
  const minimumSpace = 1

  return fitRow(
    `${prefix}${' '.repeat(Math.max(minimumSpace, options.columns - prefix.length - counter.length))}${counter}`,
    options.columns,
  )
}

function formatFooter(
  state: SummaryState,
  warnCount: number,
  errorCount: number,
  queued: number,
  options: SummaryProgressReporterOptions,
  now: number,
): string {
  const endedAt = state.endedAt ?? now
  const elapsed = state.runStartedAt === undefined ? undefined : endedAt - state.runStartedAt
  const completed = state.completed + state.cached + state.errored
  const estimated = elapsed === undefined
    ? undefined
    : estimateTotal(elapsed, completed, state.planned)
  const estimatedTokens = completed > 0 && state.planned > 0
    ? Math.ceil(state.totalTokens * state.planned / completed).toLocaleString('en-US')
    : '?'

  return fitRow([
    `${formatDuration(elapsed)} -> ${formatEstimatedDuration(estimated)}`,
    `${state.totalTokens.toLocaleString('en-US')} tokens -> ~${estimatedTokens} tokens`,
    `${queued} queued / ${state.cached} cached / ${warnCount} warn / ${errorCount} error`,
  ].join(' | '), options.columns)
}

function formatIdleRow(state: SummaryState, options: SummaryProgressReporterOptions): string {
  const spinner = options.spinnerFrames[state.spinnerIndex] ?? ''
  const prefix = `${spinner} alint`
  const counter = `${state.completed}/${state.cached}/${state.errored}/${state.planned}`
  const minimumSpace = 1

  return fitRow(
    `${prefix}${' '.repeat(Math.max(minimumSpace, options.columns - prefix.length - counter.length))}${counter}`,
    options.columns,
  )
}

function formatQueuedRow(queued: number, options: SummaryProgressReporterOptions): string {
  return fitRow(`  ${queued} ${queued === 1 ? 'file' : 'files'} queued`, options.columns)
}

function formatTarget(payload: RuleStartPayload | TargetProgressPayload): string {
  return payload.path.target.name
    ? `${payload.path.target.kind} ${payload.path.target.name}`
    : payload.path.target.kind
}

function getActiveFiles(state: SummaryState): FileState[] {
  return [...state.files.values()]
    .filter(file => file.startedAt !== undefined && file.endedAt === undefined)
    .sort((left, right) => left.file.index - right.file.index)
}

function getFileState(state: SummaryState, file: ProgressFilePath): FileState {
  const existingFile = state.files.get(file.path)

  if (existingFile) {
    existingFile.file = {
      ...existingFile.file,
      ...file,
      planned: file.planned ?? existingFile.file.planned,
    }

    return existingFile
  }

  const nextFile = createFileState({
    ...file,
    planned: file.planned ?? (state.files.size === 0 ? state.planned : undefined),
  })
  state.files.set(file.path, nextFile)

  return nextFile
}

function replaceFirst(row: string, search: string, replacement: string): string {
  if (search.length === 0)
    return row

  return row.replace(new RegExp(escapeRegExp(search)), replacement)
}

function styleRow(
  row: string,
  state: SummaryState,
  warnCount: number,
  errorCount: number,
  options: SummaryProgressReporterOptions,
): string {
  let styledRow = row
  const spinner = options.spinnerFrames[state.spinnerIndex] ?? ''

  if (spinner) {
    styledRow = replaceFirst(styledRow, spinner, colors.cyan(spinner))
  }

  styledRow = styledRow
    .replace(/\|/g, colors.gray('|'))
    .replace(`${warnCount} warn`, colors.yellow(`${warnCount} warn`))
    .replace(`${errorCount} error`, (errorCount > 0 ? colors.red : colors.gray)(`${errorCount} error`))
    .replace(/(\d+\/\d+\/\d+\/\d+)/, match => state.errored > 0 ? colors.red(match) : colors.gray(match))
    .replace(/(\d[\d,]* tokens)/g, match => colors.cyan(match))

  return styledRow
}
