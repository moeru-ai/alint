import type {
  ExecutionCounts,
  PlanProgressPayload,
  ProgressPath,
  ProgressPlanRef,
  ProgressReporter,
  TargetProgressPayload,
} from '../types'
import type { RuleExecutionJob, RuleExecutionOutcome } from './types'

export type ProgressPayload<K extends ProgressEventName> = NonNullable<ProgressReporter[K]> extends
(payload: infer Payload) => void ? Payload : never

type JobState = 'cached' | 'cancelled' | 'completed' | 'failed' | 'queued' | 'running' | 'skipped'

interface ParentState {
  counts: ExecutionCounts
  ended: boolean
  path: ProgressPath
  settled: number
  startedAt?: number
}
interface PlanState extends ParentState {
  plan: ProgressPlanRef
  targets: Map<RuleExecutionJob['target'], ParentState>
}

type ProgressEventName = keyof ProgressReporter

type TerminalState = RuleExecutionOutcome['state']

export class RunProgress {
  get error(): unknown {
    return this.#error
  }

  get execution(): ExecutionCounts {
    return snapshot(this.#counts)
  }

  get failed(): boolean {
    return this.#failed
  }

  readonly #clock: () => number
  readonly #counts: ExecutionCounts
  #error: unknown
  #failed = false
  readonly #jobs = new Map<RuleExecutionJob, JobState>()

  readonly #plans = new Map<RuleExecutionJob['plan'], PlanState>()

  #reporter: ProgressReporter | undefined

  constructor(
    reporter: ProgressReporter | undefined,
    jobs: RuleExecutionJob[],
    clock: () => number = Date.now,
  ) {
    this.#clock = clock
    this.#reporter = reporter
    this.#counts = createCounts(jobs.length)

    for (const job of jobs) {
      if (this.#jobs.has(job))
        throw new Error('RunProgress received the same job more than once')
      this.#jobs.set(job, 'queued')

      let plan = this.#plans.get(job.plan)
      if (!plan) {
        plan = {
          counts: createCounts(0),
          ended: false,
          path: job.path,
          plan: job.path.plan,
          settled: 0,
          targets: new Map(),
        }
        this.#plans.set(job.plan, plan)
      }
      plan.counts.planned += 1
      plan.counts.queued += 1

      let target = plan.targets.get(job.target)
      if (!target) {
        target = {
          counts: createCounts(0),
          ended: false,
          path: job.path,
          settled: 0,
        }
        plan.targets.set(job.target, target)
      }
      target.counts.planned += 1
      target.counts.queued += 1
    }
  }

  cancelJob(job: RuleExecutionJob): void {
    this.#expectJobState(job, 'queued', 'cancel')
    const { plan, target } = this.#parentStates(job)

    transition(this.#counts, 'queued', 'cancelled')
    transition(plan.counts, 'queued', 'cancelled')
    transition(target.counts, 'queued', 'cancelled')
    this.#jobs.set(job, 'cancelled')
    plan.settled += 1
    target.settled += 1
    this.#endParents(plan, target)
  }

  cancelQueuedJobs(): void {
    for (const [job, state] of this.#jobs) {
      if (state === 'queued')
        this.cancelJob(job)
    }
  }

  emit<K extends ProgressEventName>(name: K, payload: ProgressPayload<K>): void {
    const reporter = this.#reporter
    if (!reporter)
      return

    try {
      const callback = reporter[name] as ((payload: ProgressPayload<K>) => void) | undefined
      callback?.(snapshotPayload(name, payload))
    }
    catch (error) {
      if (!this.#failed) {
        this.#error = normalizeReporterError(error)
        this.#failed = true
      }
      this.#reporter = undefined
    }
  }

  endJob(outcome: RuleExecutionOutcome): void {
    const { job, state } = outcome
    this.#expectJobState(job, 'running', 'end')
    const { plan, target } = this.#parentStates(job)

    transition(this.#counts, 'running', state)
    transition(plan.counts, 'running', state)
    transition(target.counts, 'running', state)
    this.#jobs.set(job, state)
    plan.settled += 1
    target.settled += 1

    this.#endParents(plan, target)
  }

  interruptJob(job: RuleExecutionJob): void {
    this.#expectJobState(job, 'running', 'interrupt')
    const { plan, target } = this.#parentStates(job)

    transition(this.#counts, 'running', 'cancelled')
    transition(plan.counts, 'running', 'cancelled')
    transition(target.counts, 'running', 'cancelled')
    this.#jobs.set(job, 'cancelled')
    plan.settled += 1
    target.settled += 1
    this.#endParents(plan, target)
  }

  startJob(job: RuleExecutionJob): void {
    this.#expectJobState(job, 'queued', 'start')
    const { plan, target } = this.#parentStates(job)
    const startedAt = this.#clock()

    transition(this.#counts, 'queued', 'running')
    transition(plan.counts, 'queued', 'running')
    transition(target.counts, 'queued', 'running')
    this.#jobs.set(job, 'running')

    if (plan.startedAt === undefined) {
      plan.startedAt = startedAt
      this.emit('onPlanStart', planPayload(plan))
    }
    if (target.startedAt === undefined) {
      target.startedAt = startedAt
      this.emit('onTargetStart', targetPayload(target))
    }
  }

  #endParents(plan: PlanState, target: ParentState): void {
    if (target.startedAt !== undefined && target.settled === target.counts.planned && !target.ended) {
      target.ended = true
      this.emit('onTargetEnd', targetPayload(target, this.#clock()))
    }
    if (plan.startedAt !== undefined && plan.settled === plan.counts.planned && !plan.ended) {
      plan.ended = true
      this.emit('onPlanEnd', planPayload(plan, this.#clock()))
    }
  }

  #expectJobState(job: RuleExecutionJob, expected: JobState, action: 'cancel' | 'end' | 'interrupt' | 'start'): void {
    const actual = this.#jobs.get(job)
    if (actual === undefined)
      throw new Error(`RunProgress cannot ${action} an unknown job`)
    if (actual !== expected)
      throw new Error(`RunProgress cannot ${action} a ${actual} job`)
  }

  #parentStates(job: RuleExecutionJob): { plan: PlanState, target: ParentState } {
    const plan = this.#plans.get(job.plan)
    const target = plan?.targets.get(job.target)
    if (!plan || !target)
      throw new Error('RunProgress parent state is missing for a known job')
    return { plan, target }
  }
}

function cloneDiagnostic(diagnostic: ProgressPayload<'onDiagnostic'>['diagnostic']): ProgressPayload<'onDiagnostic'>['diagnostic'] {
  return {
    ...diagnostic,
    loc: diagnostic.loc
      ? {
          end: diagnostic.loc.end ? { ...diagnostic.loc.end } : undefined,
          start: { ...diagnostic.loc.start },
        }
      : undefined,
    model: diagnostic.model ? { ...diagnostic.model } : undefined,
  }
}

function cloneFailure(failure: NonNullable<ProgressPayload<'onRuleEnd'>['failure']>): NonNullable<ProgressPayload<'onRuleEnd'>['failure']> {
  return {
    ...failure,
    path: clonePath(failure.path),
  }
}

function clonePath(path: ProgressPath): ProgressPath {
  return {
    job: { ...path.job },
    plan: clonePlan(path.plan),
    rule: { ...path.rule },
    target: { ...path.target },
  }
}

function clonePlan(plan: ProgressPlanRef): ProgressPlanRef {
  return { ...plan }
}

function cloneUsage(usage: ProgressPayload<'onUsage'>['total']): ProgressPayload<'onUsage'>['total'] {
  return {
    ...usage,
    cached: usage.cached
      ? { ...usage.cached, records: usage.cached.records.map(record => ({ ...record })) }
      : undefined,
    records: usage.records.map(record => ({ ...record })),
  }
}

function createCounts(planned: number): ExecutionCounts {
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

function normalizeReporterError(error: unknown): Error {
  if (error instanceof Error)
    return error
  return new Error(error != null ? String(error) : 'Unknown progress reporter error.')
}

function planPayload(state: PlanState, endedAt?: number): PlanProgressPayload {
  return {
    endedAt,
    execution: snapshot(state.counts),
    plan: clonePlan(state.plan),
    startedAt: state.startedAt,
  }
}

function snapshot(counts: ExecutionCounts): ExecutionCounts {
  return { ...counts }
}

const snapshotters = {
  onDiagnostic: (payload: ProgressPayload<'onDiagnostic'>): ProgressPayload<'onDiagnostic'> => ({
    ...payload,
    diagnostic: cloneDiagnostic(payload.diagnostic),
    diagnostics: payload.diagnostics.map(cloneDiagnostic),
    path: payload.path ? clonePath(payload.path) : undefined,
  }),
  onPlanEnd: (payload: ProgressPayload<'onPlanEnd'>): ProgressPayload<'onPlanEnd'> => ({
    ...payload,
    execution: snapshot(payload.execution),
    plan: clonePlan(payload.plan),
  }),
  onPlanStart: (payload: ProgressPayload<'onPlanStart'>): ProgressPayload<'onPlanStart'> => ({
    ...payload,
    execution: snapshot(payload.execution),
    plan: clonePlan(payload.plan),
  }),
  onRuleEnd: (payload: ProgressPayload<'onRuleEnd'>): ProgressPayload<'onRuleEnd'> => ({
    ...payload,
    failure: payload.failure ? cloneFailure(payload.failure) : undefined,
    path: clonePath(payload.path),
  }),
  onRuleStart: (payload: ProgressPayload<'onRuleStart'>): ProgressPayload<'onRuleStart'> => ({
    ...payload,
    path: clonePath(payload.path),
  }),
  onRunEnd: (payload: ProgressPayload<'onRunEnd'>): ProgressPayload<'onRunEnd'> => ({
    ...payload,
    diagnostics: payload.diagnostics.map(cloneDiagnostic),
    execution: snapshot(payload.execution),
    usage: cloneUsage(payload.usage),
  }),
  onRunStart: (payload: ProgressPayload<'onRunStart'>): ProgressPayload<'onRunStart'> => ({
    ...payload,
    execution: snapshot(payload.execution),
    plans: payload.plans.map(clonePlan),
  }),
  onTargetEnd: (payload: ProgressPayload<'onTargetEnd'>): ProgressPayload<'onTargetEnd'> => ({
    ...payload,
    execution: snapshot(payload.execution),
    path: clonePath(payload.path),
  }),
  onTargetStart: (payload: ProgressPayload<'onTargetStart'>): ProgressPayload<'onTargetStart'> => ({
    ...payload,
    execution: snapshot(payload.execution),
    path: clonePath(payload.path),
  }),
  onUsage: (payload: ProgressPayload<'onUsage'>): ProgressPayload<'onUsage'> => ({
    ...payload,
    path: payload.path ? clonePath(payload.path) : undefined,
    record: { ...payload.record },
    total: cloneUsage(payload.total),
  }),
} satisfies { [K in ProgressEventName]: (payload: ProgressPayload<K>) => ProgressPayload<K> }

function snapshotPayload<K extends ProgressEventName>(
  name: K,
  payload: ProgressPayload<K>,
): ProgressPayload<K> {
  // `satisfies` proves each key's input/output pair; TypeScript cannot retain that
  // correlation after a generic indexed lookup, so `never` supplies the safe intersection.
  return snapshotters[name](payload as never) as ProgressPayload<K>
}

function targetPayload(state: ParentState, endedAt?: number): TargetProgressPayload {
  return {
    endedAt,
    execution: snapshot(state.counts),
    path: clonePath(state.path),
    startedAt: state.startedAt,
  }
}

function transition(counts: ExecutionCounts, from: 'queued' | 'running', to: 'running' | TerminalState): void {
  if (counts[from] <= 0)
    throw new Error(`RunProgress counter invariant failed: no ${from} jobs remain`)
  counts[from] -= 1
  counts[to] += 1
}
