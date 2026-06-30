# `@alint-js/agent-pi`

> [!IMPORTANT]
> This package is a WIP. APIs may subject to major changes.

A [Pi](https://github.com/earendil-works/pi)-backed `AgentAdapter` for alint. One of the swappable vendor adapters behind `@alint-js/agent`.

## What it does

`createPiAdapter()` returns an `AgentAdapter` that runs a rule's request through a Pi
`Agent`: it translates the framework-agnostic `AgentTool`s to Pi's TypeBox tools, runs
the tool loop, and reads back the final assistant message.

## How to use

```ts
import { createPiAdapter } from '@alint-js/agent-pi'

const adapter = createPiAdapter()
```

Pass `{ run }` to inject a custom Pi run.

## When to use

- You want tool-using rules powered by Pi (`pi-ai` and `pi-agent-core`).

## When not to use

- You use a different agent framework. Pick that vendor's adapter (e.g.
  `@alint-js/agent-apeira`) or write your own `AgentAdapter`.
- Your rule needs no tools. Keep it on the plain `@alint-js/core` rule DSL.
