import type { Attributes, Span } from '@alint-js/tracing'

import type { ProgressJobRef } from '../types'
import type { RuleJobOutcome } from './types'

import { context, createContextKey, SpanStatusCode, trace } from '@alint-js/tracing'

const ruleSpanKey = createContextKey('@alint-js/core:rule-span')

export function addRuleEvent(name: string, attributes?: Attributes, startTime?: number): void {
  activeRuleSpan()?.addEvent(name, attributes, startTime)
}

export function addRuleJsonEvent(name: string, attributeName: string, value: unknown): void {
  const span = activeRuleSpan()
  if (span == null) {
    return
  }

  try {
    const json = JSON.stringify(value)
    if (json !== undefined) {
      span.addEvent(name, { [attributeName]: json })
    }
  }
  catch {
    span.addEvent('alint.content.serialization_error', { 'alint.attribute.name': attributeName })
  }
}

export async function traceRuleJob(
  job: ProgressJobRef,
  startedAt: number,
  operation: () => Promise<RuleJobOutcome>,
): Promise<RuleJobOutcome> {
  const tracer = trace.getTracer('@alint-js/core')

  return tracer.startActiveSpan('alint.rule', {
    attributes: {
      'alint.job.id': job.id,
      'alint.job.index': job.index,
      'alint.rule.id': job.ruleId,
      'alint.target.identity': job.target.identity,
      'alint.target.kind': job.target.kind,
      'alint.target.name': job.target.name ?? '',
      'code.file.path': job.inputPath,
    },
    startTime: startedAt,
  }, async (span) => {
    try {
      return await context.with(context.active().setValue(ruleSpanKey, span), async () => {
        const outcome = await operation()
        span.setAttributes({
          'alint.cache': outcome.cache,
          'alint.job.state': outcome.state,
        })

        if (outcome.state === 'failed') {
          span.addEvent('exception', {
            'exception.message': outcome.failure.message,
            'exception.type': outcome.failure.kind,
          })
          span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.failure.message })
        }
        else {
          span.setStatus({ code: SpanStatusCode.OK })
        }

        return outcome
      })
    }
    catch (error) {
      span.recordException(recordableException(error))
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    }
    finally {
      span.end()
    }
  })
}

function activeRuleSpan(): Span | undefined {
  return context.active().getValue(ruleSpanKey) as Span | undefined
}

function recordableException(error: unknown): Error | string {
  return error instanceof Error ? error : String(error)
}
