import type { ProgressJobRef, ProgressSnapshot } from '@alint-js/core'

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { trace, traceGenAiCall } from '@alint-js/tracing'
import { startNodeTracing } from '@alint-js/tracing/node'
import { describe, expect, it } from 'vitest'

import { createTracingReporter } from './tracing'

describe('lint tracing', () => {
  it('makes the rule span active during model execution', async () => {
    const session = await startNodeTracing({ cwd: tmpdir(), directory: 'alint-cli-tracing-tests', serviceVersion: 'test' })
    const tracer = trace.getTracer('@alint-js/cli-test')
    const job: ProgressJobRef = {
      id: 'job-1',
      index: 0,
      inputPath: '/project/demo.ts',
      ruleId: 'demo/review',
      target: { identity: 'demo.ts', kind: 'file' },
    }
    const progress = emptyProgress()

    await tracer.startActiveSpan('alint.run', async (runSpan) => {
      const tracing = createTracingReporter(runSpan)
      tracing.reporter.onExecuteStart?.({ progress })
      tracing.reporter.onJobStart?.({ job, progress })

      await tracing.instrumentation.runJob(job, () => traceGenAiCall({
        model: 'demo-model',
        operationName: 'chat',
        providerName: 'demo-provider',
      }, async () => 'done'))

      tracing.reporter.onJobEnd?.({ cache: 'miss', job, progress, state: 'completed' })
      tracing.reporter.onExecuteEnd?.({ progress })
      tracing.finish()
      runSpan.end()
    })
    await session.shutdown()

    const spans = await readSpans(session.filePath)
    const ruleSpan = spans.find(span => span.name === 'alint.rule')
    const modelSpan = spans.find(span => span.name === 'chat demo-model')

    expect(modelSpan?.parentSpanId).toBe(ruleSpan?.spanId)
  })
})

function emptyProgress(): ProgressSnapshot {
  return {
    execution: { cached: 0, cancelled: 0, completed: 0, failed: 0, planned: 1, queued: 0, running: 1, skipped: 0 },
    filesPlanned: 1,
    filesTotal: 1,
    jobsCompleted: 0,
    jobsStarted: 1,
    jobsTotal: 1,
    planningComplete: true,
  }
}

async function readSpans(filePath: string): Promise<Array<{ name: string, parentSpanId?: string, spanId: string }>> {
  const text = await readFile(filePath, 'utf8')
  return text.trimEnd().split('\n').flatMap((line) => {
    const data = JSON.parse(line) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string, parentSpanId?: string, spanId: string }> }> }>
    }
    return data.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
  })
}
