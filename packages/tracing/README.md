# `@alint-js/tracing`

This package provides OpenTelemetry tracing for Alint and its plugins.

## Use the portable API

Import OpenTelemetry API values from the package root. This entry point works in Node.js and web runtimes.

```ts
import { trace } from '@alint-js/tracing'

const tracer = trace.getTracer('my-alint-plugin', '1.0.0')
```

Use this entry point in plugins that add spans or events to an Alint run. The API is inactive when the host does not install an OpenTelemetry provider.

## Use the Node.js runtime

The `@alint-js/tracing/node` entry point starts the Alint Node.js SDK and writes raw OTLP trace data:

```ts
import { startNodeTracing } from '@alint-js/tracing/node'

const session = await startNodeTracing({
  cwd: process.cwd(),
  directory: '.alint/traces',
  serviceVersion: '0.4.0',
})

await session.shutdown()
```

Each exporter call appends one OTLP `TracesData` JSON object to `<directory>/<run-id>/traces.jsonl`. The file does not contain an Alint envelope, manifest, hash, or fingerprint.

Use the Node.js entry point only in a Node.js host. Do not import it from Alint core or from code that must run in a web runtime.
