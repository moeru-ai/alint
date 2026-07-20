# `@alint-js/tools-fs`

Shared filesystem `AgentTool`s for alint plugins whose rules let an agent explore a project.
`createTools(cwd, options?)` returns four tools, all reporting paths relative to `cwd`:

- `read_file` — read a UTF-8 file (path relative to `cwd` or absolute).
- `list_files` — list files, with optional glob `patterns`, `ignore`, and `directory`.
- `search_files` — match file paths by substring.
- `search_in_files` — match file contents, returning `path:line: snippet` lines.

## Usage

```ts
import { createTools, DEFAULT_IGNORE_PATTERNS } from '@alint-js/tools-fs'

// Built-in ignores:
const tools = createTools(ctx.cwd)
// Extend the builtins:
const py = createTools(ctx.cwd, { ignore: [...DEFAULT_IGNORE_PATTERNS, '**/.venv/**'] })
// Replace the builtins:
const bare = createTools(ctx.cwd, { ignore: ['**/generated/**'] })
// Confine an agent to non-secret files under the canonical repository root:
const confined = createTools(ctx.cwd, { confined: true })
```

In non-confined mode, `options.ignore` **replaces** the builtins
(`git/build/dist/node_modules/vendor`); spread `DEFAULT_IGNORE_PATTERNS` to extend them instead.
In confined mode, configured and per-call ignores append to the mandatory defaults and secret-file
ignores; they cannot make a protected path readable.
The underlying `listFiles` / `readFile` / `searchFiles` / `searchInFiles` are exported too.

## Repository-confined mode

`{ confined: true }` accepts only repository-relative paths, resolves symlinks before access,
does not follow directory symlinks during discovery, and rejects likely credential files plus
configured ignores. Direct reads are limited to 200,000 UTF-8 bytes per file. Listings show at
most 160 paths, content searches show at most 24 matches, and one content search inspects at most
20,000,000 bytes across otherwise eligible files. Truncated results include an explicit marker.

Confinement assumes the checkout is not concurrently rewritten by another actor during a tool
call; it is intended to bound an agent's repository exploration, not to isolate a hostile writer.

## When to use

- **Use** when a `ctx.agent` rule needs generic read/list/search tools to explore a project.

## When not to use

- **Don't** for a single structured model judgement without an agent loop, or when you need real code search (regex/AST/ranking).
