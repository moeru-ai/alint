# @alint-js/plugin-js

Model-backed JavaScript and TypeScript review rules for `alint`.

## What it does

This package demonstrates the public plugin and rule DSL from `@alint-js/plugin`. It exports `examplePlugin`, including a `recommended` config, with these rules in registry order:

- `example/inline-miniature-normalizer` reports clusters of local helpers that form a private reader or narrowing toolkit.
- `example/no-mixed-layers-without-abstraction` drafts declaration-level findings from complementary data-flow and ownership perspectives, then independently decides which candidates to report for consuming features that own independently reusable external-integration responsibilities without a stable interface.
- `example/no-private-schema-toolkit` reports clusters of local helpers that form an ad hoc schema or payload-normalization toolkit.
- `example/no-redundant-binding` reports local bindings that only rename an unchanged value or reference without adding a useful boundary.
- `example/no-redundant-jsdoc` reports JSDoc that mostly restates the documented declaration, signature, or implementation.
- `example/no-trivial-wrapper-stack` reports chains of shallow wrappers that add no meaningful policy or runtime boundary.
- `example/no-vacuous-function` reports functions whose shallow implementation does not earn a separate runtime boundary.

Each rule requests the configured model through its rule context, uses structured output to validate model findings, and reports accepted findings as source diagnostics.

`example/no-mixed-layers-without-abstraction` runs three sequential model-generation stages per uncached target file, with each stage subject to normal structured-output retries. Complementary data-flow and ownership perspectives improve candidate recall and boundary checks; the final stage reports or suppresses each candidate, trading additional inference cost and latency for more conservative findings.

## How to use

Configure individual rules in a TypeScript config:

```ts
import { defineConfig } from '@alint-js/cli'
import { examplePlugin } from '@alint-js/plugin-js'

export default defineConfig([
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      example: examplePlugin,
    },
    rules: {
      'example/inline-miniature-normalizer': 'warn',
      'example/no-mixed-layers-without-abstraction': 'warn',
      'example/no-private-schema-toolkit': 'warn',
      'example/no-redundant-binding': 'warn',
      'example/no-redundant-jsdoc': 'warn',
      'example/no-trivial-wrapper-stack': 'warn',
      'example/no-vacuous-function': 'warn',
    },
  },
])
```

You can also use the bundled recommended config:

```ts
import examplePlugin from '@alint-js/plugin-js'

import { defineConfig } from '@alint-js/cli'

export default defineConfig([
  {
    plugins: {
      example: examplePlugin,
    },
  },
  examplePlugin.configs?.recommended ?? [],
])
```

## When to use

- As a reference for writing model-backed rules.
- As a smoke-test plugin while trying the CLI.
- As a starting point for structured model output and diagnostic reporting patterns.
- To review consuming services that directly own several independently evolving layers of an external integration.

## When not to use

- Do not use these model-backed rules as a deterministic replacement for syntax-aware lint.
- Do not use `example/no-mixed-layers-without-abstraction` to require wrappers around simple one-off external calls or already-focused integration modules.
- Use `@alint-js/plugin-example-agent` when you need to study tool-using agentic rules.
- Use `@alint-js/plugin-example-go` when you want a plain-text example for non-JavaScript files.
