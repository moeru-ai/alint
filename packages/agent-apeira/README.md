# `@alint-js/agent-apeira`

> [!IMPORTANT]
> This package is a WIP. APIs may subject to major changes.

An [Apeira](https://github.com/moeru-ai/apeira)-backed `AgentAdapter` for alint. One of the swappable vendor adapters behind `@alint-js/agent`.

## What it does

`createApeiraAdapter()` returns an `AgentAdapter` that runs a rule's request through
Apeira's `chat` runner: it translates the framework-agnostic `AgentTool`s to xsai tools,
runs the tool loop (capped at 8 steps), and reads back the final answer and usage.

## How to use

```ts
import { createApeiraAdapter } from '@alint-js/agent-apeira'

const adapter = createApeiraAdapter()
```

Pass `{ createRunner }` to inject a custom Apeira runner.

## When to use

- You want tool-using rules powered by Apeira on the xsai stack.

## When not to use

- You use a different agent framework. Pick that vendor's adapter (e.g.
  `@alint-js/agent-pi`) or write your own `AgentAdapter`.
- Your rule needs no tools. Keep it on the plain `@alint-js/core` rule DSL.
