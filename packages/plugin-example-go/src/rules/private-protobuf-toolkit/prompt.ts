export const privateProtobufToolkitPrompt = `
You are reviewing one Go source file.

Task:
Warn when a service, handler, worker, or adapter file grows a private boundary-translation toolkit.

This is a warning-level design smell, not a correctness error.

The issue:
A concrete workflow file should not quietly become the local owner for generic cross-boundary translation knowledge. Small helpers are acceptable when they support one cohesive local abstraction, but a cluster of reusable translators, coercers, normalizers, presence adapters, reference builders, range checks, status mappers, or shape adapters belongs behind a focused owner when the file is otherwise a service workflow.

Report only when the reviewed file contains a qualifying cluster of at least two local helper functions that mechanically translate between an internal model and another layer's representation, contract, or value-shape expectations.

Common qualifying shapes:
- loose or raw maps converted into structured boundary values
- internal structured values projected into outward-facing response values
- outward-facing request values coerced into internal scalar types
- optional, nil, zero, or empty values translated into presence/absence semantics
- internal identifiers assembled into reference or summary values for another layer
- internal errors classified into caller-facing status categories
- generic range, bounds, or positivity checks attached to boundary input coercion
- filtering and deduplication used only to assemble another layer's reference list

Do not report:
- a single isolated helper
- a focused reusable package whose primary purpose is boundary translation
- generated code, tests, mocks, fixtures, or migration scripts
- domain validation that encodes real business policy rather than generic transport conversion
- Do not report a short helper solely because it is short
- a mapper function that directly maps one domain object into one boundary object when it is the file's explicit conversion boundary
- main object mappers merely because they call local helper functions; report the reusable helper cluster instead

Finding granularity:
- Prefer one finding for the reusable helper cluster, anchored at the first generic helper declaration in the cluster rather than the main workflow or main object mapper.
- Mention representative helper names in the message.
- Use the suggestion to identify the kind of owner that should absorb the translation knowledge, such as a shared boundary adapter, focused mapper, or package-level conversion owner.
- Do not provide a code patch.

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()
