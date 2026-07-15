import type { Diagnostic, ExecutionCounts, ProgressJob, ProgressReporter } from '@alint-js/core'

import { relative } from 'node:path'

import fastStringTruncatedWidth from 'fast-string-truncated-width'
import fastStringWidth from 'fast-string-width'

import { createColors } from 'tinyrainbow'

const colors = createColors({ force: true })
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface SummaryProgressReporter extends ProgressReporter {
  getRows: () => string[]
  tick: () => void
}

export interface SummaryProgressReporterOptions {
  color: boolean
  columns: number
  cwd?: string
  rows?: number
  spinnerFrames: string[]
}

type JobLifecycle = 'cached' | 'cancelled' | 'completed' | 'failed' | 'queued' | 'running' | 'skipped'

interface JobState {
  job: ProgressJob
  startedAt?: number
  state: JobLifecycle
}

interface SummaryState {
  diagnostics: Diagnostic[]
  execution: ExecutionCounts
  jobs: Map<string, JobState>
  spinnerIndex: number
  totalTokens: number
}

export function createSummaryProgressReporter(options: SummaryProgressReporterOptions): SummaryProgressReporter {
  const now = Date.now
  const state = createInitialState()

  return {
    getRows: () => createRows(state, options, now()),
    onDiagnostic: ({ diagnostic }) => {
      state.diagnostics.push(diagnostic)
    },
    onJobEnd: (payload) => {
      const current = state.jobs.get(payload.job.id)
      state.jobs.set(payload.job.id, {
        job: payload.job,
        startedAt: payload.startedAt ?? current?.startedAt,
        state: payload.state,
      })
      transition(state.execution, 'running', payload.state)
    },
    onJobQueued: ({ job }) => {
      state.jobs.set(job.id, { job, state: 'queued' })
      state.execution.queued += 1
    },
    onJobStart: (payload) => {
      state.jobs.set(payload.job.id, {
        job: payload.job,
        startedAt: payload.startedAt ?? now(),
        state: 'running',
      })
      transition(state.execution, 'queued', 'running')
    },
    onRunEnd: (payload) => {
      state.diagnostics = [...payload.diagnostics]
      state.execution = { ...payload.execution }
      state.totalTokens = payload.usage.totalTokens
    },
    onRunStart: ({ jobsTotal }) => {
      state.diagnostics = []
      state.execution = createCounts(jobsTotal)
      state.jobs.clear()
      state.spinnerIndex = 0
      state.totalTokens = 0
    },
    onUsage: ({ record }) => {
      if (record.totalTokens != null && Number.isFinite(record.totalTokens))
        state.totalTokens += record.totalTokens
    },
    tick: () => {
      state.spinnerIndex = (state.spinnerIndex + 1) % Math.max(options.spinnerFrames.length, 1)
    },
  }
}

function completeGraphemeBoundary(input: string, maximumIndex: number): number {
  let boundary = 0

  for (const segment of graphemeSegmenter.segment(input)) {
    const end = segment.index + segment.segment.length
    if (end > maximumIndex)
      break
    boundary = end
  }

  return boundary
}

function countDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity).length
}

function createCounts(planned = 0): ExecutionCounts {
  return {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned,
    queued: 0,
    running: 0,
    skipped: 0,
  }
}

function createInitialState(): SummaryState {
  return {
    diagnostics: [],
    execution: createCounts(),
    jobs: new Map(),
    spinnerIndex: 0,
    totalTokens: 0,
  }
}

