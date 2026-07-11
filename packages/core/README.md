# `@alint-js/core`

The public SDK and run engine for `alint`.

## What it does

This package provides the core SDK and run engine APIs used by plugins, rules, language processors, embedding tools, and agent adapters:

- `definePlugin` and `defineRule`
- `runAlint`
- rule registry and flat config normalization
- source runtime helpers
- built-in JavaScript source extraction
- model resolution by size and capability
- diagnostics and progress payload types
- framework-neutral agent contracts under `@alint-js/core/agent`
- config DSL and types for advanced SDK consumers

## How to use

Write a rule:

```ts
import { defineRule } from '@alint-js/core'

export const rule = defineRule({
  create: ctx => ({
    async onTarget(target) {
      const model = await ctx.model({ size: 'small' })

      ctx.report({
        filePath: target.file.path,
        loc: target.loc,
        message: `reviewed with ${model.id}`,
      })
    },
  }),
})
```

Use the agent contract for tool-using rules:

```ts
import { requireAgent } from '@alint-js/core/agent'

const agent = requireAgent(ctx)
```

## When to use

- You are writing an `alint` plugin or rule package.
- You are adding a language processor or source extractor.
- You are embedding `alint` in another tool.
- You are implementing an `AgentAdapter`.

## When not to use

- Use `@alint-js/cli` for command-line usage and ordinary `alint.config.*` files.
- Use `@alint-js/config` for setup TOML, config loading, and config-file tooling only.
