# `alint` Agent Guide

- pnpm workspace, TypeScript, Vitest, ESLint.
- Components:
  - `packages/cli`: CLI entrypoint, argument parsing, setup/config commands, reporter output, and handoff into core.
  - `packages/config`: project config loading plus global/local setup TOML paths, parsing, merging, and writing.
  - `packages/core`: public rule/plugin DSL, run engine, source extraction/runtime, model resolution, diagnostics, cache, and usage tracking.
  - `packages/plugin-example`: example rule plugin that exercises the public SDK and model-backed rule flow.

## Structure & Responsibilities

- Build pipeline refs: `.github/workflows`; lint rules in `eslint.config.ts`.

## Commands (pnpm with filters)

> Use pnpm workspace filters to scope tasks. Examples below are generic; replace the filter with the target workspace name (e.g. `@alint-js/core`, etc.).

- **Typecheck**
  - `pnpm -F <package.json name> typecheck`
  - Example: `pnpm -F @alint-js/cli typecheck` (runs `tsc`).
- **Unit tests (Vitest)**
  - Targeted: `pnpm exec vitest run <path/to/file>`
    e.g. `pnpm exec vitest run packages/cli/src/cli/cli.test.ts` (not recommended as we prefer to run entire package test instead of file)
  - Workspace: `pnpm -F <package.json name> exec vitest run`
    e.g. `pnpm -F @alint-js/cli exec vitest run`
  - Root `pnpm test:run`: runs all tests across registered projects. If no tests are found, check `vitest.config.ts` include patterns.
  - Root `vitest.config.ts` includes `packages/cli` and other projects; each app/package can have its own `vitest.config`.
- **Lint**
  - `pnpm lint` and `pnpm lint:fix`
  - Formatting is handled via ESLint; `pnpm lint:fix` applies formatting.
- **Build**
  - `pnpm -F <package.json name> build`
  - Example: `pnpm -F @alint-js/cli build` (typecheck + electron-vite build).

## Development Practices

- Favor clear module boundaries; shared logic goes in `packages/`.
- Keep runtime entrypoints lean; move heavy logic into services/modules.
- Prefer functional patterns + DI (`injeca`) for testability.
- Use Valibot for schema validation; keep schemas close to their consumers.
- Use Eventa (`@moeru/eventa`) for structured IPC/RPC contracts where needed.
- Use `errorMessageFrom(error)` from `@moeru/std` to extract error messages instead of manual patterns like `error instanceof Error ? error.message : String(error)`. Pair with `?? 'fallback'` when a default is needed.
- Do not add backward-compatibility guards. If extended support is required, write refactor docs and spin up another Codex or Claude Code instance via shell command to complete the implementation with clear instructions and the expected post-refactor shape.
- If the refactor scope is small, do a progressive refactor step by step.
- When modifying code, always check for opportunities to do small, minimal progressive refactors alongside the change.

## Testing Practices

- Vitest per project; keep runs targeted for speed.
- For any investigated bug or issue, try to reproduce it first with a test-only reproduction before changing production code. Prefer a unit test; if that is not possible, use the smallest higher-level automated test that can still reproduce the problem.
- When an issue reproduction test is possible, include the tracker identifier in the test case name:
  - GitHub issues: include `Issue #<number>`
  - Internal bugs tracked in Linear: include the Linear issue key
- Add the actual report link as a comment directly above the regression test:
  - GitHub issue URL for GitHub reports
  - Discord message or thread URL for IM reports
  - Linear issue URL for internal bugs
