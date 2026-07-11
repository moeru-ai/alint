# `@alint-js/plugin-example-rust` Agent Guide

This package is a scaffolded example `alint` plugin for future Rust rules.

## Scope

- The example config targets `**/*.rs` as `text/plain`; it does not provide a Rust AST extractor, Cargo metadata reader, compiler-aware symbol graph, or concrete rules yet.
- This package may evolve independently from other example plugins. Follow the local API exports and tests instead of preserving another package's internal file layout.
- Do not constrain how `src/rules/` is organized. A rule may keep its prompt, tools, scouts, agents, tests, or helper modules together or split them out when that makes the Rust example clearer.

## Files

- `src/index.ts`: plugin factory, example config, and public exports.
- `src/rules/`: rule implementations and any rule-local prompt, context, agent, tool, or helper modules.
- `src/tools/*`: generic file listing, reading, and literal search tools available for future rule scouts or agents.

## Development

- Run targeted tests with `pnpm exec vitest run --config packages/plugin-example-rust/vitest.config.ts packages/plugin-example-rust/src/index.test.ts`.
- Run package typecheck with `pnpm -F @alint-js/plugin-example-rust typecheck`.
- After edits, also run root `pnpm typecheck` and `pnpm lint` when feasible.
