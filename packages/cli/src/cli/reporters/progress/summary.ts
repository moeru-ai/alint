import type {
  Diagnostic,
  ExecutionCounts,
  ProgressPath,
  ProgressPlanRef,
  ProgressReporter,
  RuleEndPayload,
} from '@alint-js/core'

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

interface ActiveRuleState {
  path: ProgressPath
  startedAt: number
}

interface PlanBlock {
  rows: string[]
  runningRules: number
}

interface PlanState {
  activeRules: Map<number, ActiveRuleState>
  execution: ExecutionCounts
  hasExecutionSnapshot: boolean
  lifecycle: 'queued' | 'running' | 'settled'
  plan: ProgressPlanRef
  startedAt?: number
}

interface SummaryState {
  diagnostics: Diagnostic[]
  endedAt?: number
  execution: ExecutionCounts
  plans: Map<string, PlanState>
  runStartedAt?: number
  spinnerIndex: number
  totalTokens: number
}

export function createSummaryProgressReporter(options: SummaryProgressReporterOptions): SummaryProgressReporter {
  const now = Date.now
  const state: SummaryState = createInitialState()

  return {
    getRows: () => createRows(state, options, now()),
    onDiagnostic: (payload) => {
      state.diagnostics = payload.diagnostics
    },
    onPlanEnd: (payload) => {
      const plan = getPlanState(state, payload.plan)
      applyPlanSnapshot(state, plan, payload.execution)
      plan.activeRules.clear()
      plan.lifecycle = 'settled'
    },
    onPlanStart: (payload) => {
      const plan = getPlanState(state, payload.plan)
      applyPlanSnapshot(state, plan, payload.execution)
      plan.lifecycle = 'running'
      plan.startedAt = payload.startedAt ?? now()
    },
    onRuleEnd: (payload) => {
      const plan = getPlanState(state, payload.path.plan)

      if (!plan.activeRules.delete(payload.path.job.index))
        return

      transitionToTerminal(plan.execution, payload.state)
      transitionToTerminal(state.execution, payload.state)
    },
    onRuleStart: (payload) => {
      const plan = getPlanState(state, payload.path.plan)

      plan.lifecycle = 'running'
      plan.startedAt ??= payload.startedAt ?? now()
      if (plan.activeRules.has(payload.path.job.index))
        return

      plan.activeRules.set(payload.path.job.index, {
        path: payload.path,
        startedAt: payload.startedAt ?? now(),
      })

      // The first started job is already represented by onPlanStart's snapshot.
      // Later starts need a local transition because rule events intentionally carry only paths.
      if (plan.activeRules.size > plan.execution.running) {
        transition(plan.execution, 'queued', 'running')
        transition(state.execution, 'queued', 'running')
      }
    },
    onRunEnd: (payload) => {
      state.diagnostics = payload.diagnostics
      state.endedAt = payload.endedAt ?? now()
      state.execution = { ...payload.execution }
      state.runStartedAt = payload.startedAt ?? state.runStartedAt
      state.totalTokens = payload.usage.totalTokens
    },
    onRunStart: (payload) => {
      state.diagnostics = []
      state.endedAt = undefined
      state.execution = { ...payload.execution }
      state.plans = new Map(payload.plans.map(plan => [plan.id, createPlanState(plan)]))
      state.runStartedAt = payload.startedAt ?? now()
      state.spinnerIndex = 0
      state.totalTokens = 0
    },
    onTargetEnd: () => {},
    onTargetStart: () => {},
    onUsage: (payload) => {
      state.totalTokens = payload.total.totalTokens
    },
    tick: () => {
      state.spinnerIndex = (state.spinnerIndex + 1) % Math.max(options.spinnerFrames.length, 1)
    },
  }
}

function applyPlanSnapshot(state: SummaryState, plan: PlanState, execution: ExecutionCounts): void {
  const previous = plan.hasExecutionSnapshot ? plan.execution : createCounts(execution.planned)

  for (const key of ['cached', 'cancelled', 'completed', 'failed', 'queued', 'running'] as const)
    state.execution[key] += execution[key] - previous[key]

  plan.execution = { ...execution }
  plan.hasExecutionSnapshot = true
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
    queued: planned,
    running: 0,
    skipped: 0,
  }
}

