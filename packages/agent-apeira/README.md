# `@alint-js/agent-apeira`

> [!IMPORTANT]
> This package is a WIP. APIs may be subject to major changes.

An [Apeira](https://github.com/moeru-ai/apeira)-backed `AgentAdapter` for alint. One of the swappable vendor adapters behind `@alint-js/agent`.

## What it does

`createApeiraAdapter()` returns an `AgentAdapter` that runs a rule's request through
Apeira's `chat` runner: it translates the framework-agnostic `AgentTool`s to xsai tools,
runs the tool loop (capped at 8 steps), and reads back the final answer and usage.

Each Apeira model step uses bounded inference retry by default: two retries for HTTP
408, 429, and 5xx responses and typed transport failures. Retry stays inside the failed
provider request, so completed steps and tool calls are not replayed. Pass
`{ retryPolicy }` to lower or tune the request retry budget.

Recovery after a partially consumed HTTP-200 response is not supported until
Apeira/xsAI exposes safe request-step resume.

## How to use

```ts
import { createApeiraAdapter } from '@alint-js/agent-apeira'

const adapter = createApeiraAdapter()
```

Pass `{ createRunner }` to inject a custom Apeira runner. The injected factory receives
the resolved model, maximum step count, and retrying provider `fetch`.

## When to use

- You want tool-using rules powered by Apeira on the xsai stack.

## When not to use

- You use a different agent framework. Pick that vendor's adapter (e.g.
  `@alint-js/agent-pi`) or write your own `AgentAdapter`.
- Your rule needs no tools. Keep it on the plain `@alint-js/core` rule DSL.
