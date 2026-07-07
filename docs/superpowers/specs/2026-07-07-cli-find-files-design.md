# CLI `findFiles` Design

## Goal

Bring `alint` lint input handling closer to ESLint's `findFiles()` behavior while keeping file-system and glob semantics out of `@alint-js/core`.

The lint command should accept user-facing file inputs such as files, directories, and globs. Before calling core, the CLI must normalize those inputs into real file paths. Core should continue to execute rules and scheduling over already resolved files.

## Non-Goals

- Do not move directory traversal, glob matching, `node:fs`, or CLI unmatched-pattern behavior into `@alint-js/core`.
- Do not keep a temporary `resolveLintFiles()` wrapper around the new implementation. The old CLI-internal boundary should be replaced cleanly.
- Do not add a new public package API for file discovery in this change.
- Do not add a new CLI flag unless implementation discovers that the existing command surface already has a matching option.

## Architecture

Add or rename the lint file discovery module under `packages/cli/src/cli/commands/lint/` so the primary CLI-internal boundary is named `findFiles`.

```ts
interface FindFilesOptions {
  config: AlintConfig
  cwd: string
  errorOnUnmatchedPattern?: boolean
  globInputPaths?: boolean
  inputs: string[]
}

async function findFiles(options: FindFilesOptions): Promise<string[]>
```

`packages/cli/src/cli/commands/lint/index.ts` should call `findFiles(...)` directly. It should not call or preserve a compatibility wrapper named `resolveLintFiles`.

`findFiles` owns user input interpretation:

- Empty input defaults to searching `.`.
- Existing files are included directly.
- Existing directories are recursively searched.
- Glob-looking inputs are searched when `globInputPaths` is enabled.
- Missing plain paths and unmatched globs raise a CLI-layer error when `errorOnUnmatchedPattern` is enabled.

`runAlint({ files })` keeps its current contract: `files` are real file paths, not arbitrary user input patterns.

## Component Responsibilities

### `findFiles`

`findFiles` is the entry point. It classifies each input, delegates traversal/search, combines results, and deduplicates by first occurrence.

It should preserve explicit file input order. Directory and glob search results should be deterministic, sorted before merging into the final result.

### Directory Walking

Directory walking should recursively return files only. It should prune directories using the same global ignore and gitignore behavior currently used by lint discovery.

Directory positional inputs should be searched from that directory, not from the entire `cwd`.

### Glob Search

Glob inputs should be grouped by a search root derived from their glob parent, following ESLint's high-level shape without copying its config lookup complexity.

Search results should still pass through the same candidate filtering used by directory discovery.

### Candidate Filtering

Directory and glob candidates should be filtered through config discovery matching:

```ts
matchesDiscoveryFile(relativePath, config, { cwd })
```

If the config has no discovery `files` patterns, automatic discovery should continue to find no files. This preserves current no-argument behavior. Explicit existing file paths are still passed through to core, where normal config resolution and ignore handling apply.

### Errors

Introduce a CLI-layer unmatched-input error type, for example:

```ts
class NoFilesFoundError extends Error {
  readonly pattern: string
  readonly globInputPaths: boolean
}
```

`lint/index.ts` should catch this error and return exit code `2` with a clear stderr message.

Default behavior should be:

- `alint missing.ts` returns exit code `2`.
- `alint "src/**/*.missing"` returns exit code `2` when no files match.

The options shape should leave room for a future `--no-error-on-unmatched-pattern`, but this design does not require adding that flag now.

## Behavior Matrix

| Input | Exists | Kind | Behavior |
| --- | --- | --- | --- |
| no args | n/a | n/a | Search `.` using config discovery. |
| `src/demo.ts` | yes | file | Include directly. |
| `src` | yes | directory | Recursively find matching files under `src`. |
| `src/**/*.ts` | maybe | glob pattern | Search by glob, then config/ignore filter candidates. |
| `missing.ts` | no | plain path | Error by default. |
| `src/**/*.missing` | no matches | glob | Error by default. |

## Data Flow

```text
lint command positional inputs
  -> findFiles({
       inputs,
       config,
       cwd,
       globInputPaths: true,
       errorOnUnmatchedPattern: true,
     })
  -> real file paths
  -> runAlint({ files })
  -> core source loading, config resolution, language extraction, rule scheduling
```

## Testing Plan

Add focused tests around the lint command and, where practical, the `findFiles` module:

- Directory positional input expands and avoids reading the directory as a file.
- Glob positional input finds matching files.
- Missing plain file returns exit code `2` with a clear message.
- Unmatched glob returns exit code `2` with a clear message.
- No-argument lint discovery still follows config `files` patterns.
- Ignored directories are pruned for directory and glob searches.
- Existing explicit file order remains stable.
- Directory and glob results are deterministic and deduped.

## Implementation Notes

The implementation may use an existing glob package already present in the dependency tree if it is a direct dependency or already accepted by the package. If adding a new direct dependency becomes necessary, pause and ask for approval before choosing one.

Comments should be used sparingly. Add comments only where the input classification or unmatched-pattern behavior would otherwise be surprising.