function createInitialState(): SummaryState {
  return {
    diagnostics: [],
    execution: createCounts(),
    plans: new Map(),
    spinnerIndex: 0,
    totalTokens: 0,
  }
}

function createPlanState(plan: ProgressPlanRef): PlanState {
  return {
    activeRules: new Map(),
    execution: createCounts(plan.planned),
    hasExecutionSnapshot: false,
    lifecycle: 'queued',
    plan,
  }
}

function createRows(state: SummaryState, options: SummaryProgressReporterOptions, now: number): string[] {
  if (options.rows !== undefined && options.rows <= 0)
    return []

  const warnCount = countDiagnostics(state.diagnostics, 'warn')
  const errorCount = countDiagnostics(state.diagnostics, 'error')
  const blocks = [...state.plans.values()]
    .filter(plan => plan.lifecycle === 'running')
    .sort((left, right) => left.plan.index - right.plan.index)
    .map(plan => formatPlanBlock(plan, state, options, now))
  const footerRows = 1
  const separatorRows = options.rows === undefined || options.rows >= 2 ? 1 : 0
  const fixedRows = footerRows + separatorRows
  const contentBudget = options.rows === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(options.rows - fixedRows, 0)
  const allContentRows = blocks.reduce((total, block) => total + block.rows.length, 0)
  const needsMarker = allContentRows > contentBudget
  const blockBudget = needsMarker ? Math.max(contentBudget - 1, 0) : contentBudget
  const visible: string[] = []
  let hiddenRules = 0

  for (const block of blocks) {
    if (visible.length + block.rows.length <= blockBudget)
      visible.push(...block.rows)
    else
      hiddenRules += block.runningRules
  }

  if (hiddenRules > 0 && contentBudget > 0)
    visible.push(fitRow(`    └─ … ${hiddenRules} more running rules hidden`, options.columns))
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
    `${running} running / ${queued} queued / ${cached} cached / ${warnCount} warn / ${errorCount} error / ${failed} failed`,
    options.columns,
  )
}

function formatPlanBlock(
  plan: PlanState,
  state: SummaryState,
  options: SummaryProgressReporterOptions,
  now: number,
): PlanBlock {
  const rules = [...plan.activeRules.values()].sort((left, right) => left.path.job.index - right.path.job.index)

  return {
    rows: [
      formatPlanRow(plan, state, options),
      ...rules.map(rule => fitRow(
        `    ${formatTarget(rule.path)} > ${rule.path.rule.id} (${formatDuration(now - rule.startedAt)})`,
        options.columns,
      )),
    ],
    runningRules: rules.length,
  }
}

function formatPlanRow(plan: PlanState, state: SummaryState, options: SummaryProgressReporterOptions): string {
  const spinner = options.spinnerFrames[state.spinnerIndex] ?? ''
  const path = options.cwd ? relative(options.cwd, plan.plan.path) || '.' : plan.plan.path
  const prefix = `${spinner} ${path}`
  const { cached, completed, failed, planned } = plan.execution
  const counter = `${completed}/${cached}/${failed}/${planned}`
  const counterWidth = fastStringWidth(counter)

  if (options.columns <= counterWidth)
    return fitRow(counter, options.columns)

  const fittedPrefix = fitRow(prefix, options.columns - counterWidth - 1)
  const padding = Math.max(1, options.columns - fastStringWidth(fittedPrefix) - counterWidth)

  return `${fittedPrefix}${' '.repeat(padding)}${counter}`
}

function formatTarget(path: ProgressPath): string {
  return path.target.name ? `${path.target.kind} ${path.target.name}` : path.target.kind
}

function getPlanState(state: SummaryState, plan: ProgressPlanRef): PlanState {
  const existing = state.plans.get(plan.id)
  if (existing) {
    existing.plan = plan
    return existing
  }

  const next = createPlanState(plan)
  state.plans.set(plan.id, next)
  return next
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

function transitionToTerminal(counts: ExecutionCounts, terminal: RuleEndPayload['state']): void {
  transition(counts, 'running', terminal)
}
