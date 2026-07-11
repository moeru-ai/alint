# @alint-js/plugin-example-rust

Example `alint` plugin scaffold for future Rust rules.

## What It Does

This package registers a Rust-focused plugin shell before `alint` has a Rust AST extractor. The example config targets `**/*.rs` as `text/plain`, but it does not enable any rules yet.

Concrete Rust rules should be designed separately under `src/rules/` from Rust concepts instead of copied from another language plugin.

## How To Use

```ts
import rustPlugin from '@alint-js/plugin-example-rust'

export default [
  {
    plugins: {
      rust: rustPlugin,
    },
  },
  ...rustPlugin.configs.example,
]
```

```ts
import { createRustPlugin } from '@alint-js/plugin-example-rust'

const rustPlugin = createRustPlugin()

export default [
  {
    plugins: {
      rust: rustPlugin,
    },
  },
  ...rustPlugin.configs.example,
]
```

## When To Use It

Use this scaffold when you want a package, build setup, tests, and documentation target for developing Rust-specific `alint` rules.

## When Not To Use It

Do not treat this package as a ready-to-run Rust lint rule set. It intentionally ships with no concrete rules until the Rust rule design is decided.
