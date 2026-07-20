export const testOnlyProductionWrapperInstructions = `
Investigate only shallow exported functions or wrappers declared in production source that may exist solely to support tests.

Before reporting a candidate, you must:
- search for all static references to the exported symbol, including imports, re-exports, aliases, and known registry entries
- read every found use relevant to deciding whether the symbol has production consumers or earns a production boundary
- read the nearest package.json exports map and the relevant barrels to establish package-public reachability
- cite the supporting repository evidence with exact repo-relative path:line citations using one-based line numbers

Report only when the complete repository evidence proves all of these conditions:
- references outside the declaration are exclusively in test or fixture files
- the wrapper is not reachable from package public exports
- the wrapper does not earn a production boundary through policy, protocol adaptation, lifecycle, dependency ownership, or other meaningful behavior

For futureFailure, describe this concrete failure mode: tests exercise alternate semantics or an alternate path through the wrapper while production uses a different function or path, so a future change lets tests pass while production diverges or fails.

Suggest moving the convenience wrapper to test code or making tests exercise the production path. If the symbol is intended to be an API, suggest establishing its contract, exporting it, and using it in production.

Submit an empty review when the complete reference search is insufficient or any suppression applies.
`.trim()

export const testOnlyProductionWrapperPrompt = `
Review the target for test-only-production-wrapper findings.

A candidate must be a shallow exported function or wrapper in production source. Repository evidence must prove that every relevant reference is exclusively in a test or fixture, that the nearest package.json exports and barrels do not make it package-public, and that it earns no production boundary.

Suppress findings for:
- package-public APIs with possible external consumers
- framework callbacks, reflection hooks, or registry discovery
- documented test seams
- external boundary dependency injection, including clock, file system, and network dependencies
- meaningful protocol, error, or type conversion
- production use through aliases, dynamic imports, or known registries
- an insufficiently complete reference search

Production use of the underlying function does not make the wrapper production-used. Conversely, do not report merely because a wrapper is short: the exclusive test or fixture references and lack of public reachability must both be proven with exact path:line citations.

The required future failure is concrete: tests exercise alternate semantics or a different path while production uses a different function or path, allowing tests to pass as production diverges or fails after a change.

The remediation is to move the convenience wrapper into test code or make tests exercise the production path. If it is an intended API, establish and export the contract and use it in production.
`.trim()
