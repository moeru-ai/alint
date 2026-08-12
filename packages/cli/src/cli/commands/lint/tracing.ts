import type { ProgressReporter, RunEndPayload } from '@alint-js/core'
import type { Span } from '@alint-js/tracing'

import { SpanStatusCode, trace, withGenAiContentCapture } from '@alint-js/tracing'
import { startNodeTracing } from '@alint-js/tracing/node'
import { errorMessageFrom } from '@moeru/std'

import packageJson from '../../../../package.json'

export interface RunWithTracingOptions {
  captureLlmContent: boolean
  cwd: string
  directory: string
  files: string[]
}

interface TracingReporter {
  finish: (error?: unknown) => void
  reporter: ProgressReporter
}

export async function runWithTracing(
  options: RunWithTracingOptions,
  operation: (reporter: ProgressReporter) => Promise<number>,
): Promise<number> {
  const session = await startNodeTracing({
    cwd: options.cwd,
    directory: options.directory,
    serviceVersion: packageJson.version,
  })
  const tracer = trace.getTracer('@alint-js/cli', packageJson.version)

  try {
    return await tracer.startActiveSpan('alint.run', {
      attributes: {
        'alint.cwd': options.cwd,
        'alint.input.files': options.files,
        'alint.run.id': session.runId,
      },
    }, async (runSpan) => {
      const tracing = createTracingReporter(runSpan)
      let failure: unknown

      try {
        const exitCode = await withGenAiContentCapture(
          options.captureLlmContent,
          () => operation(tracing.reporter),
        )
        runSpan.setAttribute('alint.exit.code', exitCode)
        runSpan.setStatus(exitCode === 2
          ? { code: SpanStatusCode.ERROR, message: 'Alint run failed.' }
          : { code: SpanStatusCode.OK })
        return exitCode
      }
      catch (error) {
        failure = error
        runSpan.recordException(recordableException(error))
        runSpan.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      }
      finally {
        tracing.finish(failure)
        runSpan.end()
      }
    })
  }
  finally {
    await session.shutdown()
  }
}

function addJsonEvent(span: Span, name: string, attributeName: string, value: unknown, startTime?: number): void {
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) {
      span.addEvent(name, { [attributeName]: json }, startTime)
    }
  }
  catch {
    span.addEvent('alint.content.serialization_error', { 'alint.attribute.name': attributeName })
  }
}

function createTracingReporter(runSpan: Span): TracingReporter {
  const tracer = trace.getTracer('@alint-js/cli')
  let planningSpan: Span | undefined
  let prepareSpan: Span | undefined

  return {
    finish: (error) => {
      const status = error == null
        ? { code: SpanStatusCode.UNSET }
        : { code: SpanStatusCode.ERROR, message: errorMessageFrom(error) ?? 'Unknown tracing failure.' }

      planningSpan?.setStatus(status)
      planningSpan?.end()
      planningSpan = undefined
      prepareSpan?.setStatus(status)
      prepareSpan?.end()
      prepareSpan = undefined
    },
    reporter: {
      onExecuteStart: ({ startedAt }) => {
        planningSpan = tracer.startSpan('alint.plan', { startTime: startedAt })
      },
      onFileReady: ({ inputPath, jobsAdded }) => {
        planningSpan?.addEvent('alint.file.ready', {
          'alint.file.path': inputPath,
          'alint.jobs.added': jobsAdded,
        })
      },
      onPlanningEnd: ({ progress }) => {
        planningSpan?.setAttribute('alint.jobs.total', progress.jobsTotal)
        planningSpan?.setStatus({ code: SpanStatusCode.OK })
        planningSpan?.end()
        planningSpan = undefined
      },
      onPrepareEnd: ({ endedAt, filesTotal }) => {
        prepareSpan?.setAttribute('alint.files.total', filesTotal)
        prepareSpan?.setStatus({ code: SpanStatusCode.OK })
        prepareSpan?.end(endedAt)
        prepareSpan = undefined
      },
      onPrepareStart: ({ startedAt }) => {
        prepareSpan = tracer.startSpan('alint.prepare', { startTime: startedAt })
      },
      onRunEnd: (payload) => {
        addJsonEvent(runSpan, 'alint.result', 'alint.result.json', runResultFrom(payload), payload.endedAt)
      },
    },
  }
}

function recordableException(error: unknown): Error | string {
  return error instanceof Error ? error : String(error)
}

function runResultFrom(payload: RunEndPayload) {
  return {
    diagnostics: payload.diagnostics,
    execution: payload.execution,
    usage: payload.usage,
  }
}
