# `@alint-js/config`

Config loading and setup-file utilities for `alint`.

## What it does

This package owns the file-system side of configuration:

- loads `alint.config.ts`
- resolves global and project setup TOML paths
- parses and stringifies setup TOML
- merges setup layers
- writes provider setup files
- installs remote plugin packages or local plugin directories and writes `.alint/plugins/lock.json`
- exports built-in ignore pattern groups for lower-level tooling

It is used by `@alint-js/cli` and is useful for tools that need to inspect or prepare an `alint` project without running the linter.

Ordinary `alint.config.*` files should import ignore presets through the `@alint-js/cli` facade so projects only need the CLI package.

## How to use

```ts
import {
  getGlobalSetupConfigPath,
  installStaticPlugins,
  loadAlintConfig,
  loadSetupConfig,
  writeSetupConfig,
} from '@alint-js/config'

const setupPath = getGlobalSetupConfigPath()
const cwd = process.cwd()
const setup = await loadSetupConfig(setupPath)

await installStaticPlugins({ cwd })

const config = await loadAlintConfig(cwd)

await writeSetupConfig(setupPath, setup)
```

Static configs can use TOML, YAML, JSON, JSONC, or JSON5. They are data-only alternatives to executable JavaScript and TypeScript flat configs, and identify plugin sources with strings.

For example, TOML supports exact remote packages, config-relative directories, native absolute paths, and file URLs:

```toml
[[config.group]]

[config.group.plugins]
registry = "@scope/alint-plugin@1.2.3"
relative = "./plugins/relative-plugin"
absolute = "/opt/alint/plugins/absolute-plugin"
file_url = "file:///opt/alint/plugins/file-url-plugin"
```

Relative paths use the config file's directory as their base. Windows native paths should use TOML literal strings so backslashes remain literal:

```toml
[[config.group]]

[config.group.plugins]
native = 'C:\alint\plugins\native-plugin'
```

Use `installStaticPlugins` after adding or changing plugin sources.

- **Package:** downloads the exact package version into `.alint/plugins/store`, verifies its integrity, and locks the installed snapshot.
- **Local:** installs the directory in place, validates its package root export, and locks its physical directory identity. It does not build the plugin or install its dependencies.

Run installation again after changing a source string, moving a local directory, or changing its symlink target. Changes inside the same local directory are loaded by the next process without reinstalling.

## Plugin lockfile

`.alint/plugins/lock.json` stores package snapshots with integrity metadata and local directory source identities. Local plugin code executes as trusted Node.js; containment checks are not a sandbox.

## When to use

- You are building CLI commands, editors, or automation around `alint` config.
- You need to read or write provider setup TOML.
- You need to load `alint.config.*` outside the official CLI.
- You need to install remote packages or local plugin directories before loading static config.
- You need the same ignore defaults as the official CLI in lower-level tooling.

## When not to use

- Use `@alint-js/cli` when you only need the `alint` command or an ordinary `alint.config.*` file.
- Use `@alint-js/core` when you need the rule DSL, source runtime, model resolution, or run engine.
