import type { AttributeValue, Span } from '@opentelemetry/api'

import { context, createContextKey, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

const captureContentKey = createContextKey('@alint-js/tracing:capture-gen-ai-content')

export interface GenAiCallOptions {
  inputMessages?: unknown
  model: string
  operationName: string
  providerName: string
  serverAddress?: string
  systemInstructions?: unknown
  toolDefinitions?: unknown
}

export interface GenAiCallResult {
  finishReasons?: string[]
  outputMessages?: unknown
  responseModel?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface GenAiToolCallOptions {
  arguments?: unknown
  description?: string
  name: string
}

/** Records one GenAI operation without requiring a Node-only tracing SDK. */
export async function traceGenAiCall<Result>(
  options: GenAiCallOptions,
  execute: () => Promise<Result>,
  resultFrom: (result: Result) => GenAiCallResult = () => ({}),
): Promise<Result> {
  const tracer = trace.getTracer('@alint-js/tracing')

  return tracer.startActiveSpan(`${options.operationName} ${options.model}`, {
    attributes: definedAttributes({
      'gen_ai.operation.name': options.operationName,
      'gen_ai.provider.name': options.providerName,
      'gen_ai.request.model': options.model,
      'server.address': options.serverAddress,
    }),
    kind: SpanKind.CLIENT,
  }, async (span) => {
    if (capturesContent()) {
      setJsonAttribute(span, 'gen_ai.input.messages', options.inputMessages)
      setJsonAttribute(span, 'gen_ai.system_instructions', options.systemInstructions)
      setJsonAttribute(span, 'gen_ai.tool.definitions', options.toolDefinitions)
    }

    return runTracedOperation(span, execute, (result) => {
      let details: GenAiCallResult
      try {
        details = resultFrom(result)
      }
      catch {
        // Trace enrichment must not change a successful model result.
        span.addEvent('alint.gen_ai.result_mapping_error')
        return
      }

      span.setAttributes(definedAttributes({
        'gen_ai.response.finish_reasons': details.finishReasons,
        'gen_ai.response.model': details.responseModel,
        'gen_ai.usage.input_tokens': details.usage?.inputTokens,
        'gen_ai.usage.output_tokens': details.usage?.outputTokens,
      }))
      if (capturesContent()) {
        setJsonAttribute(span, 'gen_ai.output.messages', details.outputMessages)
      }
    })
  })
}

/** Records a plugin or agent tool call under the current GenAI operation. */
export async function traceGenAiToolCall<Result>(
  options: GenAiToolCallOptions,
  execute: () => Promise<Result> | Result,
): Promise<Result> {
  const tracer = trace.getTracer('@alint-js/tracing')

  return tracer.startActiveSpan(`execute_tool ${options.name}`, {
    attributes: definedAttributes({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.description': options.description,
      'gen_ai.tool.name': options.name,
    }),
    kind: SpanKind.INTERNAL,
  }, async (span) => {
    if (capturesContent()) {
      setJsonAttribute(span, 'gen_ai.tool.call.arguments', options.arguments)
    }

    return runTracedOperation(span, execute, (result) => {
      if (capturesContent()) {
        setJsonAttribute(span, 'gen_ai.tool.call.result', result)
      }
    })
  })
}

/** Enables sensitive GenAI content capture only inside the supplied operation. */
export function withGenAiContentCapture<Result>(enabled: boolean, operation: () => Result): Result {
  return context.with(context.active().setValue(captureContentKey, enabled), operation)
}

function capturesContent(): boolean {
  return context.active().getValue(captureContentKey) === true
}

function definedAttributes(attributes: Record<string, AttributeValue | undefined>): Record<string, AttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
  )
}

function recordableException(error: unknown): Error | string {
  return error instanceof Error ? error : String(error)
}

async function runTracedOperation<Result>(
  span: Span,
  execute: () => Promise<Result> | Result,
  addResult?: (result: Result) => void,
): Promise<Result> {
  try {
    const result = await execute()
    addResult?.(result)
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  }
  catch (error) {
    span.recordException(recordableException(error))
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw error
  }
  finally {
    span.end()
  }
}

function setJsonAttribute(span: Span, name: string, value: unknown): void {
  if (value === undefined) {
    return
  }

  try {
    const json = JSON.stringify(value)
    if (json === undefined) {
      throw new TypeError('Value has no JSON representation.')
    }
    span.setAttribute(name, json)
  }
  catch {
    // Trace enrichment must not change the model or tool result.
    span.addEvent('alint.gen_ai.content.serialization_error', { 'alint.attribute.name': name })
  }
}
