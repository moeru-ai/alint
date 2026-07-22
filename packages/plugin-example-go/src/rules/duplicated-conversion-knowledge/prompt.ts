export const duplicatedConversionKnowledgeInstructions = `
Review the target for duplicated boundary-translation knowledge in Go code.

Use repository search tools and read relevant definitions before reporting. A shared name or similar shape is not enough: prove that the target and another file maintain the same boundary decision: value-presence policy, shape translation, identifier/reference assembly, scalar coercion, range validation, status/error mapping, defaulting, deduplication, enum/category mapping, or time-like value adaptation.

Evidence ladder:
1. For every local helper in the target that translates values across a package, layer, storage, service, or external-interface boundary, search sibling service, worker, adapter, and domain packages for the same responsibility. Search by behavior and imported types, not only by function name.
2. Read the target helper and the matching helper or mapper in full. Compare absence handling, zero-value handling, deduplication, category/status constants, error classification, value bounds, output shape, and observable fallback behavior.
3. Report only when both locations should change together under one common owner. Identify the plausible common owner and dependency direction.

Every finding must:
- anchor its primary line in the target file
- include at least one materially distinct related location outside the target path
- format every related location as an exact repo-relative path:line citation with a one-based line number
- describe futureFailure as a concrete asymmetric edit -> divergence -> impact sequence
- provide concrete repository proof and one remediation direction

Submit an empty review when repository evidence does not establish the shared responsibility.
`.trim()

export const duplicatedConversionKnowledgePrompt = `
Review the target for duplicated boundary-translation knowledge.

Categories:
- conversion-policy: one boundary translation contract is independently implemented in multiple places that should share an owner.
- conversion-mechanism: one reusable translation mechanism is reimplemented locally despite a compatible shared boundary being plausible.

Qualifying responsibilities include repeated helpers that translate loosely shaped data into structured values, structured values back into boundary payloads, internal identifiers into external references, external request scalars into internal scalar types, optional or zero values into presence/absence semantics, internal failures into caller-facing status categories, or raw category strings into typed domain categories.

Do not report:
- coincidental helper shapes without shared boundary responsibility
- generated code, tests, fixtures, or mocks
- independent trust-boundary validation that intentionally repeats a check
- exact helper clones already fully handled by simplicity/no-duplicated-helper unless the larger boundary policy is duplicated too
- a consolidation that would require an invalid dependency direction

Return warnings only. If the proof is incomplete, submit an empty review.
`.trim()
