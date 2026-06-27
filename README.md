# `alint`

![Demo](./docs/assets/demo.gif)

Alint is a [`eslint`](https://eslint.org/) inspired ~~static~~ agentic code analysis tool for **vibe coded** code that needs another look. It uses LLMs to analyze bad smell code patterns with agents you implement in rules, and report diagnostics in a familiar format.

While `alint` is inspired by `eslint`, but we expect that the concept that `alint` brought to the table will be a new paradigm for code analysis. It should not be limited to just JavaScript/TypeScript, you can easily extend this to other languages and even non-code artifacts.

## Getting Started

### Installation

```bash
npm install -g @alint-js/cli
pnpm install -g @alint-js/cli
```

### Configure your model

<details>
<summary>Ollama</summary>

```bash
alint setup -N \
  --provider-endpoint http://localhost:11434/v1 \
  --provider-model qwen:8b
```

</details>

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

### Linting

Run the CLI against project files:

```bash
alint demo.ts
alint --format json demo.ts

# To override model
alint --model qwen:8b demo.ts
```

`alint` returns exit code `1` when diagnostics are reported and `0` when the run is clean.

### Cache

`alint` caches rule target results by default in `.alintcache` to avoid repeating LLM calls for unchanged files, classes, functions, and methods.

> [!NOTE] `.alintcache` should not be committed to Git repository.
>
> You can ignore it by adding `.alintcache` to your `.gitignore` file.
>
> ```bash
> echo ".alintcache" >> .gitignore
> ```

If you want to lint without the previous cache, you can run:

```bash
alint --no-cache demo.ts
```

For Rule authors, you can opt out of caching when they depend on external state:

```ts
defineRule({
  cache: false,
  create: ctx => ({
    onFunction(fn) {
      // Always reruns.
    },
  }),
})
```

## Concepts

### `alint` User side

#### Configurations

In order to provision models and LLMs for `alint` while keep it clean for contributors of your project without requiring them to setup their own LLMs, `alint` offers layers of configurations covering **Project Local**, **Global** and **Environment Variable Override**.

The priorities follow:

```
~/.config/alint/config.toml < .alint/config.toml (optional, testing purpose) < alint.config.ts < Environment Variable Override
```

You can always setup providers and inspect configs using `alint setup` command.

For example, to setup a Ollama provider provisioning a `qwen:8b` model, you can run:

> ```shell
> alint setup -N \
>   --provider-endpoint http://localhost:11434/v1 \
>   --provider-model qwen:8b
> ```

This will produce a global config under `~/.config/alint/config.toml` with the provider endpoint and model id.

```toml
version = 1

[[providers]]
id = "http://localhost:11434/v1"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen:8b"
name = "qwen:8b"
```

Note that `-N` stands for `--no-interactive`, which means this is not an interactive setup, TUI is not required, you can ask your Codex or Claude Code to run this command for you.

You can also use `--local` to write the config in the current project:

> ```shell
> alint setup -N \
>   --local \
>   --provider-endpoint http://localhost:11434/v1 \
>   --provider-model qwen:8b
> ```

- Without `--local`, `alint` writes the global config under `~/.config/alint/config.toml`.
- `--local` writes `.alint/config.toml` in the current project.

#### Using Rules & Plugins

Similar to `eslint`,

```ts
import yourPlugin from '@your-alint-config/your-rules'

import { defineConfig } from '@alint-js/core'

export default defineConfig({
  plugins: [
    yourPlugin
  ],
  rules: {
    // If you need to override the rule severity, you can do it here.
    // Default severity is `warn` if not specified.
    //
    // Note the `example` prefix is defined by the `scope` in the plugin,
    // not the package name of the plugin.
    'example/review-load': 'warn',
  },
})
```


### Rule Developer side

To reduce the token cost during the analysis, yet allowing the rule authors to specify the model size and capabilities, instead of hardening the entire `alint` to use a single model for all rules, `alint` allows rule authors to **Request & Match** models with *Capability Selector* and *Size Selector*.

In another word, you could setup your DeepSeek or OpenAI model on your local machine and let the rule authors to request a model with `tool-call` capability and `small` size, and `alint` will match the best model for them.

#### About agent

In `alint`, we don't limit to use any of the agent SDK you like, you can use [`vercel/eve`](https://github.com/vercel/eve) with exported client, or [Strands](https://github.com/strands-agents/harness-sdk), or [Pi](https://github.com/earendil-works/pi) (the agent powers OpenClaw), or even [Claude Code SDK](https://code.claude.com/docs/en/agent-sdk/overview), [Codex SDK](https://developers.openai.com/codex/sdk) to implement your own agent to analyze the code.

However, be careful with the token cost, since `alint` is designed to be a code analysis tool, where rapid and repeated calls to the model without proper caching (KV-Cache friendly) are expected, we suggest to use local models, or cheap small models.

#### Example rule

```ts
// packages/your-rule/src/rules/review-load/rule.ts
import { defineRule } from '@alint-js/core'

const reviewLoad = defineRule({
  create: ctx => ({
    onFunction: async (fn) => {
      // You can request a model without any arguments when calling `ctx.model(...)`
      // So that
      //
      // const model = await ctx.model()
      //
      // works too.
      const model = await ctx.model({ capabilities: ['tool-call'], size: 'small' })

      ctx.report({
        filePath: fn.file.path,
        loc: fn.loc,
        // Here for better demonstration, we just report a message with the model id and function name.
        message: `checked ${fn.name} with ${model.id}`,
      })
    },
  }),
})
```

And export it as a plugin:

```ts
// packages/your-rule/src/plugin.ts
import { definePlugin } from '@alint-js/core'

// If you want to use the package name as the scope, you can import the package.json and use it as the scope.
// import * as packageJSON from '../package.json'

export default definePlugin({
  rules: {
    'review-load': reviewLoad,
  },
  // Note here you need to specify a scope for your plugin,
  // this prevents rule name conflicts with other plugins.
  //
  // And it's not limited to use single word, or npm package scope without /,
  // you can use any string as the scope, for example, `@your-alint-config/your-rules` or `@your-alint-config/your-rules/v1`.
  //
  // But we recommend to use your package name as the scope for better user experience.
  scope: 'example',
  // scope: packageJSON.name,
})
```
