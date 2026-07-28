# Refactor source planning into compact jobs

Status: implemented

## Summary

Source planning should decide which rule jobs exist without transferring source ownership to those
jobs. A planned source job must contain a compact target descriptor, cache identity, ordering data,
and the rule handler to invoke. It must not contain a `SourceFile`, source text, parser state, or a
closure that captures an extractor target.

Rules that need source during execution should read it explicitly through `ctx.src`. The source
value then belongs to that rule invocation and becomes unreachable when the rule releases it or the
job ends. The run engine should not keep source alive across queued jobs or manage a cross-job source
cache.

Planning and execution may overlap. Planning must continue independently of slow rule jobs, so the
engine can discover the remaining files and keep rule concurrency supplied without retaining every
planned file in memory.

## Background

Commit `c2febc632188c4489393ee2541e33f41bb1d4bc9` bounded run pipeline memory after the previous
implementation prepared every input with one `Promise.all`, retained all `SourceFile` and
`SourceTarget` values, created all jobs, and only then executed them. The refactor introduced source
sessions capped at four concurrent files. A session now reads and extracts one file, schedules its
jobs, and waits for every job in that file batch before releasing its source values.

This restored a useful memory invariant, demonstrated by the regression that runs 9,600 semantic
targets under a 64 MiB heap. It also coupled four different lifecycles:

1. reading a source file;
2. extracting semantic targets;
3. admitting rule jobs;
4. waiting for model-backed rule jobs to settle.

The coupling is visible in `packages/core/src/core/source/session.ts`: `executeSourceSession()` keeps
`file`, `targets`, `executionTargets`, and `jobs` in the same async scope that awaits
`batch.outcomes`. `executeSourceSessions()` uses at most four such scopes. A slow job therefore keeps
one planning worker occupied after reading and extraction have finished. Near the tail of a run,
the scheduler can have free rule capacity while later files have not been planned.

The retention is also encoded in the public contract. `SourceTarget` contains a complete
`SourceFile`, target text, and arbitrary metadata. `sourceExecution()` closes over that value when it
creates `run: () => handler(target)`. A queued job therefore owns the extractor's rich target even
though scheduling only needs its identity and location.

Project targets already use the desired ownership model. `ProjectFileEntry` and
`ProjectTargetEntry` are compact descriptors, and project rules read source explicitly when needed.
This refactor applies the same rule to source targets.

## Goals

- Separate the planning interface from the rule execution interface.
- Ensure planned and queued jobs contain no source text, `SourceFile`, parser object, or extractor
  closure.
- Let source planning continue while previously scheduled rule jobs are running.
- Let `--rule-concurrency` describe achievable rule concurrency for workloads with one job per
  file.
- Preserve stable job ordering, diagnostics, usage accounting, cancellation, cache correctness, and
  compact project indexing.
- Make cache hits skip execution-time source reads.
- Detect when a rule attempts to read a different version of its planned source.
- Keep filesystem reads scoped to planning or to the rule invocation that requested them.

## Non-goals

- Retaining or sharing `SourceFile` values across rule jobs.
- Adding a core-managed source LRU, file-descriptor pool, or persistent repository database.
- Guaranteeing that plugin code releases source before its job ends.
- Parallelizing parsers with worker threads in the first implementation.
- Changing directory- or project-target semantics beyond sharing the new base source file type where
  appropriate.
- Preserving the current `SourceTarget` shape through compatibility guards.

## Design principles

### Planning owns extraction; rules own execution reads

The planning module may read a file because extraction requires its content. Its interface returns
only detached planning results. Once that result has been produced, no scheduler-owned value may
reach the `SourceFile` used during extraction.

A rule may read its planned file through `ctx.src`. That read is local to the active job. Core does
not memoize it for another job. Node's file read closes its underlying descriptor as part of the
operation; this proposal concerns heap ownership of returned source values, not long-lived file
descriptors.

### Jobs describe work; they do not capture work inputs

A `RuleJob` should name a runtime, a handler kind, and a compact target. It should not store an
invocation closure over a rich extractor value. The execution module is responsible for dispatching
the named handler with the planned descriptor.

### Planned metadata is detached data

Extractor metadata used by rules may survive planning only when it is detached from the extractor
and can be hashed deterministically. It must not contain AST nodes, source files, parser instances,
functions, cyclic objects, or views backed by parser-owned memory.

