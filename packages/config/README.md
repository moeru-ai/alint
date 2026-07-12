# `@alint-js/config`

Config loading and setup-file utilities for `alint`.

## What it does

This package owns the file-system side of configuration:

- loads `alint.config.ts`
- resolves global and project setup TOML paths
- parses and stringifies setup TOML
- merges setup layers
- writes provider setup files
- installs registry plugin packages and registers local plugin directories in `.alint/plugins/lock.json`
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

Static TOML plugins support registry packages, config-relative directories, native absolute paths, and file URLs:

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

Run installation after adding or changing configured source specifiers, or after moving a local directory or changing its symlink target. An ordinary rebuild or content change within the same local root does not require reinstalling. Local directory registration does not build the plugin or install its dependencies. Directory sources bypass the registry, package store, and integrity checks.

Local plugin root and entry containment checks validate the registered source identity; they are not a sandbox. The plugin and all transitive dependencies execute as fully trusted Node.js code and may access resources outside the registered directory.

On load, the root package manifest, export, and entry content are re-resolved; the root entry content hash cache-busts imports, so rebuilt root output is visible without reinstalling. Unbundled transitive imports retain normal Node.js ESM caching within a process, so transitive-only changes require a new CLI process. A root rebuild or change refreshes those dependencies only when their content is bundled or copied into the changed root entry. Lock version 2 distinguishes directory identities from registry package snapshots, which include registry and integrity metadata.

## When to use

- You are building CLI commands, editors, or automation around `alint` config.
- You need to read or write provider setup TOML.
- You need to load `alint.config.*` outside the official CLI.
- You need to install registry plugins or register local plugin directories before loading static config.
- You need the same ignore defaults as the official CLI in lower-level tooling.

## When not to use

- Use `@alint-js/cli` when you only need the `alint` command or an ordinary `alint.config.*` file.
- Use `@alint-js/core` when you need the rule DSL, source runtime, model resolution, or run engine.
