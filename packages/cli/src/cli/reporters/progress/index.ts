import type { ProgressReporter } from '@alint-js/core'

import cliSpinners from 'cli-spinners'

import { createPlainProgressReporter } from './plain'
import { createSummaryProgressReporter } from './summary'
import { createTtyProgressRenderer } from './tty'

export interface CliProgressReporter {
  dispose: () => void
  reporter: ProgressReporter
  write: (chunk: string) => void
}

export interface CliProgressReporterOptions {
  color: boolean
  columns: number
  cwd: string
  isTty: boolean
  rows?: number
  write: (chunk: string) => void
}

export function createCliProgressReporter(options: CliProgressReporterOptions): CliProgressReporter {
  if (!options.isTty) {
    return {
      dispose: () => {},
      reporter: createPlainProgressReporter({ write: options.write }),
      write: options.write,
    }
  }

  const summary = createSummaryProgressReporter({
    color: options.color,
    columns: options.columns,
    cwd: options.cwd,
    rows: options.rows,
    spinnerFrames: cliSpinners.dots.frames,
  })
  const renderer = createTtyProgressRenderer<ReturnType<typeof globalThis.setInterval>>({
    clearInterval: handle => globalThis.clearInterval(handle),
    createInterval: (callback, intervalMs) => globalThis.setInterval(() => {
      summary.tick()
      callback()
    }, intervalMs),
    getRows: summary.getRows,
    intervalMs: 120,
    write: options.write,
  })
  const reporter = createRenderingProgressReporter(summary, renderer)

  return {
    dispose: renderer.finish,
    reporter,
    write: renderer.write,
  }
}

function createRenderingProgressReporter(
  summary: ProgressReporter,
  renderer: { render: () => void, start: () => void },
): ProgressReporter {
  return {
    onDiagnostic: (payload) => {
      summary.onDiagnostic?.(payload)
      renderer.render()
    },
    onExecuteEnd: (payload) => {
      summary.onExecuteEnd?.(payload)
      renderer.render()
    },
    onExecuteStart: (payload) => {
      summary.onExecuteStart?.(payload)
      renderer.render()
    },
    onFileReady: (payload) => {
      summary.onFileReady?.(payload)
      renderer.render()
    },
    onJobEnd: (payload) => {
      summary.onJobEnd?.(payload)
      renderer.render()
    },
    onJobQueued: (payload) => {
      summary.onJobQueued?.(payload)
      renderer.render()
    },
    onJobRetry: (payload) => {
      summary.onJobRetry?.(payload)
      renderer.render()
    },
    onJobStart: (payload) => {
      summary.onJobStart?.(payload)
      renderer.render()
    },
    onPrepareEnd: (payload) => {
      summary.onPrepareEnd?.(payload)
      renderer.render()
    },
    onPrepareStart: (payload) => {
      summary.onPrepareStart?.(payload)
      renderer.start()
    },
    onRunEnd: (payload) => {
      summary.onRunEnd?.(payload)
      renderer.render()
    },
    onUsage: (payload) => {
      summary.onUsage?.(payload)
      renderer.render()
    },
  }
}
