export const inlineMiniatureNormalizerPrompt = `
You are reviewing one TypeScript file.

Task:
Warn about private reader/narrowing tool-kits.

Look for clusters of local helper functions that mechanically parse, validate, pick, or narrow unknown, any, JSON-like, message, command, event, config, or transport payload values into primitives, records, arrays, literal unions, optional values, or simple typed fields.

This is a warning-level design smell, not a correctness error.

The issue:
A file is avoiding shared parser/decoder/schema utilities by creating a private parsing toolkit inside the file. This often appears as:
- local helper functions that accept unknown, any, or loosely typed input
- helpers that return primitive values, records, arrays, literal unions, optional values, or simple field values after type checks
- helpers that receive labels, paths, field names, or error text only to produce validation errors
- helpers that call each other to add generic constraints such as non-empty strings, finite numbers, string maps, object records, arrays, ids, dates, booleans, etc.
- helpers that silently return undefined for failed picks instead of throwing validation errors
- helpers that trim, cast, or reshape values as part of generic payload parsing
- the helpers are mechanical and reusable, not domain behavior

Do not key on helper names. Infer the pattern from data flow:
external or loose input -> local generic reader/narrowing helpers -> typed values or a typed object.

First decide whether a file has a qualifying cluster of at least two local generic reader/narrowing helpers.
If there is no qualifying cluster, return no findings.
If there is a qualifying cluster, report each function that belongs to that private parsing toolkit as a separate finding.

Report tiny leaf helpers even when they are only a few lines long, if they perform generic narrowing such as unknown-to-record, record-field-to-number, string trimming, finite-number checks, array-of-string checks, literal-union checks, or failed-pick-to-undefined behavior.
Report orchestration functions when they are part of that private parsing toolkit, even if they mainly call helper functions, assemble a typed object, map provider-specific field names, normalize usage/token objects, or otherwise coordinate helper results.

Selection example:
- If a normalizer accepts an unknown payload, calls a local unknown-to-record helper, then calls local field readers to build a typed object, report the normalizer, the leaf helper functions, and the field-reader functions.
- Report the whole private toolkit, not only the smallest helpers.

Do not report:
- dedicated parser/decoder/schema modules
- exported public type guards intended for reuse
- complex domain validation
- isolated inline checks
- code already using a shared decoder/schema utility

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()
