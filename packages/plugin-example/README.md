# `@alint-js/plugin-example`

Example `alint` plugin for model-backed JavaScript and TypeScript review rules.

## What it does

This package demonstrates the public plugin and rule DSL from `@alint-js/core`. It exports `examplePlugin` with a `recommended` config and three example rules:

- `example/inline-miniature-normalizer`
- `example/no-redundant-jsdoc`
- `example/no-trivial-wrapper-stack`

The rules show how to request a model from `ctx.model(...)`, send source context to a structured judge, and convert model findings into lint diagnostics.

## How to use

```ts
import { defineConfig } from '@alint-js/core'
import { examplePlugin } from '@alint-js/plugin-example'

export default defineConfig([
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      example: examplePlugin,
    },
    rules: {
      'example/inline-miniature-normalizer': 'warn',
      'example/no-redundant-jsdoc': 'warn',
      'example/no-trivial-wrapper-stack': 'warn',
    },
  },
])
```

You can also use the bundled recommended config:

```ts
import examplePlugin from '@alint-js/plugin-example'

export default [
  {
    plugins: {
      example: examplePlugin,
    },
  },
  ...examplePlugin.configs.recommended,
]
```

## When to use

- As a reference for writing model-backed rules.
- As a smoke-test plugin while trying the CLI.
- As a starting point for structured model output and diagnostic reporting patterns.

## When not to use

- Do not treat this as a production rule set. It is intentionally an example package.
- Use `@alint-js/plugin-example-agent` when you need to study tool-using agentic rules.
- Use `@alint-js/plugin-example-go` when you want a plain-text example for non-JavaScript files.
