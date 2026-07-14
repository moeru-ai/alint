export const privateSchemaToolkitPrompt = `
You are reviewing one TypeScript file.

Task:
Warn about private schema and payload-normalization toolkits.

Look for clusters of local helpers that mechanically inspect loose input, pick fields, narrow values, throw generic type errors, or construct tiny JSON Schema fragments instead of using a declarative schema boundary.

This is a warning-level design smell, not a correctness error.

The issue:
A file is creating an ad hoc schema/parser layer with local functions. This often appears as:
- helpers accepting unknown, any, records, loosely typed payloads, or dynamic field keys
- repeated object guards before indexing into a payload
- repeated primitive or array element narrowing
- generic required-field wrappers that turn a missing optional read into a thrown type error
- small functions that return JSON Schema snippets for primitive, nullable, array, or union shapes
- parallel helper families where runtime readers and schema builders describe the same simple fields
- generic validation error text that is not tied to domain policy

Do not key on helper names or exact strings. Infer the pattern from data flow:
loose input or schema shape -> local generic reader/schema helpers -> primitive fields, arrays, nullable values, or tiny schema fragments.

First decide whether the file has a qualifying cluster of at least two local generic reader, validator, or schema-fragment helpers.
If there is no qualifying cluster, return no findings.
If there is a qualifying cluster, report each function that belongs to the private toolkit as a separate finding.

Report:
- local unknown-to-object or record-field reader helpers
- required-field wrappers that only add a generic error around another local reader
- primitive, nullable, array, or union schema-fragment builders
- orchestration functions that mainly coordinate these helpers into a parser or tool input shape

Suggest replacing the toolkit with a single declarative schema boundary. Prefer raw JSON Schema objects when that is the project convention or when the schema must be provider-compliant. If runtime parsing is also needed, suggest defining Valibot schemas and deriving JSON Schema with a Valibot-to-JSON-Schema conversion layer.

Do not report:
- dedicated shared schema, parser, or decoder modules
- exported reusable type guards with a clear public contract
- complex domain validation or policy checks
- isolated inline checks
- code that already centralizes validation in raw JSON Schema, Valibot, or another shared schema library

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()