The migration must define one supported data contract and validate or snapshot metadata at the
planning seam. Keeping `Record<string, unknown>` without an ownership constraint would preserve the
same retention bug through a less visible reference.

### Planning progress and execution progress are separate states

The number of jobs is provisional while planners can still admit work. It becomes final when all
source, directory, and project planning has completed. Execution may still be running at that time.
Progress must represent those states independently instead of setting `final` only after every job
has settled.

## Proposed contracts

The names below describe the intended ownership. Exact export placement may change during the
refactor, but the two target shapes must remain distinct.

```ts
export interface BaseSourceFile {
  contentHash: string
  language: string
  path: string
}

/** Detached input passed to source rule handlers. */
export interface PlannedSourceTarget {
  file: BaseSourceFile
  identity: string
  kind: SourceTargetKind
  language: string
  loc?: SourceLocation
  metadata?: SourceTargetMetadata
  name?: string
  origin?: SourceTargetOrigin
  range?: SourceRange
}

export interface SourceFile extends BaseSourceFile {
  lines: string[]
  text: string
}

/** Transient output from a language extractor. Never stored in a rule job. */
export interface SourceTarget {
  file: SourceFile
  identity: string
  kind: SourceTargetKind
  language: string
  loc?: SourceLocation
  metadata?: SourceTargetMetadata
  name?: string
  origin?: SourceTargetOrigin
  range?: SourceRange
  text: string
}
```

`LanguageDefinition.extract()` continues to return `SourceTarget[]`. Rule handlers receive
`PlannedSourceTarget`; its `file` field contains only the shared `BaseSourceFile` fields and its
`text` field is removed. The names now expose the lifecycle boundary directly: a language extracts
a source target, while the planner produces the target that rules execute.

The metadata carrier must support the existing `FunctionInfo`, call-site, and language-specific
facts while enforcing detached, deterministic data. The implementation should first inventory
metadata producers and consumers, then choose the narrowest recursive data type that covers them.
Unsupported values must fail during planning with a file extraction/planning failure rather than be
silently retained.

### Descriptor-aware source reads

Rules should pass the descriptor rather than only its path when reading their planned source:

```ts
create: ctx => ({
  async onTargetFunction(target) {
    const file = await ctx.src.readFile(target.file)
    const source = target.range
      ? ctx.src.sliceRange(file, target.range)
      : { filePath: file.path, text: file.text }

    await review(source)
  },
})
```

`SourceRuntime.readFile()` should accept either a path for an unplanned auxiliary read or a
`BaseSourceFile` for a planned read:

```ts
interface SourceRuntime {
  readFile: (file: BaseSourceFile | string) => Promise<SourceFile>
}
```

When passed a descriptor, the runtime verifies that the loaded content matches
`descriptor.contentHash`. A mismatch rejects with a dedicated source-changed error. The failure must
not produce diagnostics or commit cache entries for the affected job. This avoids applying a range
or extracted metadata from version A to source version B without keeping version A in memory.

Auxiliary path reads do not have a planned hash and retain their current semantics. A rule that
needs snapshot validation for another file should obtain or construct an appropriate descriptor
through a domain-specific index rather than relying on hidden active-job state.

### Planned execution shape

`RuleTargetExecution.run` currently captures the rich extractor target. Replace it with dispatch
data:

```ts
interface RuleJob {
  execution: RuleTargetExecution
  jobRef: ProgressJobRef
  orderKey: RuleJobOrderKey
  target: ExecutionTarget
}

interface RuleTargetExecution {
  handler: SourceHandlerKind
  runtime: RuleRuntime
}

type SourceHandlerKind = 'class' | 'file' | 'function' | 'with'
```

`ExecutionTarget` carries the public `PlannedSourceTarget` descriptor plus internal cache ownership and the
precomputed target hash. `executeRuleJob()` dispatches the handler selected by `handler`. No job
field may refer to `SourceTarget` or `SourceFile`.

## Planning lifecycle

For each prepared input, the source planner performs the following operations:

1. Read the file for extraction.
2. Resolve its language and extract rich targets.
3. Compute the file content hash.
4. Resolve stable target identities.
5. Compute each target's semantic hash from the same inputs used by the current cache fingerprint.
6. Snapshot supported metadata into detached data.
7. Build the compact file descriptor, source target descriptors, project snapshot, and rule jobs.
8. Submit the jobs to the scheduler.
9. Leave the scope that owns the extraction `SourceFile`, rich targets, and parser state.

