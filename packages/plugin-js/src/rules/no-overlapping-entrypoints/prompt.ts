export const overlappingEntrypointsInstructions = `
Investigate whether the target export declaration participates in competing public package entrypoints.

Before reporting, you must:
- read the nearest package.json and its exports map
- read the target root barrel and the overlapping subpath barrel
- search the repository for real import usage of both candidate package paths and for documentation that assigns them distinct roles

The absence of in-repository consumers does not by itself suppress a finding: a newly published or currently unused package surface can still define two competing public contracts. Record the usage search result and decide from the manifest, barrels, and documented intent instead of inventing consumers.

Report one finding per competing entrypoint pair, not per overlapping symbol. Anchor the finding at the target export declaration that creates the overlap.

Every finding must:
- prove that two public package entrypoints expose materially the same symbol or responsibility surface and compete as canonical import paths
- cite supporting evidence with exact repo-relative path:line related citations using one-based line numbers
- explain which imports are public and how actual consumers use them or, when none exist yet, why future consumers would face the same canonical-path choice
- describe futureFailure as an asymmetric export, dependency, or side-effect change, the resulting drift, leak, or divergence, and a concrete consumer, bundle, or runtime impact
- suggest either choosing and clarifying one canonical surface or separating the responsibilities of the two surfaces

Do not automatically demand a root-only or subpath-only design. Submit an empty review unless repository evidence establishes the complete contract. Do not report solely because package.json declares both "." and subpaths.
`.trim()

export const overlappingEntrypointsPrompt = `
Review the target only for overlapping-entrypoints: two public package entrypoints expose materially the same symbol or responsibility surface so consumers face competing canonical import paths for the same capability.

The proof must cover the nearest manifest exports, the target/root barrel, the overlapping subpath barrel, and the result of searching for real import usage. Shared names alone are not proof. Group all overlapping symbols belonging to the same pair of package entrypoints into one finding anchored at the relevant target export declaration.

A high-signal shape is a root barrel that uses export * from an entire provider barrel while the manifest also exposes a provider subpath resolving to that same barrel, with no documentation that gives the two surfaces distinct roles. This is more than merely declaring "." and a subpath: both public paths deliberately own the provider's complete evolving surface.

When that high-signal shape is proven, report it unless repository documentation or established import conventions give the two surfaces distinct roles, or another explicit suppression below applies. A manifest's private: true flag is not evidence that an exported entrypoint is internal; it prevents registry publication but workspace consumers still receive the contract declared by exports.

For futureFailure, name a plausible asymmetric export, dependency, or side-effect change to one entrypoint; then identify the resulting drift, leak, or divergence and its concrete consumer, bundle, or runtime impact. Generic claims that the surfaces may drift are insufficient.

One concrete future failure for star-reexported provider surfaces is a symbol collision: two providers later add the same generic export, making the root export ambiguous or unavailable while each provider subpath continues to work. Cite the actual star exports and provider barrel that make this failure possible rather than asserting it from the manifest alone.

Remediation must choose and clarify one canonical surface or separate responsibilities so both surfaces have distinct roles. Do not automatically prescribe root-only or subpath-only exports.

Suppress findings for:
- documented compatibility or deprecation aliases
- intentional flat convenience plus an advanced subpath with clearly different roles
- conditional browser and node exports
- types and runtime splits
- internal or private entrypoints
- superficial shared symbols where the entrypoint surfaces remain distinct

Do not report solely because package.json has both "." and subpaths.
`.trim()