- Mock IPC/services with `vi.fn`/`vi.mock`; do not rely on real Electron runtime.
- For external providers/services, add both mock-based tests and integration-style tests (with env guards) when feasible. You can mock imports with Vitest.
- Grow component/e2e coverage progressively (Vitest browser env where possible). Use `expect` and assert mock calls/params.
- When writing tests, prefer line-by-line `expect` or assertion statements.
- Avoid writing tests for impossible runtime states, such as `expect` against constants that never change, or asserting object mutations that can only happen inside the same Vitest case setup.
- Avoid mocking `globalThis` or built-in modules by directly using `Object.defineProperty(...)`. If needed, use `node:worker_threads` to load another worker and simulate that situation, or build a mini CLI to reproduce and verify behavior. For DOM and Web Platform APIs, prefer Vitest browser mode instead of hard-mocking platform internals. If tests already use those patterns, progressively refactor them.
- Do not use Vitest mocks, hoisting, dynamic imports, `as unknown as`, or test-only alternate import paths to maliciously bypass real import problems. If a test cannot import a module, investigate the actual compile/runtime boundary: package exports, side effects, mixed Node/browser type dependencies, circular imports, and whether the public module shape is wrong. Fix the boundary instead of hiding the failure in the test.

## TypeScript / IPC / Tools

- Keep JSON Schemas provider-compliant (explicit `type: object`, required fields; avoid unbounded records).
- Favor functional patterns + DI (`injeca`); avoid new class hierarchies unless extending browser APIs (classes are harder to mock/test).
- Centralize Eventa contracts; use `@moeru/eventa` for all events.
- Import types from the module or package that owns the contract. Do not redeclare external/public contracts locally just to use a narrower subset, and do not route type imports through local runtime assembly modules when the original side-effect-free type source is available.
- Do not use inline type imports such as `typeof import('...').x` or `import('...').Type` to avoid normal module boundaries. Export explicit shared types from the owning module, import external contract types from their owning package, or split a dedicated side-effect-free type module when runtime imports would pull in the wrong environment.
- Do not directly modify or override `tsconfig.json` to make an import/type error disappear. First investigate compilation behavior, `package.json` `exports` declarations, type declarations, and whether the dependency exposes the intended browser/node entrypoints.
- When Node-only and browser-only types are mixed through one import chain, split the type declarations into a neutral type file and keep runtime modules environment-specific. Avoid importing values from modules that carry side effects just to obtain types.
- If a wrong export or missing export causes an error, trace the full import chain and side-effect chain before changing imports at the leaf. Prefer fixing package/module exports and the owning boundary over adding local workaround imports.
- Treat circular imports as a design problem. If a cycle appears, first reconsider ownership, module boundaries, and whether shared types or pure helpers need to move. If the cycle cannot be resolved confidently, ask the user for direction before continuing.
- When a user asks to use a specific tool or dependency, first check Context7 docs with the search tool, then inspect actual usage of the dependency in this repo.
- If multiple names are returned from Context7 without a clear distinction, ask the user to choose or confirm the desired one.
- If docs conflict with typecheck results, inspect the dependency source under `node_modules` to diagnose root cause and fix types/bugs.

## Readability, Naming, and Comments

