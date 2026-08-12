# `@alint-js/vscode`

VS Code client for alint. It starts `alint lsp` and lets the diagnostics flow; everything else
happens in the server.

## What it does

- Resolves the alint executable, in order: the `alint.path` setting, `node_modules/.bin/alint` in a
  workspace folder, then `alint` on `PATH`.
- Starts it as `alint lsp` over stdio and holds one `LanguageClient`.
- Shows one error naming all three locations if none of them resolve.

The server is the user's own installed alint, running on the user's own Node. That is what keeps
its cwd, config discovery, and cache keys identical to a terminal run — the editor and the CLI read
the same cache file, which is the whole point of shipping the server as a CLI subcommand.

## How to use it

The extension activates when a workspace contains an `alint.config.*` file. A workspace that does
not use alint never spawns a server.

```jsonc
// .vscode/settings.json — only needed for a non-standard install
{
  "alint.path": "/usr/local/bin/alint"
}
```

To run it from source, open this repository in the Extension Development Host (F5) with a warm
`.alintcache`, open a file that has a cached diagnostic, and it appears. The `alint` output channel
carries the server's log.

```sh
pnpm -F @alint-js/vscode build
```

## When to use it

- You want alint findings as squiggles and in the Problems panel.
- You already run alint from a terminal and want the results you have already paid for, for free.

## When not to use it

- You want lint-on-keystroke. alint never runs a model on its own; the passive display is
  cache-only, and runs that spend tokens are explicit.
- You are not in VS Code. The server works in any LSP editor — point it at `alint lsp` directly
  (`cmd = { 'alint', 'lsp' }` in Neovim). Only the status bar is VS Code specific.
- Your cache is cold. Passive display has nothing to show until the first real run.

## Status

Group 1 of the VS Code support plan: diagnostics appear on workspace load. No status bar, no
commands, and no run controls yet.

Marketplace packaging is not done. Note for that work: `name` is currently the pnpm workspace name
`@alint-js/vscode`, and the marketplace requires `^[a-z0-9][a-z0-9\-]*$`, so it has to change
together with the `publisher` field when the extension is first packaged.
