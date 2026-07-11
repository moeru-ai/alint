# Bun N-API and oxc-parser

alint uses `oxc-parser` to parse JavaScript and TypeScript source. `oxc-parser` is a NAPI-RS package: its JavaScript loader resolves a platform-specific native `.node` binding at runtime.

## Failure mode

Plain Bun can run `oxc-parser`, but a Bun standalone executable can fail after `bun build --compile` with an error like:

```text
error: Cannot find native binding.
cause: error: Cannot find module '@oxc-parser/binding-darwin-arm64' from '/$bunfs/root/alint-bun'
```

This happens because Bun's executable builder can embed N-API addons, but it needs to see the `.node` file directly. The generated `oxc-parser` loader tries multiple runtime paths and optional dependency packages, so the platform binding is not automatically embedded into the executable.

## Current alint boundary

All direct `oxc-parser` access goes through `packages/core/src/core/languages/js/parser.ts`. Source extraction imports that local wrapper instead of importing `oxc-parser` directly.

This keeps the native binding workaround in one place. A Bun executable target can set up the platform binding before loading alint core, without updating every parser call site.

## Bun executable bootstrap

For Bun executable builds, add a platform-specific bootstrap before importing alint:

```ts
import bindingPath from './parser.darwin-arm64.node' with { type: 'file' }

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bindingPath

const { executeCli } = await import('./cli')
```

The important ordering is:

1. Import the concrete platform `.node` binding with `with { type: 'file' }` so Bun embeds it.
2. Set `NAPI_RS_NATIVE_LIBRARY_PATH` to the embedded file path.
3. Dynamically import alint after the environment variable is set.

Do not use a static import for alint in the bootstrap. ESM static imports are evaluated before the bootstrap body runs, which would load `oxc-parser` before `NAPI_RS_NATIVE_LIBRARY_PATH` is available.

## References

- Bun Node-API documentation: https://bun.com/docs/runtime/node-api
- Bun standalone executable documentation, including N-API addon embedding: https://bun.com/docs/bundler/executables
- Bun native addon loader notes: https://bun.com/docs/bundler/loaders
- Oxc troubleshooting for native bindings: https://oxc.rs/docs/guide/troubleshooting.html