function createRows(state: SummaryState, options: SummaryProgressReporterOptions, now: number): string[] {
  if (options.rows !== undefined && options.rows <= 0)
    return []

  const warnCount = countDiagnostics(state.diagnostics, 'warn')
  const errorCount = countDiagnostics(state.diagnostics, 'error')
  const runningJobs = [...state.jobs.values()]
    .filter(job => job.state === 'running')
    .sort((left, right) => left.job.index - right.job.index)
  const footerRows = 1
  const separatorRows = options.rows === undefined || options.rows >= 2 ? 1 : 0
  const contentBudget = options.rows === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(options.rows - footerRows - separatorRows, 0)
  const needsMarker = runningJobs.length > contentBudget
  const jobBudget = needsMarker ? Math.max(contentBudget - 1, 0) : contentBudget
  const visible = runningJobs
    .slice(0, jobBudget)
    .map(job => formatJobRow(job, state, options, now))
  const hiddenJobs = runningJobs.length - visible.length

  if (hiddenJobs > 0 && contentBudget > 0)
    visible.push(fitRow(`    └─ … ${hiddenJobs} more running jobs hidden`, options.columns))
  if (separatorRows === 1)
    visible.push('')
  visible.push(formatFooter(state, warnCount, errorCount, options))

  return options.color
    ? visible.map(row => styleRow(row, state, warnCount, errorCount, options))
    : visible
}

function fitRow(row: string, columns: number): string {
  if (columns <= 0)
    return ''
  if (fastStringWidth(row) <= columns)
    return row

  // Re-measure the candidate because ambiguous glyphs may differ between the
  // truncation primitive's index calculation and the terminal-width primitive.
  let limit = columns
  while (limit > 0) {
    const result = fastStringTruncatedWidth(row, { ellipsis: '…', limit })
    // The width primitive already skips complete ANSI escape sequences. Clamp
    // its raw index to a grapheme boundary so astral, ZWJ, and combining
    // sequences cannot be split while preserving that ANSI-safe upper bound.
    const index = completeGraphemeBoundary(row, result.index)
    const visible = row.slice(0, index)
    const reset = visible.includes('\u001B') ? '\u001B[0m' : ''
    const fitted = `${visible}${reset}${result.ellipsed ? '…' : ''}`
    const overflow = fastStringWidth(fitted) - columns

    if (overflow <= 0)
      return fitted
    limit -= overflow
  }

  return ''
}

function formatDuration(ms: number): string {
  return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`
}

function formatFooter(
  state: SummaryState,
  warnCount: number,
  errorCount: number,
  options: SummaryProgressReporterOptions,
): string {
  const { cached, failed, queued, running } = state.execution

  return fitRow(
    `${running} running / ${queued} queued / ${cached} cached / ${warnCount} warn / ${errorCount} error / ${failed} failed / ${state.totalTokens} tokens`,
    options.columns,
  )
}

function formatJobRow(jobState: JobState, state: SummaryState, options: SummaryProgressReporterOptions, now: number): string {
  const spinner = options.spinnerFrames[state.spinnerIndex] ?? ''
  const inputPath = options.cwd ? relative(options.cwd, jobState.job.inputPath) || '.' : jobState.job.inputPath
  const target = jobState.job.target.name
    ? `${jobState.job.target.kind} ${jobState.job.target.name}`
    : jobState.job.target.kind
  const startedAt = jobState.startedAt ?? now

  return fitRow(
    `${spinner} ${inputPath} > ${target} > ${jobState.job.ruleId} (${formatDuration(now - startedAt)})`,
    options.columns,
  )
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

  if (spinner)
    styledRow = styledRow.replace(spinner, colors.cyan(spinner))

  return styledRow
    .replace(/\//g, colors.gray('/'))
    .replace(`${warnCount} warn`, colors.yellow(`${warnCount} warn`))
    .replace(`${errorCount} error`, (errorCount > 0 ? colors.red : colors.gray)(`${errorCount} error`))
    .replace(`${state.execution.failed} failed`, (state.execution.failed > 0 ? colors.red : colors.gray)(`${state.execution.failed} failed`))
}

function transition(counts: ExecutionCounts, from: 'queued' | 'running', to: keyof ExecutionCounts): void {
  counts[from] -= 1
  counts[to] += 1
}