The planner records the compact outcome promises in input order but does not await them before
planning another file. Cache-owner completion may attach to the batch outcome promise because the
owner transaction and content hash are compact; that continuation must not capture extraction
values.

Every prepared input starts planning independently. Core does not impose a separate source-planning
window: a plan submits compact jobs and releases its rich extraction values without waiting for
those jobs. Rule concurrency remains the only engine scheduling limit.

The scheduler may begin running compact jobs as soon as they are submitted. Waiting for the entire
repository plan before starting execution is not required and would add avoidable model latency.

After every source input has been planned, the run engine can finish the compact project index,
admit directory and project jobs, and mark planning final. It then waits for the scheduler to settle
all admitted work.

## Cache behavior

Planning still reads and extracts a source file to determine its current targets and semantic
fingerprints. This proposal does not add a file-level extraction cache.

The target fingerprint is computed during planning from the rich extractor output before that
output is released. A cache lookup therefore occurs before rule execution:

- cache hit: replay diagnostics and usage without an execution-time source read;
- cache miss: invoke the rule, which may read source through `ctx.src`;
- source changed during a descriptor-aware read: fail the job and do not store its result;
- cancellation: preserve the existing merge behavior for completed entries and do not replace
  unknown slots.

File-owner reconciliation must operate from the set of planned cache slots and terminal compact
outcomes. It must not depend on retaining the source plan or target text until execution ends.

## Progress behavior

Replace the overloaded meaning of `ProgressSnapshot.final` with an explicit planning state. One
possible shape is:

```ts
interface ProgressSnapshot {
  execution: ExecutionCounts
  filesPlanned: number
  filesTotal: number
  jobsCompleted: number
  jobsStarted: number
  jobsTotal: number
  planningComplete: boolean
}
```

Required behavior:

- `filesPlanned` advances after a file has produced compact jobs or a compact planning failure.
- `jobsTotal` increases when jobs are admitted.
- `planningComplete` becomes true after all source, directory, and project jobs have been admitted.
- ETA and token projection remain unavailable while `planningComplete` is false.
- The UI removes `jobs (discovering)` as soon as planning is final, even if jobs are still running.
- Run completion remains a separate event and requires no queued or running jobs.

## Error and cancellation behavior

- Read and extraction errors remain file failures and admit no jobs for that file.
- Unsupported metadata is a planning failure associated with the input file.
- A descriptor hash mismatch is a source-changed execution failure with the file path and expected
  and actual hashes available for debugging.
- An infrastructure or reporter failure stops further planning, cancels queued jobs, and waits for
  running jobs according to existing scheduler semantics.
- Aborting a run stops new planning reads and prevents new job admission. Running rules receive the
  aborted signal as they do today.
- Compact results remain sorted by `orderKey`; planning completion order must not affect diagnostic,
  usage, or failure order.

## Module changes

### `packages/core/src/core/source`

- Split transient extractor types from compact rule target types.
- Replace `session.ts` with a planning module whose interface returns detached planning results.
- Remove `MAX_ACTIVE_SOURCE_SESSIONS` and `SourceSessionMetrics` after equivalent planning metrics
  cover the new invariant.
- Make descriptor-aware reads validate content hashes.
- Remove the `PlannedSourceTarget` overload from synchronous helpers such as `getText()` when it implies
  source is embedded in a target.

### `packages/core/src/core/execution`

- Replace target-capturing execution closures with handler dispatch data.
- Require compact `ExecutionTarget` values.
- Preserve scheduler fairness and global `ruleConcurrency`.
- Keep terminal outcomes detached from runtime state and source values.

### `packages/core/src/core/project`

- Reuse `BaseSourceFile` where it reduces duplicate concepts without adding fields project
  rules do not need.
- Continue storing only compact file entries, target descriptors, and semantic hashes.

### `packages/core/src/dsl`

- Change `LanguageDefinition.extract()` to return the transient extractor type.
- Change source rule handlers to receive the compact `PlannedSourceTarget`.
- Document `ctx.src.readFile(target.file)` as the normal way to expand planned source.
- Document the metadata ownership contract.

### Plugins

- Replace `target.text` with a descriptor-aware source read and range slice.
- Replace uses of `target.file.text` and `target.file.lines` with a descriptor-aware source read.
- Keep uses of `target.file.path` on the compact descriptor.
- Scope source reads to prompt or analysis construction so long-running model calls do not retain
  source accidentally when they only need a derived prompt.

## Migration plan

