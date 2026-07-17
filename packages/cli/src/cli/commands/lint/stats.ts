import type { RunnerConfig } from '@alint-js/config'
import type { JobEndPayload, ProgressReporter, RunEndPayload, RunResult, RunStartPayload } from '@alint-js/core'

import type { RuleDuration, RunRuleCounts } from '../../stats'

import { getStatsDir } from '@alint-js/config'

import { createJsonlStatsStore, createRunStat, isCi } from '../../stats'

export interface StatsCollector {
  counts: RunRuleCounts
  durationMs: () => number | undefined
  reporter: ProgressReporter
  ruleDurations: () => RuleDuration[] | undefined
}

interface StatsWriteTarget {
  dir: string
  retentionMonths?: number
}

export function createStatsCollector(): StatsCollector {
  const counts: RunRuleCounts = { cached: 0, cancelled: 0, completed: 0, failed: 0, planned: 0 }
  let startedAt: number | undefined
  let endedAt: number | undefined
  // Busy-time per rule, summed over its jobs. Jobs run concurrently, so this is
  // attributed compute time, not wall-clock, and can exceed the run duration.
  const ruleMs = new Map<string, number>()

  return {
    counts,
    durationMs: () => (startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined),
    reporter: {
      onJobEnd: (payload: JobEndPayload) => {
        if (payload.startedAt === undefined || payload.endedAt === undefined) {
          return
        }

        const elapsed = Math.max(payload.endedAt - payload.startedAt, 0)

        ruleMs.set(payload.job.ruleId, (ruleMs.get(payload.job.ruleId) ?? 0) + elapsed)
      },
      onRunEnd: (payload: RunEndPayload) => {
        counts.cached = payload.execution.cached
        counts.cancelled = payload.execution.cancelled
        counts.completed = payload.execution.completed
        counts.failed = payload.execution.failed
        counts.planned = payload.execution.planned
        endedAt = payload.endedAt
      },
      onRunStart: (payload: RunStartPayload) => {
        startedAt = payload.startedAt
      },
    },
    // Undefined rather than an empty array when nothing ran, so a no-op run does
    // not persist an empty field.
    ruleDurations: () => (ruleMs.size === 0
      ? undefined
      : [...ruleMs].map(([ruleId, durationMs]) => ({ durationMs, ruleId }))),
  }
}

export function mergeProgressReporters(
  base?: ProgressReporter,
  extra?: ProgressReporter,
): ProgressReporter | undefined {
  if (!base) {
    return extra
  }

  if (!extra) {
    return base
  }

  const baseState = { disabled: false, reporter: base }
  const extraState = { disabled: false, reporter: extra }
  let firstFailure: Error | undefined
  const deliver = (
    state: { disabled: boolean, reporter: ProgressReporter },
    callback: (reporter: ProgressReporter) => void,
  ): void => {
    if (state.disabled)
      return

    try {
      callback(state.reporter)
    }
    catch (error) {
      state.disabled = true
      firstFailure ??= normalizeReporterError(error)
    }
  }
  const deliverBoth = (callback: (reporter: ProgressReporter) => void): void => {
    deliver(baseState, callback)
    deliver(extraState, callback)
  }

  return {
    onDiagnostic: (payload) => {
      deliverBoth(reporter => reporter.onDiagnostic?.(payload))
    },
    onJobEnd: (payload) => {
      deliverBoth(reporter => reporter.onJobEnd?.(payload))
    },
    onJobQueued: (payload) => {
      deliverBoth(reporter => reporter.onJobQueued?.(payload))
    },
    onJobRetry: (payload) => {
      deliverBoth(reporter => reporter.onJobRetry?.(payload))
    },
    onJobStart: (payload) => {
      deliverBoth(reporter => reporter.onJobStart?.(payload))
    },
    onRunEnd: (payload) => {
      deliverBoth(reporter => reporter.onRunEnd?.(payload))
      if (firstFailure)
        throw firstFailure
    },
    onRunStart: (payload) => {
      deliverBoth(reporter => reporter.onRunStart?.(payload))
    },
    onUsage: (payload) => {
      deliverBoth(reporter => reporter.onUsage?.(payload))
    },
  }
}

export function resolveStatsWrite(
  stats: RunnerConfig['stats'],
  env: NodeJS.ProcessEnv | undefined,
): StatsWriteTarget | undefined {
  if (isCi(env)) {
    return undefined
  }

  const enabled = stats === false
    ? false
    : (stats === undefined || stats === true ? true : stats.enabled !== false)

  if (!enabled) {
    return undefined
  }

  const config = typeof stats === 'object' ? stats : undefined

  return { dir: config?.location ?? getStatsDir(env), retentionMonths: config?.retentionMonths }
}

export async function writeRunStats(
  target: StatsWriteTarget,
  collector: StatsCollector,
  result: RunResult,
  cwd: string,
): Promise<void> {
  const store = createJsonlStatsStore({ dir: target.dir, retentionMonths: target.retentionMonths })

  try {
    await store.record(createRunStat({
      cwd,
      durationMs: collector.durationMs(),
      ruleCounts: {
        cached: result.execution.cached,
        cancelled: result.execution.cancelled,
        completed: result.execution.completed,
        failed: result.execution.failed,
        planned: result.execution.planned,
      },
      ruleDurations: collector.ruleDurations(),
      usage: result.usage,
    }))
  }
  catch {
    // Noop: Stats persistence is non-critical.
  }
}

function normalizeReporterError(error: unknown): Error {
  if (error instanceof Error)
    return error
  return new Error(error != null ? String(error) : 'Unknown progress reporter error.')
}
