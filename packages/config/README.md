# `@alint-js/config`

Config loading and setup-file utilities for `alint`.

## What it does

This package owns the file-system side of configuration:

- loads `alint.config.ts`
- resolves global and project setup TOML paths
- parses and stringifies setup TOML
- merges setup layers
- writes provider setup files
- exports built-in ignore pattern groups for lower-level tooling

It is used by `@alint-js/cli` and is useful for tools that need to inspect or prepare an `alint` project without running the linter.

Ordinary `alint.config.*` files should import ignore presets through the `@alint-js/cli` facade so projects only need the CLI package.

## How to use

```ts
import {
  getGlobalSetupConfigPath,
  loadAlintConfig,
  loadSetupConfig,
  writeSetupConfig,
} from '@alint-js/config'

const setupPath = getGlobalSetupConfigPath()
const setup = await loadSetupConfig({ cwd: process.cwd() })
const config = await loadAlintConfig({ cwd: process.cwd() })

await writeSetupConfig(setupPath, setup)
```

## When to use

- You are building CLI commands, editors, or automation around `alint` config.
- You need to read or write provider setup TOML.
- You need to load `alint.config.*` outside the official CLI.
- You need the same ignore defaults as the official CLI in lower-level tooling.

## When not to use

- Use `@alint-js/cli` when you only need the `alint` command or an ordinary `alint.config.*` file.
- Use `@alint-js/core` when you need the rule DSL, source runtime, model resolution, or run engine.