This is a breaking refactor. Do not add compatibility fields, lazy getters that emulate the old
shape, dual handler signatures, or alternate test-only imports.

### Phase 1: establish the compact contracts

- Inventory all extractor metadata producers and rule consumers.
- Define `SourceTarget`, compact `PlannedSourceTarget`, `BaseSourceFile`, and the supported
  metadata carrier in the source module that owns them.
- Add type tests for the public exports.
- Add planning tests that prove compact descriptors do not contain source sentinels.

### Phase 2: detach planning from execution

- Replace execution closures with handler dispatch data.
- Convert source extraction results into compact jobs.
- Let planning workers submit jobs without awaiting their outcomes.
- Preserve compact cache-owner completion and stable result ordering.
- Separate planning-final progress from run-final progress.

### Phase 3: migrate built-in and workspace plugins

- Update every source handler to read through `ctx.src` only when it needs source.
- Extract prompt-building helpers where doing so shortens source lifetime before a model request.
- Update package READMEs and examples to show the compact target contract.
- Remove obsolete source-session comments, tests, metrics, and exports.

## Implementation evidence

The complementary regressions cover the measurements that a microbenchmark cannot represent:

- Twenty one-job files reach twenty simultaneously running rule jobs at `ruleConcurrency: 20`,
  proving that source planning does not cap rule concurrency.
- The blocked-job child process reaches planning final with twenty jobs running and twenty queued,
  proving that planning is independent from job completion and queued jobs do not retain extractor
  sources.
- Both the blocked-planning regression and the existing 9,600-target regression pass with a 64 MiB
  heap limit, covering peak-heap behavior under scheduler pressure.

## Verification

### Contract tests

- A compact source target exposes a file descriptor and no `text` field.
- A planned job serialized for inspection contains no source sentinel.
- Metadata containing unsupported references fails at the planning seam.
- Public type exports come from the source module that owns the contracts.

### Planning tests

- Blocking every scheduled rule job does not stop the planner from reading and planning later files.
- Planning completion order does not change job order.
- File and extraction failures do not leave cache owners or jobs behind.
- Project snapshots remain compact and preserve stable semantic hashes.

### Execution tests

- Twenty one-job files can reach twenty active rule jobs with `ruleConcurrency: 20`.
- A rule that does not read source performs no execution-time read.
- A cache hit performs no execution-time read.
- `ctx.src.readFile(target.file)` returns the expected source when the hash matches.
- A changed source rejects before a rule applies a planned range to it.
- Cancellation prevents extraction after active planning reads settle and aborts active rule work.

### Memory and throughput tests

- Keep the existing 9,600-target, 64 MiB child-process regression.
- Add a child-process regression that finishes planning while rule jobs are deliberately blocked and
  verifies that extractor source is not retained by queued jobs.
- Benchmark many files with one rule job each.
- Benchmark many targets and rules per file.
- Benchmark skewed durations where a few rule jobs are much slower than the rest.
- Record time to planning final separately from total execution time.

### Required repository checks

- `pnpm type-check`
- `pnpm lint`
- package-scoped core and affected plugin Vitest suites
- root `pnpm test:run` before merging the completed migration

## Acceptance criteria

The refactor is complete when all of the following are true:

- No `RuleJob`, scheduler lane, terminal outcome, or project snapshot contains a `SourceFile`, source
  text, parser object, or extractor target.
- Source planning can reach its final state while rule jobs remain blocked.
- Rule handlers receive compact targets and explicitly read source when required.
- Cache hits do not perform execution-time source reads.
- Planned-source reads detect content changes.
- Rule concurrency is achievable across files without increasing an engine-owned source-session
  window.
- The 64 MiB regression and stable-ordering tests pass.
- All workspace plugins and documentation use the new contract without compatibility guards.

## Risks and follow-up decisions

### Repeated reads

Several jobs for one file may each read that file. This is intentional in the first implementation:
the operating system can serve repeated reads from its page cache, rule concurrency bounds active
reads, and model-backed work is expected to dominate read latency. Measurements should precede any
proposal for a shared source cache.

### Metadata contract size

Language metadata is the remaining path by which planning can retain large graphs. The metadata
inventory is therefore a prerequisite, not a cleanup after the scheduler refactor.

### Rules retaining source across model calls

Core can stop retaining source for queued jobs, but a running rule may keep a `SourceFile` local
while awaiting a model. Plugin migrations should derive prompts or compact analysis inputs in a
short helper and retain only those values for the remote call.
