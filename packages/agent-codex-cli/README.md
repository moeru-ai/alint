# `@alint-js/agent-codex-cli`

> [!IMPORTANT]
> This package is a WIP. APIs may be subject to major changes.

A Codex CLI-backed `AgentAdapter` for alint. It delegates execution to the official
`@openai/codex-sdk`, which wraps the local `codex` CLI and owns the JSONL event
protocol.

## What it does

`createCodexCliAdapter()` returns an `AgentAdapter` that starts a Codex thread,
sends the rule prompt, and maps the SDK run result back to alint's `{ answer,
usage }` shape. Codex uses its own local configuration, AGENTS instructions,
sandboxing, MCP servers, and tool runtime.

Codex owns retries below the SDK turn boundary. Its model provider configuration
supports `request_max_retries` and `stream_max_retries`; pass them through
`CodexCliAdapterOptions.config` to adjust the defaults. See the official
[Codex configuration reference](https://developers.openai.com/codex/config-reference/)
for the available settings.

Alint never retries `thread.run()`. A failed turn may already have executed
commands or changed files, so replaying the whole turn could duplicate those
effects.

## How to use

```ts
import { createCodexCliAdapter } from '@alint-js/agent-codex-cli'

const adapter = createCodexCliAdapter({
  sandbox: 'read-only',
})
```

For example, if a provider named `proxy` is already defined and selected in the
user's Codex configuration, this overlay customizes its native retry budgets:

```ts
const adapter = createCodexCliAdapter({
  config: {
    model_providers: {
      proxy: {
        request_max_retries: 2,
        stream_max_retries: 3,
      },
    },
  },
  sandbox: 'read-only',
})
```

Pass `{ useRequestModel: true }` only when alint's resolved model should override
the local Codex model configuration.

## When to use

- You want alint rules to delegate a check to the local Codex CLI environment.
- You want Codex to decide which of its own tools to use.

## When not to use

- Your rule needs alint `AgentTool` callbacks. This adapter rejects them because
  Codex CLI does not execute in-process JavaScript tool callbacks.
- You need direct OpenAI-compatible chat completion calls. Use a structured-output
  rule or another agent adapter instead.
