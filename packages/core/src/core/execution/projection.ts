import type { RuleExecutionBucket } from '../targets/types'
import type { Diagnostic, InferenceUsageRecord, RunUsage, RunUsageTotals } from '../types'
import type { RuleExecutionJob } from './types'

export interface ExecutionProjection {
  diagnostics: () => Diagnostic[]
  register: (job: RuleExecutionJob) => RuleExecutionObservation
  usage: () => RunUsage
}

export interface RuleExecutionObservation {
  bucket: RuleExecutionBucket
  diagnostics: () => Diagnostic[]
  markCached: () => void
  usage: () => RunUsage
}

interface RegisteredBucket {
  bucket: RuleExecutionBucket
  cached: boolean
  index: number
}

export function createExecutionProjection(): ExecutionProjection {
  const buckets = new Map<RuleExecutionJob, RegisteredBucket>()

  function ordered(): RegisteredBucket[] {
    return [...buckets.values()].sort((left, right) => left.index - right.index)
  }

  return {
    diagnostics() {
      return ordered().flatMap(entry => entry.bucket.diagnostics)
    },
    register(job) {
      if (buckets.has(job))
        throw new Error('Execution projection cannot register the same job more than once')
      const bucket: RuleExecutionBucket = { diagnostics: [], usage: [] }
      const entry = { bucket, cached: false, index: job.path.job.index }
      buckets.set(job, entry)
      return {
        bucket,
        diagnostics: () => ordered().flatMap(candidate => candidate.bucket.diagnostics),
        markCached: () => entry.cached = true,
        usage: projectUsage,
      }
    },
    usage: projectUsage,
  }

  function projectUsage(): RunUsage {
    const live: InferenceUsageRecord[] = []
    const cached: InferenceUsageRecord[] = []

    for (const entry of ordered()) {
      ;(entry.cached ? cached : live).push(...entry.bucket.usage)
    }

    const liveTotals = totals(live)
    const cachedTotals = totals(cached)
    return {
      ...liveTotals,
      ...(cached.length > 0 ? { cached: cachedTotals } : {}),
    }
  }
}

function addFinite(total: number, value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? total + value : total
}

function totals(records: InferenceUsageRecord[]): RunUsageTotals {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0

  for (const record of records) {
    inputTokens = addFinite(inputTokens, record.inputTokens)
    outputTokens = addFinite(outputTokens, record.outputTokens)
    totalTokens = addFinite(totalTokens, record.totalTokens)
  }

  return {
    inputTokens,
    outputTokens,
    records: [...records],
    totalTokens,
  }
}
