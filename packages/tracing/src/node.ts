import type { FileHandle } from 'node:fs/promises'

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace'

import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { resolve } from 'node:path'

import { context, propagation, trace } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
// NOTICE: OpenTelemetry JS has no file trace exporter. Its experimental transformer publicly
// exports the JSON serializer, so the Node-only adapter keeps this unstable dependency isolated.
// https://github.com/open-telemetry/opentelemetry-js/blob/76fa6b509e2b48d9cbee31cb37a2efc61dc4d384/experimental/packages/otlp-transformer/src/index.ts#L26-L28
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

export interface NodeTracingOptions {
  cwd: string
  directory: string
  serviceVersion: string
}

export interface NodeTracingSession {
  filePath: string
  runId: string
  shutdown: () => Promise<void>
}

class JsonLinesTraceExporter implements SpanExporter {
  private exportError: Error | undefined
  private exportQueue = Promise.resolve()

  constructor(private readonly file: FileHandle) {}

  export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode, error?: Error }) => void): void {
    this.exportQueue = this.exportQueue.then(async () => {
      const serialized = JsonTraceSerializer.serializeRequest(spans)
      if (serialized == null) {
        throw new Error('OpenTelemetry could not serialize trace data.')
      }

      await this.file.write(serialized)
      await this.file.write('\n')
    })

    void this.exportQueue.then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => {
        this.exportError = error instanceof Error ? error : new Error(String(error))
        resultCallback({ code: ExportResultCode.FAILED, error: this.exportError })
      },
    )
  }

  async forceFlush(): Promise<void> {
    await this.exportQueue
    if (this.exportError != null) {
      throw this.exportError
    }
    await this.file.sync()
  }

  async shutdown(): Promise<void> {
    try {
      await this.forceFlush()
    }
    finally {
      await this.file.close()
    }
  }
}

export async function startNodeTracing(options: NodeTracingOptions): Promise<NodeTracingSession> {
  const runId = randomUUID()
  const runDirectory = resolve(options.cwd, options.directory, runId)
  const filePath = resolve(runDirectory, 'traces.jsonl')

  await mkdir(runDirectory, { recursive: true })
  const file = await open(filePath, 'ax')
  const exporter = new JsonLinesTraceExporter(file)
  const processor = new SimpleSpanProcessor({ exporter })
  const resource = defaultResource().merge(resourceFromAttributes({
    'service.name': 'alint',
    'service.version': options.serviceVersion,
  }))
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [processor],
  })

  try {
    provider.register()
  }
  catch (error) {
    await file.close()
    trace.disable()
    context.disable()
    propagation.disable()
    throw error
  }

  let stopped = false
  return {
    filePath,
    runId,
    shutdown: async () => {
      if (stopped) {
        return
      }
      stopped = true

      let flushError: unknown
      try {
        await provider.forceFlush()
      }
      catch (error) {
        flushError = error
      }

      try {
        await provider.shutdown()
      }
      finally {
        trace.disable()
        context.disable()
        propagation.disable()
      }

      if (flushError != null) {
        throw flushError
      }
    },
  }
}
