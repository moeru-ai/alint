export {
  traceGenAiCall,
  traceGenAiToolCall,
  withGenAiContentCapture,
} from './gen-ai'

export type {
  GenAiCallOptions,
  GenAiCallResult,
  GenAiToolCallOptions,
} from './gen-ai'

export {
  context,
  createContextKey,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
export type {
  Attributes,
  Context,
  Span,
  SpanOptions,
  Tracer,
} from '@opentelemetry/api'
