export const trivialWrapperStackPrompt = `
You are reviewing one TypeScript file.

Task:
Warn about shallow wrapper chain designs.

Look for groups of local functions where one function mostly calls another local function, with parameter forwarding or light argument reshaping, and the chain does not add a meaningful policy or runtime boundary.

This is a warning-level design smell, not a correctness error.

The issue:
A file can split one operation across too many tiny helpers. This often appears as:
- one exported helper receives a context object and forwards selected fields to another helper
- another helper fetches a dependency and forwards the same operation to a lower-level helper
- functions differ mostly by domain prefixes in their names
- the call chain forces readers to jump across several functions to understand one behavior
- the functions do not add independent validation, retry behavior, lifecycle handling, concurrency control, telemetry, caching, permission checks, or error semantics

First decide whether the file has a qualifying chain of at least two shallow wrappers.
If there is no qualifying chain, return no findings.
If there is a qualifying chain, report the wrapper functions that should be considered for merging or for gaining a clearer boundary.

Do not report wrappers that add a real boundary, such as framework adaptation, stable public API facade, transaction scope, cache scope, trace or metric emission, dependency ownership, error conversion, retry policy, or a shared helper reused independently by several callers.

Do not judge prose above functions in this rule. Only evaluate whether the function boundary itself earns its existence.

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()
