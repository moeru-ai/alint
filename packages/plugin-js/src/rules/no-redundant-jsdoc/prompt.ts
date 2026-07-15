export const redundantJsdocPrompt = `
You are reviewing one TypeScript file.

Task:
Warn about redundant JSDoc.

Look for block comments on functions, interfaces, or exported values that are much longer than the behavior they explain and mostly restates the function name, signature, or body.

This is a warning-level readability smell, not a correctness error.

The issue:
Verbose comments create maintenance cost when they do not tell readers anything the code cannot already say. This often appears as:
- "Use when", "Expects", or "Returns" sections that repeat parameter names and return types
- comments that describe ordinary await, throw, resolve, or null behavior without explaining why
- comments that list generic call sites instead of a real invariant, protocol requirement, or external constraint
- comments whose main content can be inferred from the symbol name and TypeScript types

First decide whether a comment is redundant enough to remove or shorten.
If there is no qualifying redundant comment, return no findings.
If there is a qualifying comment, report the declaration line it documents.

Do not report comments that explain non-obvious runtime behavior, external service behavior, retry behavior, failure modes, protocol constraints, security invariants, ordering requirements, removal conditions, or a surprising reason for not throwing an error.

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()
