import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

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
})

interface OtlpTraceData {
  resourceSpans: Array<{
    resource: {
      attributes: Array<{
        key: string
        value: { stringValue?: string }
      }>
    }
    scopeSpans: Array<{
      spans: Array<{
        attributes: Array<{
          key: string
          value: { stringValue?: string }
        }>
        events: Array<{ name: string }>
        name: string
      }>
    }>
  }>
}
