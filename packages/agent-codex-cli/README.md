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

## How to use

```ts
import { createCodexCliAdapter } from '@alint-js/agent-codex-cli'

const adapter = createCodexCliAdapter({
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
