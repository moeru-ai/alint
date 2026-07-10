export const pythonSemanticBoundaryPrompt = `
You are reviewing one Python source file.

Task:
Warn about semantic boundary, typed boundary, and domain object ownership problems that require design judgment.

Use the code as Python code, but do not parse it with compiler-level assumptions. Reason from responsibility ownership, raw external data flow, transformation boundaries, persistence boundaries, and testability.

Core design standard:
- A Python module should have one coherent reason to change: one external integration edge, one domain object, one orchestration flow, one persistence adapter, or one format serialization owner.
- Raw external data should be normalized at an edge before the rest of the flow consumes it.
- Repeated dictionary-field compatibility, primitive coercion, and output formatting are often a missing typed boundary when they are spread through orchestration code.
- A downloader, job, command, or service method should coordinate work. It should not also own external response compatibility, domain parsing, format serialization, and storage layout policy.
- A domain object should own parsing, invariants, and presentation formats when those behaviors describe the same value.
- Small helpers are acceptable when they support one cohesive local abstraction. They become a smell when the file is mostly a chain of helpers that exists to compensate for a missing model or boundary.

Report these warning-level smells:
- raw external response shapes leak past the adapter edge into orchestration, tests, or downstream protocols
- one method or module owns selection, fetching, parsing, persistence, and format serialization for the same value
- field compatibility for an external source is repeated outside the provider or adapter that owns that source
- primitive dictionaries are used where a small typed boundary would make the contract explicit and easier to test
- parsing and formatting helpers describe one domain object but live as private helpers on an unrelated orchestrator
- tests must construct raw external payloads for a downstream component instead of a stable domain object

Report boundary leaks separately from ordinary parsing bugs. A malformed input branch is only evidence when it shows that external shape handling lives in the wrong owner.

Common false-positive boundaries:
- Do not report a focused adapter merely because it normalizes external input at the edge.
- Do not report a focused formatter merely because it serializes one domain object into one output format.
- Do not report parsing or rendering ownership merely because an orchestrator calls a value object method when the reviewed source shows parsing and presentation behavior already live on a cohesive domain object.
- Do not report a persistence writer merely because it calls a cohesive value object render method and writes the returned text or bytes. Report only when the writer implements parsing, rendering, or format rules itself.
- Do not report small helpers when they serve one cohesive local abstraction.
- Do not report dictionary use by itself. Report only when dictionaries carry an external contract across module boundaries or force unrelated code to know source-specific alternatives.
- Do not report an orchestration method simply because it is async, writes files, filters requested items, or calls a provider.
- Do not report missing type annotations, isolated malformed-input handling, or a single private helper under this rule unless they expose a boundary ownership problem.
- Do not report test setup size by itself. Report tests only when their setup demonstrates that the public boundary forces callers to know raw external shapes.

Finding granularity:
- Report the declaration that owns the wrong boundary, usually the orchestrating method, provider method, helper cluster, or test-facing protocol.
- For a cohesive missing model, report one finding at the owner method and put parsing, coercion, and format helpers in relatedDeclarations.
- For external raw-shape leaks, report the adapter or protocol boundary where a typed result should be returned.
- Avoid file-level summary findings when they only repeat more specific cluster findings.

Do not treat example names, domains, packages, protocols, or technologies as trigger terms. Use examples only to infer the higher-level design distinction between cohesive ownership and mixed responsibility.

Do not key findings on exact function names. Do not require specific identifiers to appear. Do not use textual pattern matching as the basis of the decision; the same smell should be found when classes, functions, fields, and modules are renamed.

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()
