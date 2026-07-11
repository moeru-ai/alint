# `alint`

![Demo](https://raw.githubusercontent.com/moeru-ai/alint/main/docs/assets/demo.gif)

`alint` is an [`eslint`](https://eslint.org/) inspired agentic code analysis tool for vibe-coded code that needs another look. It runs model-backed rules against source files, reports diagnostics in a familiar lint format, and lets rule authors use plain model calls or swappable tool-using agents when a rule needs deeper context.

While `alint` is inspired by `eslint`, we expect the concept that `alint` brings to the table to be a new paradigm for code analysis. It should not be limited to just JavaScript/TypeScript. You can extend this to other languages, non-code artifacts, generated files, or any content a plugin knows how to review.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
## Table of Contents

- [Installation and Usage](#installation-and-usage)
- [Concepts](#concepts)
- [Packages](#packages)
- [Documentation Automation](#documentation-automation)
- [Development](#development)
- [Status](#status)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Installation and Usage

### Prerequisites

`alint` is published as ESM packages and is intended for modern Node.js projects. Install Node.js and a package manager such as npm or pnpm before using the CLI.

You also need at least one OpenAI-compatible model provider. Local providers such as Ollama and LM Studio work well for repeated lint runs because they keep token cost predictable.

### Install the CLI

Install globally if you want an `alint` command available everywhere:

```bash
npm install -g @alint-js/cli
pnpm add -g @alint-js/cli
```

Or install it in a project and run it through your package manager:

```bash
npm install -D @alint-js/cli
npx alint src
```

```bash
pnpm add -D @alint-js/cli
pnpm exec alint src
```

### Configure a Model Provider

Use `alint setup` to write provider configuration. The `-N` flag is short for `--no-interactive`, so setup can run in scripts or through coding agents without opening an interactive TUI.

Without `--local`, setup writes the global config at `~/.config/alint/config.toml`. With `--local`, it writes `.alint/config.toml` in the current project.

<details>
<summary>Ollama</summary>

```bash
alint setup -N \
  --provider-endpoint http://localhost:11434/v1 \
  --provider-model qwen:8b
```

</details>

Write provider setup into the current project when a repository should carry its own model mapping:

```bash
alint setup -N \
  --local \
  --provider-endpoint http://localhost:11434/v1 \
  --provider-model qwen:8b
```

<details>
<summary>LM Studio</summary>

```bash
alint setup -N \
  --provider-endpoint http://localhost:1234/v1 \
  --provider-model qwen:8b
```

</details>

<details>
<summary>OpenRouter</summary>

```bash
export OPENROUTER_API_KEY="sk-..."

alint setup -N \
  --provider-endpoint https://openrouter.ai/api/v1 \
  --provider-header "Authorization=Bearer $OPENROUTER_API_KEY" \
  --provider-header "HTTP-Referer=http://localhost" \
  --provider-header "X-OpenRouter-Title=alint" \
  --provider-model openrouter:fusion
```

</details>

<details>
<summary>OpenAI</summary>

```bash
export OPENAI_API_KEY="sk-..."

alint setup -N \
  --provider-endpoint https://api.openai.com/v1 \
  --provider-header "Authorization=Bearer $OPENAI_API_KEY" \
  --provider-model gpt-5.4-mini
```

</details>

### Run alint

Run the CLI against files or directories:

```bash
alint src
alint demo.ts
alint --format json demo.ts
```

Override the matched model for a one-off run:

```bash
alint --model qwen:8b demo.ts
```

Ask model-backed rules to write diagnostics in a specific language:

```bash
alint --lang zh-CN src
```

`alint` returns exit code `1` when diagnostics are reported and `0` when the run is clean.

### Inspect Configuration and Output

Useful CLI commands:

```bash
alint config inspect src/index.ts
alint config providers list
alint config models list
alint config models probe
```

Save machine-readable output and inspect it later without rerunning model calls:

```bash
alint --format json src > alint-output.json
alint output inspect alint-output.json
```

## Concepts

`alint` keeps the familiar lint shape: select targets, apply named rules, report diagnostics, and return an exit code that CI can understand. The difference is that a rule can reach its judgment through model calls or a tool-using agent when syntax-only checks are not enough.

### `alint` User side

#### Configurations

In order to provision models and LLMs for `alint` while keeping it clean for contributors of your project without requiring them to set up their own LLMs, `alint` offers layers of configuration covering **Project Local**, **Global**, project config, and environment or CLI overrides.

The priorities follow:

```text
~/.config/alint/config.toml < .alint/config.toml < alint.config.ts < environment and CLI overrides
```

- `~/.config/alint/config.toml` stores user-level provider setup.
- `.alint/config.toml` stores optional project-local provider setup.
- `alint.config.ts` stores project lint config, plugins, files, ignores, and rule settings.
- Environment variables and CLI flags are the highest-priority overrides.

Use setup TOML for machine or project provider definitions:

```toml
version = 1

[[providers]]
id = "http://localhost:11434/v1"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen:8b"
name = "qwen:8b"
size = "small"
capabilities = [ "tool-call" ]
```

Note that `-N` stands for `--no-interactive`, which means this is not an interactive setup. TUI is not required, so you can ask Codex or Claude Code to run this command for you.

You can also use `--local` to write the config in the current project:

```bash
alint setup -N \
  --local \
  --provider-endpoint http://localhost:11434/v1 \
  --provider-model qwen:8b
```

- Without `--local`, `alint` writes the global config under `~/.config/alint/config.toml`.
- `--local` writes `.alint/config.toml` in the current project.
- You can inspect configs using the `alint config` command group.

#### Using Rules & Plugins

Similar to `eslint`, use `alint.config.ts` for files, ignores, plugins, and rules:

```ts
import { defineConfig } from '@alint-js/cli'
import { examplePlugin } from '@alint-js/plugin-example'

export default defineConfig([
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    ignore: {
      // Reads applicable nested .gitignore files when selecting lint targets.
      // This is powered by gitignore-fs.
      gitignore: true,
    },
    plugins: {
      example: examplePlugin,
    },
    rules: {
      // The `example` prefix is the local alias configured above.
      'example/inline-miniature-normalizer': 'warn',
      'example/no-redundant-jsdoc': 'warn',
      'example/no-trivial-wrapper-stack': 'warn',
    },
  },
])
```

Rule severities follow the familiar lint convention:

- `"off"` or `0` disables a rule.
- `"warn"` or `1` reports a warning.
- `"error"` or `2` reports an error.

Flat configs can analyze non-JavaScript files by selecting `text/plain`:

```ts
import docsPlugin from '@your-alint-config/docs-rules'

import { defineConfig } from '@alint-js/cli'

export default defineConfig([
  {
    files: ['docs/**/*.md', '**/*.txt'],
    language: 'text/plain',
    plugins: {
      docs: docsPlugin,
    },
    rules: {
      'docs/review-copy': 'warn',
    },
  },
])
```

#### Cache and Stats

`alint` caches rule target results by default in `.alintcache` to avoid repeating LLM calls for unchanged source targets.

> [!NOTE]
> `.alintcache` should not be committed to Git. Add it to `.gitignore` before running repeated local analysis.

```bash
echo ".alintcache" >> .gitignore
```

Disable cache for a single run:

```bash
alint --no-cache src
```

Run stats are recorded by default. Use `--no-stats` to skip recording for a run, and use the `stats` command group to inspect saved usage over time.

### Rule Developer side

To reduce the token cost during analysis while allowing rule authors to specify model size and capabilities, `alint` allows rule authors to **Request & Match** models with *Capability Selector* and *Size Selector*, instead of hardening the entire `alint` run to use a single model for all rules.

In other words, you could set up your DeepSeek, OpenAI, Ollama, or other OpenAI-compatible model on your machine and let rule authors request a model with `tool-call` capability and `small` size. `alint` will match the best configured model for them.

```ts
const model = await ctx.model({
  capabilities: ['tool-call'],
  size: 'small',
})
```

You can also call `ctx.model()` without arguments when a rule does not need a specific size or capability.

#### About agent

In `alint`, we don't limit you to any specific agent SDK. You can use an exported client from a framework such as Eve, Strands, Pi, Claude Code SDK, Codex SDK, or another tool-using runtime to implement your own agent to analyze code.

Agentic rules use `ctx.agent` when they need a multi-step tool loop, such as reading related files before reporting findings. The rule stays framework-agnostic, and the user chooses the adapter:

```ts
import { createApeiraAdapter } from '@alint-js/agent-apeira'
import { createAgentExamplePlugin } from '@alint-js/plugin-example-agent'

export default [
  {
    agent: createApeiraAdapter(),
    extends: ['agent-example/recommended'],
    plugins: {
      'agent-example': createAgentExamplePlugin(),
    },
  },
]
```

Current adapter packages include:

- `@alint-js/agent-apeira` for Apeira on the xsai stack.
- `@alint-js/agent-pi` for Pi.

However, be careful with token cost. `alint` is designed to be a code analysis tool, where rapid and repeated calls to the model are expected. Local models, cheap small models, and cache-friendly prompts are usually better defaults than routing every rule target through a large hosted model.

#### BYOA, any agent works

Bring Your Own Agent means `alint` does not try to own the agent harness. A rule can depend on the `@alint-js/core` agent contract, while the actual runtime can be Apeira, Pi, your own in-house agent, or a small function that calls the tools you need.

If an adapter is missing, you can implement the missing function or package your own plugin to replace it. The important part is that the rule reports diagnostics back through `alint`; how the agent reads files, calls tools, plans steps, or talks to a model is intentionally left to the adapter or plugin author.

#### Example rule

Rules are ordinary JavaScript objects built with the public DSL from `@alint-js/core`. A rule receives source targets and reports diagnostics.

```ts
import { defineRule } from '@alint-js/core'

export const checkFunctionRule = defineRule({
  create: ctx => ({
    async onTarget(target) {
      if (target.kind !== 'function') {
        return
      }

      const model = await ctx.model({ capabilities: ['tool-call'], size: 'small' })

      ctx.report({
        filePath: target.file.path,
        loc: target.loc,
        message: `checked ${target.name} with ${model.id}`,
      })
    },
  }),
})
```

Package rules as plugins:

```ts
import { definePlugin } from '@alint-js/core'

import { checkFunctionRule } from './rules/check-function'

export default definePlugin({
  configs: {
    recommended: [
      {
        rules: {
          'my-plugin/check-function': 'warn',
        },
      },
    ],
  },
  rules: {
    'check-function': checkFunctionRule,
  },
})
```

Rule authors can opt out of caching when a rule depends on external state:

```ts
defineRule({
  cache: false,
  create: ctx => ({
    onTarget(target) {
      // Always reruns.
    },
  }),
})
```

## Packages

| Package | Purpose |
| --- | --- |
| [`@alint-js/cli`](https://github.com/moeru-ai/alint/tree/main/packages/cli) | CLI entrypoint, user-facing config facade, setup commands, reporters, output inspection, and stats commands. |
| [`@alint-js/config`](https://github.com/moeru-ai/alint/tree/main/packages/config) | Lower-level config loading, setup TOML parsing, config paths, and ignore defaults for tools. |
| [`@alint-js/core`](https://github.com/moeru-ai/alint/tree/main/packages/core) | SDK and run engine for plugins, rules, source runtime, model resolution, diagnostics, cache, and agent contracts. |
| [`@alint-js/agent-apeira`](https://github.com/moeru-ai/alint/tree/main/packages/agent-apeira) | Apeira-backed `AgentAdapter`. |
| [`@alint-js/agent-pi`](https://github.com/moeru-ai/alint/tree/main/packages/agent-pi) | Pi-backed `AgentAdapter`. |
| [`@alint-js/plugin-example`](https://github.com/moeru-ai/alint/tree/main/packages/plugin-example) | Example TypeScript/JavaScript model-backed rules. |
| [`@alint-js/plugin-example-agent`](https://github.com/moeru-ai/alint/tree/main/packages/plugin-example-agent) | Example plugin for framework-agnostic agentic rules. |
| [`@alint-js/plugin-example-go`](https://github.com/moeru-ai/alint/tree/main/packages/plugin-example-go) | Example semantic Go review plugin using `text/plain`. |

## Documentation Automation

The table of contents above is generated with `doctoc` so README navigation is not hand-written. Run this after changing headings:

```bash
pnpm docs:update
```

`docs:update` refreshes the root README TOC and then copies the root README to `packages/cli/README.md`, keeping the npm README for `@alint-js/cli` in sync with the project overview.

## Development

This repository is a pnpm workspace.

```bash
pnpm install
pnpm -F @alint-js/cli build
pnpm -F @alint-js/core exec vitest run
```

Before sending changes, run:

```bash
pnpm typecheck
pnpm lint
```

## Status

`alint` is early and APIs may change. The core direction is stable: lint-style diagnostics, model-backed rules, flat configs, provider setup, and optional agent adapters.

## License

MIT
