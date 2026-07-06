import type { RunnerConfig } from '@alint-js/config'
import type { ProgressReporter, RunEndPayload, RunResult, RunStartPayload } from '@alint-js/core'

import type { RunRuleCounts } from '../../stats'

import { getStatsDir } from '@alint-js/config'

import { createJsonlStatsStore, createRunStat, isCi } from '../../stats'

export interface StatsCollector {
  counts: RunRuleCounts
  durationMs: () => number | undefined
  reporter: ProgressReporter
}

interface StatsWriteTarget {
  dir: string
  retentionMonths?: number
}

export function createStatsCollector(): StatsCollector {
  const counts: RunRuleCounts = { cached: 0, completed: 0, errored: 0, planned: 0 }
  let startedAt: number | undefined
  let endedAt: number | undefined

  return {
    counts,
    durationMs: () => (startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined),
    reporter: {
      onRunEnd: (payload: RunEndPayload) => {
        counts.cached = payload.cached
        counts.completed = payload.completed
        counts.errored = payload.errored
        counts.planned = payload.planned
        endedAt = payload.endedAt
      },
      onRunStart: (payload: RunStartPayload) => {
        startedAt = payload.startedAt
      },
    },
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

  return {
    onDiagnostic: (payload) => {
      base.onDiagnostic?.(payload)
      extra.onDiagnostic?.(payload)
    },
    onFileEnd: (payload) => {
      base.onFileEnd?.(payload)
      extra.onFileEnd?.(payload)
    },
    onFileStart: (payload) => {
      base.onFileStart?.(payload)
      extra.onFileStart?.(payload)
    },
    onRuleEnd: (payload) => {
      base.onRuleEnd?.(payload)
      extra.onRuleEnd?.(payload)
    },
    onRuleStart: (payload) => {
      base.onRuleStart?.(payload)
      extra.onRuleStart?.(payload)
    },
    onRunEnd: (payload) => {
      base.onRunEnd?.(payload)
      extra.onRunEnd?.(payload)
    },
    onRunStart: (payload) => {
      base.onRunStart?.(payload)
      extra.onRunStart?.(payload)
    },
    onTargetEnd: (payload) => {
      base.onTargetEnd?.(payload)
      extra.onTargetEnd?.(payload)
    },
    onTargetStart: (payload) => {
      base.onTargetStart?.(payload)
      extra.onTargetStart?.(payload)
    },
    onUsage: (payload) => {
      base.onUsage?.(payload)
      extra.onUsage?.(payload)
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
      ruleCounts: collector.counts,
      usage: result.usage,
    }))
  }
  catch {
    // Noop: Stats persistence is non-critical.
  }
}
