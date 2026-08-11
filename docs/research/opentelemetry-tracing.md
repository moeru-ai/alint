# OpenTelemetry tracing for alint

## Conclusion

The first change can contain only configuration support. It does not need an OpenTelemetry runtime dependency.

Use this configuration in the global and local setup files:

```toml
[tracing]
enabled = true
directory = ".alint/traces"
```

The command can be `alint config tracing enable [--local] [--directory <path>]`. Global configuration applies first. Local configuration overrides each specified field.

A relative `directory` must resolve from the run working directory. It must not resolve from the global configuration directory.

Later work can add a portable API package and a Node host package. The Node host package can own the SDK, file access, and shutdown. The core package must not import a Node-only SDK or exporter.

## JavaScript package choices

| Use | Package | Node.js | Web | Stability and notes |
| --- | --- | --- | --- | --- |
| Plugin and library calls | `@opentelemetry/api` | Yes | Yes | The package includes no-op implementations. Libraries can use it without an SDK. |
| Node host setup | `@opentelemetry/sdk-node` | Yes | No | This package configures Node resources, context propagation, processors, and exporters. The package is experimental. |
| Portable manual tracing | `@opentelemetry/sdk-trace` | Yes | Yes | This package supplies the portable tracer provider and span processors. |
| Browser host setup | `@opentelemetry/sdk-trace-web` | No | Yes | Browser instrumentation is experimental. The current minimum target is ES2022. |
| OTLP over HTTP with JSON | `@opentelemetry/exporter-trace-otlp-http` | Yes | Yes | This exporter works in Node.js and browsers. Browser endpoints must accept browser requests. |
| OTLP over HTTP with protobuf | `@opentelemetry/exporter-trace-otlp-proto` | Yes | Yes | Its package metadata maps the transport to a browser implementation. |
| OTLP JSON serialization | `@opentelemetry/otlp-transformer` | Yes | The package has browser builds | The project marks this package as experimental and for internal use only. Do not expose it in the alint public API. |

Sources:

