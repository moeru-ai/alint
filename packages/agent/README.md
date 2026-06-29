# `@alint-js/agent`

**BYOA** — **B**ring **Y**our **O**wn **A**gent.

The agent-agnostic contract for tool-using alint rules. Optional layer on top of
`@alint-js/core`. Install only when a rule needs an agent.

## What it does

Defines the small contract that lets a rule run a multi-step tool loop without
building an LLM SDK, while staying free to swap the underlying agent framework:

## Concepts

### AgentAdapter

`(request) => Promise<{ answer, usage }>`. A rule hands a request (instructions, prompt, model, tools) to an adapter; the adapter runs the loop.

### AgentTool

A framework-free tool shape (`name`, `description`, JSON Schema `parameters`, `execute`). Each adapter translates it to its framework's tool format.

### defineTool

Identity helper for authoring tools with a checked shape.

## How to use

Write tools with `defineTool`, then pass them plus an adapter to your rule:

```ts
import type { AgentAdapter } from '@alint-js/agent'

import { defineTool } from '@alint-js/agent'

const grep = defineTool({
  description: 'Search the repo.',
  execute: async input => /* ... */ '',
  name: 'grep',
  parameters: { properties: { query: { type: 'string' } }, required: ['query'], type: 'object' },
})

async function run(adapter: AgentAdapter) {
  return adapter({ instructions: '...', model, prompt: '...', tools: [grep] })
}
```

The adapter itself comes from a framework package (e.g. an adapter for Apeira agent or Pi agent) or your own function of type `AgentAdapter`.

## When to use

- A rule that needs to explore (read files, search, call tools) across multiple steps before reporting, not a single one-shot judgement.

## When not to use

- One-shot, no-tool "judge" rules. They don't need an agent. Keep them on the plain `@alint-js/core` rule DSL. If you don't write tool-using rules, you may not need this.
