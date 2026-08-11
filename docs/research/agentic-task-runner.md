# Agentic task runner for alint

## Proposal

Add `@alint-js/task` as a separate deep module. It runs repository-wide reasoning tasks and returns task values, not lint diagnostics.

Expose the first interface through the CLI:

```sh
alint task run --request task.json --format json
```

The command writes progress events to stderr. It writes one `TaskRunResult` JSON value to stdout.

The Devin design puts agents at the plan, map, and reduce stages. Deterministic code scans the declared scope and creates a finite work queue. Bounded workers inspect the queue, and a reducer combines structured results. Queue exhaustion gives measurable coverage. Selector recall remains a separate limit. [Devin: Agentic MapReduce](https://devin.ai/blog/agentic-map-reduce)

The original MapReduce design also separates map output from reduce input. Failed tasks can run again on another worker. Alint needs the same explicit stage boundary. [Google: MapReduce](https://research.google/pubs/mapreduce-simplified-data-processing-on-large-clusters/)

## Current fit and gap

The current source planner converts extracted targets into `(rule, target)` jobs. It schedules those jobs without retaining rich parser values (`packages/core/src/core/source/planner.ts:42-48`, `packages/core/src/core/source/planner.ts:91-105`, `packages/core/src/core/source/planner.ts:210-225`).

`RuleScheduler` already has bounded concurrency and round-robin lanes (`packages/core/src/core/execution/scheduler.ts:206-256`, `packages/core/src/core/execution/scheduler.ts:335-340`). Core also provides cooperative cancellation and partial run results (`packages/core/src/core/types.ts:163-193`, `packages/core/src/core/run.ts:21-37`).

However, the current run schedules source, directory, and project jobs in one execution phase. The project job starts before all map results are available. Thus, it is not a reducer (`packages/core/src/core/run.ts:114-168`). `RunResult` is also lint-specific (`packages/core/src/core/types.ts:195-199`).

The agent contract returns only text and usage (`packages/core/src/agent/types.ts:3-16`). The repository-aware JavaScript rules start one repository search for each file (`packages/plugin-js/src/agents/repository-review/agent.ts:14-18`, `packages/plugin-js/src/agents/repository-review/agent.ts:50-79`, `packages/plugin-js/src/rules/no-duplicated-knowledge/rule.ts:6-17`). This shape repeats context discovery instead of sharing deterministic selection.

## Stable values

Start with one task kind and one fixed result shape:

```ts
interface TaskRequest {
  kind: 'repository-review'
  limits?: {
    mapConcurrency?: number
    maxSignalsPerShard?: number
    timeoutMs?: number
  }
  objective: string
  schemaVersion: 1
  scope: {
    exclude?: string[]
    include: string[]
  }
}

interface TaskRunResult {
  artifacts: TaskArtifactRef[]
  coverage: {
    complete: boolean
    filesEligible: number
    filesScanned: number
    selectorLimitations: string[]
    shardsCompleted: number
    shardsFailed: number
    shardsPlanned: number
    signals: number
  }
  failures: TaskFailure[]
  findings: TaskFinding[]
  runId: string
  schemaVersion: 1
  status: 'cancelled' | 'completed' | 'failed' | 'incomplete'
  summary?: string
  usage: TaskUsage
}
```

The task module owns these values and the pipeline. Agent adapters remain replaceable infrastructure behind the module.

## Pipeline

1. **Plan:** A planner returns a valid `SelectorPlanV1`. The plan contains declarative selectors, not generated shell commands or JavaScript.
2. **Select:** A deterministic pass scans every eligible file. It emits compact signals with selector, path, range, and evidence provenance.
3. **Shard:** The engine sorts the signals and creates bounded shards. Stable signal order gives stable shard identifiers.
4. **Map:** One read-only worker inspects each shard. Each worker must return a valid `ShardResult` and account for every signal.
5. **Reduce:** The reducer receives valid shard results and the coverage manifest. It does not receive worker transcripts or repair missing shards.

The first selector language can support path globs, fixed text patterns, source-target kinds, names, and JSON metadata. This language reuses current extractors without permitting arbitrary code.

## Completion and failure rules

Set `coverage.complete` to true only after these conditions are true:

- Selection scanned the declared scope.
- All planned shards succeeded.
- Reduction succeeded.

A complete run proves queue coverage. It does not prove perfect selector recall. Always return the known selector limits with the coverage counts.

A failed selector pass sets `status` to `failed`. A shard that fails after a bounded retry sets `status` to `incomplete`. This result produces a nonzero exit code. Keep successful shard artifacts, but do not present them as a final reduced result.

Cancellation stops new dispatch and signals active workers. Late worker results do not enter reduction. The terminal result keeps the completed coverage counts.

The MVP gives workers repository-confined, read-only tools. The current `read_file` tool also accepts absolute paths outside the repository, so the task runner must not reuse it unchanged (`packages/tools-fs/src/index.ts:23-25`, `packages/tools-fs/src/read.ts:4-9`).

This read-only rule lets the engine run a failed shard again without repeating a repository write.

## MVP boundary

Implement one planner, one selector language, one map worker contract, one reducer, and the blocking CLI command. Persist the plan, signals, shard results, and terminal result under one run identifier.

Do not add remediation, arbitrary worker tools, distributed hosts, incremental Git scans, or runtime verification in the first version. These features need separate safety and product decisions.

Add a thin MCP adapter after the CLI contract is stable. The adapter wraps the same `TaskRequest` and `TaskRunResult` values. MCP tools support JSON input schemas, output schemas, and structured results. [MCP tool specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
