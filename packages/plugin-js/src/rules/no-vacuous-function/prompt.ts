export const vacuousFunctionPrompt = `
You are reviewing one TypeScript file.

Task:
Warn about vacuous functions: functions whose implementation is so shallow that the name does not earn a separate runtime boundary.

This is a warning-level design smell, not a correctness error.

The issue:
A vacuous function hides a simple expression, direct call, or tiny guard behind another symbol without adding domain policy, ownership, normalization, lifecycle, error handling, observability, caching, dependency selection, type conversion, or other meaningful behavior.

Report functions that mainly do one of these:
- directly forward parameters to another function, method, constructor, or prompt builder
- wrap a single expression, ternary, property access, primitive conversion, collection call, or string/number helper without adding policy
- only perform simple nullish checks such as != null, !== null, !== undefined, or typeof value !== 'undefined'
- only perform simple primitive checks such as typeof value === 'string', Number.isFinite, Number.isNaN, Array.isArray, Boolean(value), or a small conjunction of those checks
- only expose a generic type predicate or assertion whose body is a shallow runtime check
- contain a few guard lines and then return one obvious expression, when the guards are mechanical and caller-local

Do not key on function names or exact syntax. Infer whether the function creates a real boundary.

Report the declaration line of the vacuous function, not the call site. Report each qualifying function separately.

Do not report:
- functions that encode domain policy, permissions, invariants, feature gates, rate limits, security checks, or compliance rules
- functions that normalize or translate across external protocols, provider quirks, storage formats, or API boundaries
- functions that centralize a repeated rule whose meaning would be unclear or error-prone inline
- functions with meaningful error handling, logging, metrics, tracing, caching, retries, resource ownership, cleanup, async orchestration, or dependency injection
- public SDK or framework callbacks whose required shape makes the wrapper useful
- test helpers, fixture builders, mocks, or factories whose purpose is local test readability
- overloaded functions, generic helpers, or type guards when the type-level contract is the real API and callers benefit from the named abstraction

Use an aggressive but fair standard:
- If the function's best defense is "shorter spelling", "consistent name", "future-proofing", or "it might grow later", report it.
- If inlining the body at each call site would preserve readability and make the code more direct, report it.
- If the function name communicates a stable domain concept that is not obvious from the body, do not report it.
- If uncertain whether the function has a meaningful boundary, return no finding.

Return warnings only.
`.trim()
