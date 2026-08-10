# alint Codex plugin

This plugin adds an opt-in Codex Stop hook that runs `alint` before Codex finishes work in a Git repository. Installing the plugin does not activate it for every alint project. Each repository must explicitly set `integrations.stopGate.enabled = true` in its root `alint.config.*` file.

## Install by side-loading

The following command installs the marketplace from the repository's **default branch**. It does not resolve the latest release:

```bash
codex plugin marketplace add moeru-ai/alint \
  --sparse .agents/plugins \
  --sparse plugins/codex-plugin-alint
codex plugin add alint@alint
```

To install a specific release instead, add its Git tag explicitly:

```bash
codex plugin marketplace add moeru-ai/alint \
  --ref vX.Y.Z \
  --sparse .agents/plugins \
  --sparse plugins/codex-plugin-alint
codex plugin add alint@alint
```

Review and trust the Stop hook when Codex asks. The hook runs the bundled Node.js script in `dist/stop-gate.mjs`; that script discovers and invokes an `alint` CLI from the repository.

## Configure a repository

Explicitly enable Stop Gate in the repository before configuring optional overrides:

```bash
alint config integrations stop-gate enable
```

The default behavior checks dirty files: staged, unstaged, and untracked files that are not ignored. Deleted files and registered submodules are excluded. Files with both staged and unstaged changes are checked from their current working-tree contents. Diagnostics with locations remain only when they intersect changed lines. Diagnostics without locations remain. The same behavior is available outside Codex through `alint --dirty`.

Show the effective configuration:

```bash
alint config integrations stop-gate show
```

Write non-default values to the repository's `alint.config.toml`:

```bash
alint config integrations stop-gate set --target all --timeout-ms 1800000
alint config integrations stop-gate disable
```

Equivalent executable config:

```ts
import { defineConfig } from '@alint-js/cli'

export default defineConfig([
  {
    integrations: {
      stopGate: {
        enabled: true,
        target: 'all',
        timeoutMs: 1_800_000,
      },
    },
  },
])
```

`enabled` defaults to `false`; only an explicit `true` activates the repository. `target` accepts `dirty-files` or `all`; the default is `dirty-files`. `timeoutMs` defaults to 900000 and accepts integers from 1 through 86100000 (23 hours 55 minutes). The plugin's outer Codex hook is capped at 24 hours; the five-minute reserve lets discovery, process startup, and state persistence finish without the host terminating the hook before it can return a structured error. Integration settings must be on a global config item without `files`, `directories`, or `ignores`; later global items override earlier ones.

The config writer only extends the existing TOML write path with Stop Gate fields. It does not add support for writing other config formats or choosing a new output path.

## Runtime behavior

The hook always uses the Git root as the `alint` working directory and resolves the CLI in this order:

1. `<git-root>/node_modules/.bin/alint`
2. the repository package manager's offline/no-install exec command
3. `alint` on `PATH`

It never installs or updates `alint` automatically. If no compatible CLI is available, it asks Codex to obtain user approval before changing the repository installation. CLI/config discovery and other startup work have a one-minute limit; lint itself uses `timeoutMs`, with a separate one-minute startup allowance.

After the plugin reads an enabled configuration, it checks Git HEAD for the `dirty-files` target. If HEAD is detached, the plugin skips lint and returns a non-blocking explanation. The `all` target runs normally with a detached HEAD.

The internal `integrations stop-gate` protocol exits `0` whenever alint successfully produces a result envelope, including envelopes containing error diagnostics. It exits `1` only for an alint runtime or configuration failure. The plugin converts either kind of result into a Codex Hook decision and exits `0`; Codex continuation is controlled by the structured Hook output, not by the inner alint process exit code.

If the hook cannot parse Codex input or otherwise cannot return a structured decision, every non-zero exit writes a stable English diagnostic to stderr before the process ends. It also writes a `0600` diagnostic file under the system temporary directory at `alint-stop-gate/fatal/<timestamp>-<process-id>.log` and includes that path in stderr. The file contains the timestamp, failure context, and error detail, but not the raw Hook input. Fatal diagnostics share a 10 MiB aggregate budget; the oldest files are removed first. This fatal fallback is separate from recoverable runtime failures, which continue to use the structured Hook decision protocol above.

The first successful lint with warnings blocks once so Codex evaluates the warnings. Later warning-only results are reminders. Error results block while the automatic correction loop is active. If two consecutive successful lints return the same diagnostic multiset, the second result becomes a non-blocking reminder instead. The fingerprint includes each diagnostic's rule, severity, file, location, message, and evidence; it ignores diagnostic order plus cache and model metadata. Clean, inactive, no-dirty-file, and runtime-error results break this consecutive-match chain. The plugin runs at most nine successful lint rounds per Codex session and keeps runtime/config failure counting separate.

Detailed reports are always read from the path supplied to Codex rather than inlined into the hook message. Reports live under the system temporary directory in `alint-stop-gate/<session-id>/report.json`. A single report over 100 MiB is an error; aggregate reports are kept within 100 MiB by deleting the oldest reports first.

Small session-policy state is stored in `${CLAUDE_PLUGIN_DATA}/stop-gate/sessions-v2` and is shared only by the plugin. State older than 365 days is pruned whenever state is written.

## When to use

Use this plugin when an `alint`-configured repository should receive an automatic final lint pass during Codex work. Install it once, then explicitly enable each repository that should participate. Use `dirty-files` for focused interactive work and `all` when every stop should lint the full configured project.

## When not to use

Do not use it as a CI replacement or as an installer for `alint`. Repositories without a root `alint.config.*` or without explicit Stop Gate activation remain inactive, and repositories that cannot run the integration command must be repaired or updated explicitly.