- File names: camelCase.
- Prefer names that rely on the module boundary for context instead of repeating package, product, protocol, or transport prefixes inside every symbol. A well-named module should let exported functions use short action-first names; repeat the larger context only when the symbol crosses a boundary where that context is no longer obvious.
- Name functions after the domain operation they perform, not after the implementation layer that happens to contain them. This keeps call sites readable after refactors and avoids names becoming stale when code moves between files.
- Avoid names that encode multiple layers of ownership into one symbol. If a name needs several qualifiers to be understandable, reconsider the module boundary or introduce a clearer local concept.
- Use nouns for resolved domain concepts and verbs for transformations or side effects. When a function derives a policy/configuration from an event or request, name the domain result explicitly so callers understand what decision is being made.
- Prefer classes for runtime/browser APIs and substantial business modules when the class owns state, lifecycle, or a stable domain boundary. Prefer FP for pure transformations and local helpers.
- Use dependency injection only at real external boundaries: database, model runtime, queue, Redis/cache, filesystem, network, clock, environment, and feature gates. Do not introduce `Dependencies`/`Deps` objects for internal functions that only call sibling helpers or forward parameters.
- Comments should reduce reader uncertainty, not increase documentation volume.
- Write comments where a reader would otherwise ask why this case can happen, why this branch is ignored, why this fallback exists, why this order matters, what state changed here, what external side effect just happened, or what protocol/invariant this line is preserving.
- Good comments explain hidden intent, constraints, ownership, invariants, ordering, side effects, protocol shape, or non-obvious fallback behavior.
- Bad comments translate code into English, restate names/types, or exist only to satisfy hover documentation.
- Important implementation comments should live near the confusing line or branch, not only on exported declarations.
- For calculation-heavy code, prefer inline comments near the intermediate values and branches that need explanation. Do not rely only on function-level JSDoc when the hard part is a coordinate system, unit conversion, clamp, rounding rule, aggregation, fallback, or precedence decision.
- Apply this especially to geometry, graphics and shader math, billing or metering, analytics or statistics, UI layout and positioning, ranking or scoring, and normalization code.
- Format longer comments as short paragraphs separated by blank comment lines. Do not compress background, symptom, rejected alternatives, final rationale, and references into one dense block.
- For investigation-heavy comments, prefer this order when useful: source/context, observed failure, why the obvious fix is insufficient, chosen fix, and references/removal condition.
- Do not add broad comments like `// Config`, `// Host`, or `// Update state` unless they explain a non-obvious boundary or transition.
- Add clear, concise comments for utils, math, OS-interaction, algorithm, shared, and architectural functions that explain non-obvious intent, invariants, constraints, or why the code is needed.
- When using a workaround, add a `// NOTICE:` comment explaining why, the root cause, and any source context. If validated via `node_modules` inspection or external sources (e.g., GitHub), include relevant line references and links in code-formatted text.
- When copying, adapting, or deriving code, configuration, constants, schemas, ignore patterns, algorithms, or rules from an external repository, add a nearby `// NOTICE:` comment with a GitHub permalink pinned to the source commit and exact line reference. Use single-line references like `https://github.com/eslint/eslint/blob/833ec10fd702644e94334edd3cd2aa313174a958/.editorconfig#L11` and multi-line references like `https://github.com/eslint/eslint/blob/833ec10fd702644e94334edd3cd2aa313174a958/.editorconfig#L11-L17`. Do not use branch links such as `main` or links without line numbers for traceable source references.
- When moving/refactoring/fixing/updating code, keep still-accurate comments with the code. Remove obsolete comments rather than preserving their history in source; explain notable removals in review notes when needed.
- Avoid stubby/hacky scaffolding; prefer small refactors that leave code cleaner.
- Use markers:
  - `// TODO:` follow-ups
  - `// REVIEW:` concerns/needs another eye
  - `// NOTICE:` magic numbers, hacks, important context, external references/links

## PR / Workflow Tips

- Rebase pulls; branch naming `username/feat/short-name`; clear commit messages (gitmoji is prohibited).
- Summarize changes, how tested (commands), and follow-ups.
- Improve legacy you touch; avoid one-off patterns.
- Keep changes scoped; use workspace filters (`pnpm -F <package> <script>`).
- Maintain structured `README.md` documentation for each `packages/` and `apps/` entry, covering what it does, how to use it, when to use it, and when not to use it.
- Always run `pnpm type-check` and `pnpm lint` after finishing a task.
- Use Conventional Commits for commit messages (e.g., `feat(<package name>): added something`).
- For new feature requirements or requirement-related tasks involving `node:*` built-in modules, DOM operations, Vue composables, React hooks, Vite plugins, or GitHub Actions workflows, always do deep research for suitable existing libraries or open source modules first. Before choosing any library, always ask the user to choose and help judge which option is right. Never choose generalized utility libraries on your own (for example, `es-toolkit`, utilities from `github.com/unjs`, or tiny tools from `github.com/tinylib`) without explicit user confirmation. If the user is working spec-driven, list candidate choices in a clear and concise Markdown comparison table.
- Before planning or writing new utilities/functions, always search for existing internal implementations first. If the logic could become shared utilities, proactively propose that shared approach to users and developers.
