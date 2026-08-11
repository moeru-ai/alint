import type {
  JobEndPayload,
  JobRetryPayload,
  ProgressJobRef,
  ProgressReporter,
  RunEndPayload,
  RunInstrumentation,
} from '@alint-js/core'
import type { Context, Span } from '@alint-js/tracing'

import { context, SpanStatusCode, trace } from '@alint-js/tracing'
import { errorMessageFrom } from '@moeru/std'

export interface TracingReporter {
  finish: (error?: unknown) => void
  instrumentation: RunInstrumentation
  reporter: ProgressReporter
}

interface JobSpan {
  context: Context
  span: Span
}

export function createTracingReporter(runSpan: Span): TracingReporter {
  const tracer = trace.getTracer('@alint-js/cli')
  let executionContext: Context | undefined
  let executionSpan: Span | undefined
  let planningSpan: Span | undefined
  let prepareSpan: Span | undefined
  const jobSpans = new Map<string, JobSpan>()

  const reporter: ProgressReporter = {
    onDiagnostic: ({ diagnostic, job }) => {
      jobSpans.get(job.id)?.span.addEvent('alint.diagnostic', {
        'alint.diagnostic.json': JSON.stringify(diagnostic),
      })
    },
    onExecuteEnd: ({ endedAt, progress }) => {
      executionSpan?.setAttribute('alint.execution.json', JSON.stringify(progress.execution))
      executionSpan?.setStatus({ code: SpanStatusCode.OK })
      executionSpan?.end(endedAt)
      executionSpan = undefined
      executionContext = undefined
    },
    onExecuteStart: ({ progress, startedAt }) => {
      executionSpan = tracer.startSpan('alint.execute', {
        attributes: {
          'alint.files.total': progress.filesTotal,
        },
        startTime: startedAt,
      })
      executionContext = trace.setSpan(context.active(), executionSpan)
      planningSpan = tracer.startSpan('alint.plan', { startTime: startedAt }, executionContext)
    },
    onFileReady: ({ inputPath, jobsAdded }) => {
      planningSpan?.addEvent('alint.file.ready', {
        'alint.file.path': inputPath,
        'alint.jobs.added': jobsAdded,
      })
    },
    onJobEnd: (payload) => {
      const entry = jobSpans.get(payload.job.id)
      if (entry == null) {
        return
      }

      const { span } = entry
      setJobEndAttributes(span, payload)
      span.setStatus(payload.state === 'failed'
        ? { code: SpanStatusCode.ERROR, message: payload.failure?.message }
        : { code: SpanStatusCode.OK })
      span.end(payload.endedAt)
      jobSpans.delete(payload.job.id)
    },
    onJobRetry: (payload) => {
      jobSpans.get(payload.job.id)?.span.addEvent('alint.job.retry', retryAttributes(payload), payload.startedAt)
    },
    onJobStart: (payload) => {
      const span = tracer.startSpan('alint.rule', {
        attributes: jobAttributes(payload.job),
        startTime: payload.startedAt,
      }, executionContext)
      jobSpans.set(payload.job.id, {
        context: trace.setSpan(executionContext ?? context.active(), span),
        span,
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
      runSpan.addEvent('alint.result', {
        'alint.result.json': JSON.stringify(runResultFrom(payload)),
      }, payload.endedAt)
    },
    onUsage: ({ job, record }) => {
      jobSpans.get(job.id)?.span.addEvent('alint.usage', {
        'alint.usage.json': JSON.stringify(record),
      })
    },
  }

  return {
    finish: (error) => {
      const status = error == null
        ? { code: SpanStatusCode.UNSET }
        : { code: SpanStatusCode.ERROR, message: errorMessageFrom(error) ?? 'Unknown tracing failure.' }

      for (const { span } of jobSpans.values()) {
        span.setStatus(status)
        span.end()
      }
      jobSpans.clear()
      planningSpan?.setStatus(status)
      planningSpan?.end()
      planningSpan = undefined
      prepareSpan?.setStatus(status)
      prepareSpan?.end()
      prepareSpan = undefined
      executionSpan?.setStatus(status)
      executionSpan?.end()
      executionSpan = undefined
      executionContext = undefined
    },
    instrumentation: {
      runJob: async (job, operation) => {
        const entry = jobSpans.get(job.id)
        return await (entry == null ? operation() : context.with(entry.context, operation))
      },
    },
    reporter,
  }
}

function jobAttributes(job: ProgressJobRef) {
  return {
    'alint.job.id': job.id,
    'alint.job.index': job.index,
    'alint.rule.id': job.ruleId,
    'alint.target.identity': job.target.identity,
    'alint.target.kind': job.target.kind,
    'alint.target.name': job.target.name ?? '',
    'code.file.path': job.inputPath,
  }
}

function retryAttributes(payload: JobRetryPayload) {
  return {
    'alint.retry.attempt': payload.attempt,
    'alint.retry.max_attempts': payload.maxAttempts,
  }
}

function runResultFrom(payload: RunEndPayload) {
  return {
    diagnostics: payload.diagnostics,
    execution: payload.execution,
    usage: payload.usage,
  }
}

function setJobEndAttributes(span: Span, payload: JobEndPayload): void {
  span.setAttributes({
    'alint.cache': payload.cache,
    'alint.job.state': payload.state,
  })

  if (payload.failure != null) {
    span.addEvent('exception', {
      'exception.message': payload.failure.message,
      'exception.type': payload.failure.kind,
    })
  }
}
