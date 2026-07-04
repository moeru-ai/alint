# @alint-js/plugin-example-go

Example `alint` plugin for semantic Go responsibility-boundary review.

## What It Does

This package demonstrates how to review Go files before `alint` has a Go AST extractor. The example config targets `**/*.go` as `text/plain`, sends the whole file to a model-backed rule, and asks the model to report responsibility-boundary smells that are hard to express with syntax-only checks.

The example rule focuses on semantic Go design issues: files with too many unrelated reasons to change, constructors that are split away from the lifecycle work that makes their values safe, generic wiring files that absorb domain policy, and small helper chains that obscure a missing cohesive owner.

## How To Use

```ts
import goPlugin from '@alint-js/plugin-example-go'

export default [
  {
    plugins: {
      go: goPlugin,
    },
  },
  ...goPlugin.configs.example,
]
```

The rule also uses an internal tool-using context scout to inspect nearby files before
the final responsibility-boundary judgment. The scout can read files, list Go files,
and search Go files under the project root. If the scout fails, the rule falls back to
deterministic local context collection.

```ts
import { createGoPlugin } from '@alint-js/plugin-example-go'

const goPlugin = createGoPlugin()

export default [
  {
    plugins: {
      go: goPlugin,
    },
  },
  ...goPlugin.configs.example,
]
```

## When To Use It

Use this example when you want to inspect Go source with a natural-language architectural rule:

- flag Go files that have too many unrelated responsibilities
- suggest moving dependency setup, lifecycle cleanup, health checks, and startup side effects into cohesive constructors or owner types
- suggest moving domain policy/defaults near the owning package or abstraction
- surface TypeScript-style tiny orchestration functions that obscure Go package ownership

## When Not To Use It

Do not use this as a substitute for a future Go language extractor when you need symbol-accurate navigation, compiler diagnostics, or AST-level transformations. This plugin intentionally relies on prompt-based judgment and structured model output.
