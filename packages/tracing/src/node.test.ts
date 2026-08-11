import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { traceGenAiCall, traceGenAiToolCall, withGenAiContentCapture } from './gen-ai'
import { SpanStatusCode, trace } from './index'
import { startNodeTracing } from './node'

describe('node tracing', () => {
  it('writes one raw OTLP JSON trace line and flushes it on shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-tracing-'))
    const session = await startNodeTracing({
      cwd,
      directory: 'traces',
      serviceVersion: '0.4.0-test',
    })
    const tracer = trace.getTracer('@alint-js/tracing-test', '1.0.0')

    await tracer.startActiveSpan('alint.run', async (span) => {
      span.setAttribute('alint.run.id', session.runId)
      span.addEvent('alint.result', { 'alint.result.json': '{"diagnostics":[]}' })
      span.setStatus({ code: SpanStatusCode.OK })
      span.end()
    })
    await session.shutdown()

    const text = await readFile(session.filePath, 'utf8')
    const lines = text.trimEnd().split('\n')
    const line = lines[0]
    expect(line).toBeDefined()
    if (line == null) {
      throw new Error('Expected one OTLP JSON line.')
    }

    const output: OtlpTraceData = JSON.parse(line)
    const resourceSpans = output.resourceSpans
    const resourceAttributes = Object.fromEntries(
      resourceSpans[0].resource.attributes.map(attribute => [attribute.key, attribute.value.stringValue]),
    )
    const exportedSpan = resourceSpans[0].scopeSpans[0].spans[0]

    expect(lines).toHaveLength(1)
    expect(Object.keys(output)).toEqual(['resourceSpans'])
    expect(resourceAttributes['service.name']).toBe('alint')
    expect(resourceAttributes['service.version']).toBe('0.4.0-test')
    expect(exportedSpan.name).toBe('alint.run')
    expect(exportedSpan.attributes).toContainEqual({
      key: 'alint.run.id',
      value: { stringValue: session.runId },
    })
    expect(exportedSpan.events[0]).toMatchObject({
      name: 'alint.result',
    })
    expect(session.filePath).toBe(join(cwd, 'traces', session.runId, 'traces.jsonl'))
  })

  it('writes GenAI messages and tool content when content capture is enabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-gen-ai-tracing-'))
    const session = await startNodeTracing({ cwd, directory: 'traces', serviceVersion: '0.4.0-test' })
    const tracer = trace.getTracer('@alint-js/tracing-test', '1.0.0')

    await tracer.startActiveSpan('alint.rule', async (ruleSpan) => {
      await withGenAiContentCapture(true, () => traceGenAiCall({
        inputMessages: [{ parts: [{ content: 'Review demo.ts', type: 'text' }], role: 'user' }],
        model: 'demo-model',
        operationName: 'chat',
        providerName: 'demo-provider',
        systemInstructions: [{ content: 'Find defects.', type: 'text' }],
        toolDefinitions: [{ description: 'Report findings', name: 'reportFindings', parameters: { type: 'object' }, type: 'function' }],
      }, async () => {
        const toolResult = await traceGenAiToolCall({
          arguments: { file: 'demo.ts' },
          description: 'Read a source file',
          name: 'readFile',
        }, async () => ({ content: 'const value = 1' }))
        return { answer: `No defects in ${toolResult.content}.`, inputTokens: 12, outputTokens: 3 }
      }, result => ({
        finishReasons: ['stop'],
        outputMessages: [{ parts: [{ content: result.answer, type: 'text' }], role: 'assistant' }],
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      })))
      ruleSpan.end()
    })
    await session.shutdown()

    const spans = await readSpans(session.filePath)
    const ruleSpan = spans.find(span => span.name === 'alint.rule')
    const inferenceSpan = spans.find(span => span.name === 'chat demo-model')
    const toolSpan = spans.find(span => span.name === 'execute_tool readFile')
    const attributes = attributesFrom(inferenceSpan)
    const toolAttributes = attributesFrom(toolSpan)

    expect(inferenceSpan?.parentSpanId).toBe(ruleSpan?.spanId)
    expect(toolSpan?.parentSpanId).toBe(inferenceSpan?.spanId)
    expect(attributes['gen_ai.operation.name']).toBe('chat')
    expect(attributes['gen_ai.provider.name']).toBe('demo-provider')
    expect(attributes['gen_ai.request.model']).toBe('demo-model')
    expect(attributes['gen_ai.input.messages']).toContain('Review demo.ts')
    expect(attributes['gen_ai.output.messages']).toContain('No defects in const value = 1.')
    expect(attributes['gen_ai.system_instructions']).toContain('Find defects.')
    expect(attributes['gen_ai.tool.definitions']).toContain('reportFindings')
    expect(attributes['gen_ai.response.finish_reasons']).toEqual(['stop'])
    expect(attributes['gen_ai.usage.input_tokens']).toBe(12)
    expect(attributes['gen_ai.usage.output_tokens']).toBe(3)
    expect(toolAttributes['gen_ai.tool.call.arguments']).toContain('demo.ts')
    expect(toolAttributes['gen_ai.tool.call.result']).toContain('const value = 1')
  })

  it('omits GenAI content when content capture is disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-gen-ai-tracing-'))
    const session = await startNodeTracing({ cwd, directory: 'traces', serviceVersion: '0.4.0-test' })

    await traceGenAiCall({
      inputMessages: [{ parts: [{ content: 'private input', type: 'text' }], role: 'user' }],
      model: 'demo-model',
      operationName: 'chat',
      providerName: 'demo-provider',
    }, async () => 'private output', output => ({ outputMessages: [{ parts: [{ content: output, type: 'text' }], role: 'assistant' }] }))
    await session.shutdown()

    const spans = await readSpans(session.filePath)
    const attributes = attributesFrom(spans.find(span => span.name === 'chat demo-model'))

    expect(attributes['gen_ai.request.model']).toBe('demo-model')
    expect(attributes).not.toHaveProperty('gen_ai.input.messages')
    expect(attributes).not.toHaveProperty('gen_ai.output.messages')
  })
})

interface OtlpAttributeValue {
  arrayValue?: { values: Array<{ stringValue?: string }> }
  boolValue?: boolean
  intValue?: number
  stringValue?: string
}

interface OtlpSpan {
  attributes: Array<{
    key: string
    value: OtlpAttributeValue
  }>
  events: Array<{ name: string }>
  name: string
  parentSpanId?: string
  spanId: string
}

interface OtlpTraceData {
  resourceSpans: Array<{
    resource: {
      attributes: Array<{
        key: string
        value: { stringValue?: string }
      }>
    }
    scopeSpans: Array<{
      spans: OtlpSpan[]
    }>
  }>
}

function attributesFrom(span: OtlpSpan | undefined): Record<string, boolean | number | string | string[]> {
  expect(span).toBeDefined()
  if (span == null) {
    throw new Error('Expected an OTLP span.')
  }

  return Object.fromEntries(span.attributes.map(attribute => [attribute.key, attributeValue(attribute.value)]))
}

function attributeValue(value: OtlpAttributeValue): boolean | number | string | string[] {
  if (value.stringValue !== undefined)
    return value.stringValue
  if (value.intValue !== undefined)
    return value.intValue
  if (value.boolValue !== undefined)
    return value.boolValue
  return value.arrayValue?.values.flatMap(item => item.stringValue ?? []) ?? []
}

async function readSpans(filePath: string): Promise<OtlpSpan[]> {
  const text = await readFile(filePath, 'utf8')
  return text.trimEnd().split('\n').flatMap((line) => {
    const data: OtlpTraceData = JSON.parse(line)
    return data.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
  })
}