- [JavaScript API README](https://github.com/open-telemetry/opentelemetry-js/tree/main/api)
- [JavaScript runtime support](https://github.com/open-telemetry/opentelemetry-js#supported-runtimes)
- [portable Trace SDK README](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/sdk-trace)
- [Trace SDK package metadata](https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/sdk-trace/package.json)
- [Node SDK README](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-sdk-node)
- [Web SDK README](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-sdk-trace-web)
- [HTTP exporter package metadata](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/exporter-trace-otlp-http/package.json)
- [protobuf exporter package metadata](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/exporter-trace-otlp-proto/package.json)
- [protobuf browser implementation](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/exporter-trace-otlp-proto/src/platform/browser/index.ts)
- [OTLP transformer README](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/otlp-transformer)

The current main branch publishes `@opentelemetry/sdk-trace`. The old `@opentelemetry/sdk-trace-base` source path returns 404. The current package metadata includes browser builds.

The OpenTelemetry design requires instrumented libraries to depend only on the API. The application owner selects and configures the SDK. Without an SDK, API calls remain valid no-ops. This design matches plugin opt-in and keeps browser bundles free of Node SDK code. [OpenTelemetry client design principles](https://opentelemetry.io/docs/specs/otel/library-guidelines/)

## Portable tracing API

Plugins can use the same API in Node.js and Web hosts:

```ts
import { SpanStatusCode, trace } from '@opentelemetry/api'

const tracer = trace.getTracer('@example/alint-plugin', '1.0.0')

await tracer.startActiveSpan('plugin.review', async (span) => {
  try {
    span.setAttribute('alint.rule.id', 'example/review')
    span.addEvent('model.request')
    await review()
    span.setStatus({ code: SpanStatusCode.OK })
  }
  catch (error) {
    span.recordException(error instanceof Error ? error : String(error))
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw error
  }
  finally {
    span.end()
  }
})
```

The host must register a tracer provider and a context manager. Without that registration, this code has no effect.

## Node.js and Web differences

`NodeSDK` uses `AsyncLocalStorageContextManager` by default. It also uses W3C Trace Context and Baggage propagation by default. The SDK must start before instrumented modules load when automatic instrumentation is required. [Node SDK configuration](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-sdk-node#configuration)

`WebTracerProvider` is the browser provider. The Web SDK README offers `ZoneContextManager` for asynchronous context. It also warns that this manager does not work with code that targets ES2017 or later without transpilation to ES2015. Browser automatic instrumentation requires explicit registration. [Web SDK README](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-sdk-trace-web)

The JSON HTTP exporter is the common network choice for Node.js and Web. The official Web example uses OTLP `http/json` with Fetch and XMLHttpRequest instrumentation. [Official Web example](https://github.com/open-telemetry/opentelemetry-js/tree/main/examples/opentelemetry-web)

File output is not a Web capability. A Web host can use an HTTP exporter, an in-memory exporter, or a host-provided sink. A browser build must not receive a filesystem path and silently treat it as usable.

## What OTLP defines

OTLP defines telemetry encoding and delivery over gRPC or HTTP. The stable signals are traces, metrics, and logs. For HTTP, the supported protocol names include `http/protobuf` and `http/json`. [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) and [OTLP exporter configuration](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)

The OTLP file exporter specification is in development. It defines the following file properties:

- The file uses UTF-8 JSON Lines.
- Each line is one valid JSON value.
- Each line contains an OTLP `TracesData`, `MetricsData`, or `LogsData` object.
- One file contains exactly one signal type.
- The preferred extension is `.jsonl`.
- Record order and monotonic timestamps are not guaranteed.

The specification does not define a directory layout. It does not define a manifest, hash, fingerprint, or integrity record. [OTLP file exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/)

The first-party Collector file exporter takes one configured `path`. It writes JSON objects as lines by default. Optional features include rotation, append mode, directory creation, compression, and grouping by one resource attribute. Rotation renames the old file with a timestamp. This implementation does not add a manifest or integrity file. [Collector file exporter README](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/fileexporter) and [file exporter configuration source](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/fileexporter/config.go)

For alint, use this project-owned layout:

```text
<directory>/
  <run-id>/
    traces.jsonl
```

This layout is an alint convention, not an OTLP convention. The `run-id` is an identifier. It is not a content hash or fingerprint.

Each line in `traces.jsonl` must remain an OTLP JSON `TracesData` object. Do not add an alint envelope around the object. Do not add a manifest.

## Recommended package boundary

Use these ownership rules for later implementation:

| Area | Responsibility |
| --- | --- |
| `@alint-js/config` | Parse, merge, mutate, and write `tracing.enabled`, `tracing.directory`, and `tracing.captureLlmContent`. |
| `@alint-js/cli` | Resolve global and local configuration. Apply the CLI command. Start and stop the Node tracing host. |
| `@alint-js/tracing` | Provide portable tracing names, attributes, and helper functions. Depend only on `@opentelemetry/api`. |
| `@alint-js/tracing/node` or a separate Node package | Configure the SDK, resource, processor, and OTLP JSONL exporter. Own filesystem access. |
| `@alint-js/plugin/tracing` | Re-export the portable plugin-author API. Do not re-export an SDK or exporter. |
| `@alint-js/core` | Keep runtime decisions independent from the SDK. Add API-only calls or an injected wrapper only for required job-parent context. |

The current core already exposes detailed run progress through `ProgressReporter`. It reports preparation, planning, jobs, retries, diagnostics, usage, and the final result. See [`packages/core/src/core/types.ts`](../../packages/core/src/core/types.ts) and [`packages/core/src/core/run.ts`](../../packages/core/src/core/run.ts).

A CLI wrapper converts these callbacks into spans and events without an SDK dependency in core. A narrow injected operation wrapper makes the rule span active during plugin execution. Plugin, model, and tool spans therefore attach to the correct rule span. Core does not own filesystem or exporter code.

## Run trace model

Use one trace for each alint run. Use these initial spans:

| Span | Content |
| --- | --- |
| `alint.run` | Run ID, working directory policy, selected configuration source, exit code, execution counts, and token totals. |
| `alint.prepare` | Input count and preparation duration. |
| `alint.plan` | Planned file and job counts. |
| `alint.rule` | Rule ID, target kind, cache result, retry count, model identity, token usage, and final state. |

Use events for retries, diagnostics, cancellation, and exceptions. Use span attributes for bounded scalar fields that users must query.

A span status has only `UNSET`, `OK`, and `ERROR`. A lint diagnostic is a product result, not a tracing failure. For normal completion, keep the run status successful. Record the lint exit code and error-diagnostic count as attributes. Use `ERROR` for an incomplete run, an infrastructure failure, or a canceled operation. [Tracing API span and status model](https://opentelemetry.io/docs/specs/otel/trace/api/)

Trace attributes are not a general artifact store. Diagnostic evidence can contain arbitrary and large values. If “complete result” means byte-for-byte retention of arbitrary evidence, traces alone are insufficient. A later phase can add OTLP logs for result records, or keep the existing alint result artifact beside `traces.jsonl`. This addition does not require a manifest or integrity file.

Use resources for process-wide identity. Suggested resource attributes are `service.name=alint`, `service.version`, and the standard telemetry SDK attributes. Keep `alint.run.id` on the run span because one process can run more than once. The Node SDK warns that a custom resource must retain the default resource, or standard resource attributes can disappear. [Node SDK resource configuration](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-sdk-node#resource)

Use an instrumentation scope for each owner. Examples are `@alint-js/cli`, `@alint-js/core`, and the plugin package name. A tracer name identifies its instrumentation scope. [Tracing API tracer identity](https://opentelemetry.io/docs/specs/otel/trace/api/#get-a-tracer)

## Flush and shutdown

A short-lived CLI must end the root span before it flushes. It must then call `forceFlush()` and `shutdown()` on all normal terminal paths.

`forceFlush()` requests immediate export of all spans that remain in processors. `shutdown()` performs cleanup and shuts down the processors. The specification permits each operation to fail or time out. [Tracing SDK lifecycle](https://opentelemetry.io/docs/specs/otel/trace/sdk/#forceflush)

The file exporter uses a simple processor. It avoids a bounded in-memory queue that can drop spans during a short CLI run. The exporter serializes file writes and reports flush or shutdown failures. This choice favors complete local output over network-export throughput. A future network exporter can use a batching processor with explicit queue limits. [OTLP file exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/) and [JavaScript HTTP exporter batch example](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/exporter-trace-otlp-http#traces-in-web)

No implementation can guarantee completion after `SIGKILL` or a process crash. A valid file can contain completed child spans but no final root span. A reader must treat this shape as an incomplete run.

## Implementation stages

1. Add `tracing.enabled` and `tracing.directory` to global and local setup configuration.
2. Add `alint config tracing enable`, `--local`, and `--directory`.
3. Add a Node tracing host and write standard OTLP JSONL to one run directory.
4. Convert the existing progress events into the run, preparation, planning, and rule trace model.
5. Add portable GenAI and tool helpers to `@alint-js/tracing` for plugin opt-in.
6. Add a Web host only when a Web application needs tracing. Use OTLP HTTP or a host-provided sink there.

The implementation does not add hashes, fingerprints, or a manifest. SDK initialization stays in the Node-only tracing entry point. Core uses only the portable API and an injected operation wrapper.
