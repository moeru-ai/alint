# Rust Rule Authoring Guide

This directory is intentionally empty of concrete rules until the Rust plugin has its own rule design.

## Boundaries

- Design Rust rules from Rust concepts first: crate boundaries, module ownership, traits, impl blocks, ownership/lifetimes, async runtimes, Cargo features, and RAII/Drop behavior.
- Do not copy another language plugin's rule shape unless the Rust rule has the same domain model and the same public behavior.
- Keep rule IDs under the `rust/` namespace when adding them to `src/index.ts`.
- Keep prompt text, context scouts, agents, and helper tools near the rule while the rule is small. Split them only when the boundary is useful for readability or testing.

## Required Shape

- Add focused tests before introducing a rule implementation.
- Export rule-local public helpers only when tests or downstream users need them.
- Keep the example config in `src/index.ts` aligned with the rules that actually exist.
- If a rule is model-backed, make its schemas provider-compliant and keep prompts Rust-specific rather than translated from another language.
