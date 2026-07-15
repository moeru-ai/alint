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
- tool-call structured output under `@alint-js/core/structured-output`
- config DSL and types for advanced SDK consumers

## How to use

Write a rule:

```ts
import { defineRule } from '@alint-js/core'

export const rule = defineRule({
  create: ctx => ({
    async onTargetFile(target) {
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

### Agent adapter retry

Set `runner.agentRetries` to control how many times Alint may replay an agent
invocation after its initial attempt. The default is two retries; set it to `0`
to disable retries.

Alint retries only `RetryableAgentError` from `@alint-js/core/agent`. Throwing
this error is an adapter-level guarantee that replaying the complete invocation
cannot duplicate a started tool or another externally visible side effect.
Ordinary errors fail immediately. Third-party adapters may opt in by throwing
the error with their provider failure attached as `cause`.

Retry count, backoff, and exhaustion belong to the Alint runner. Adapters decide
only whether a particular failed invocation is safe to replay.

Ask a model for one validated, typed result with `@alint-js/core/structured-output`. It forces
the model to call a single reporting tool whose arguments match a valibot schema, validates
them, and retries with the validation error fed back to the model:

```ts
import { generateStructured } from '@alint-js/core/structured-output'
import { array, description, object, pipe } from 'valibot'

const responseSchema = pipe(
  object({ findings: array(findingSchema) }),
  description('Report findings for this file.'),
)

const { findings } = await generateStructured({
  createMessages: retryFeedback => [
    { content: prompt, role: 'system' },
    ...(retryFeedback ? [{ content: retryFeedback, role: 'user' as const }] : []),
    { content: numberedSource, role: 'user' },
  ],
  logger: ctx.logger,
  metering: ctx.metering,
  model: await ctx.model(),
  operation: 'my-rule-judge',
  schema: responseSchema,
})
```

The reporting tool is named `reportFindings` by default (`toolName` overrides it) and its
description defaults to the schema's valibot `description(...)`. `toolParametersFromSchema`,
`formatSourceWithLineNumbers`, and `formatOutputLanguageInstruction` are exported for callers
that build their own tools or prompts. Use `ctx.agent` instead when the model needs to
explore with tools before answering, because a forced tool call is a single shot, not a loop.

## When to use

- You are writing an `alint` plugin or rule package.
- You are adding a language processor or source extractor.
- You are embedding `alint` in another tool.
- You are implementing an `AgentAdapter`.

## When not to use

- Use `@alint-js/cli` for command-line usage and ordinary `alint.config.*` files.
- Use `@alint-js/config` for setup TOML, config loading, and config-file tooling only.
