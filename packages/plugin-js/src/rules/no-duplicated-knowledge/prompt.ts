export const duplicatedKnowledgeInstructions = `
Investigate whether the target independently maintains knowledge that the repository already owns elsewhere.

Use repository search tools and read the relevant definitions and call sites before reporting any finding. A shared word or shape is not enough: prove that the locations carry one shared responsibility and must change together.

Before deciding that the review is empty, complete this bounded evidence ladder for candidates visible in the target:
1. For policy-looking constant identifiers and numeric bounds used by clipping, slicing, schema validation, or collection limits, search the surrounding package and sibling modules for the same identifiers, values, and affected fields. Compare raw-input validators, domain normalizers, and output formatters when those stages exist.
2. For a captured Promise or other cached async state that is reset on rejection, search sibling clients and shared utilities for the same state transition even when helper names and syntax differ; then read the complete implementations to compare retry, lifetime, and rejection semantics.
3. Read the candidate owners and their callers far enough to decide whether they encode one decision, and only then report or submit an empty review. Stop once the relevant package evidence is exhausted; do not broaden into unrelated subsystems.

For every captured Promise candidate, search the whole package for memo helper names and catch handlers that reset cached state to undefined, as well as equivalent rejection-eviction syntax. Do not stop after the first qualifying finding: complete the bounded investigation for both categories before submitting the review.

Every finding must:
- anchor its primary line in the target file
- include at least one materially distinct related location outside that primary path and line
- format every related location as an exact repo-relative path:line citation with a one-based line number
- identify a plausible common owner and a valid dependency direction toward it
- provide concrete repository proof, a concise message, and a concrete remediation suggestion
- describe futureFailure as a concrete asymmetric edit -> divergence -> impact sequence, not generic maintainability prose

Submit an empty review when repository evidence does not establish the full contract.
`.trim()

export const duplicatedKnowledgePrompt = `
Review the target for duplicated design knowledge in exactly these categories:

- policy: one protocol, domain, or design constraint, or one normalization contract, is independently maintained in multiple places that must change together.
- mechanism: reusable behavior or an algorithm is expanded inline or independently reimplemented despite an existing compatible implementation or plausible common owner.

Report only when repository evidence proves the same decision or reusable behavior, the shared responsibility, and a plausible consolidation boundary. State which location should own the knowledge or how dependencies should point toward a common owner.

Do not report:
- coincidental literals or names
- syntactic similarity without shared knowledge
- intentional defense-in-depth execution fed by one common source
- distinct trust-boundary policies that must remain independently enforced
- incompatible semantics, especially different promise-rejection reset, retry, lifetime, or cache behavior
- a consolidation that would require an invalid dependency direction
- duplication already fully captured as a whole small helper clone by simplicity/no-duplicated-helper

For futureFailure, name a likely edit to only one location, the resulting divergence, and its concrete runtime, protocol, or user impact. "These copies may drift" is not sufficient.

Layered enforcement is not automatically defense in depth: when a validator, normalizer, and formatter each hard-code the same field bounds instead of consuming one common source, they maintain duplicated policy. Hard-coded knowledge at each stage is not a common source merely because the current values agree. A concrete failure chain is that parser and normalizer limits change together and their tests pass while a serialized or otherwise formatted representation keeps the old bound and silently truncates valid data.

A private compatible helper in a sibling provider or client can prove that the repository already contains the mechanism and that a package-level utility is a plausible common owner. Do not recommend importing the private sibling module directly; recommend extracting the compatible mechanism only when dependency direction and semantics permit it.
`.trim()
