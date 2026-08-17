import { describe, expect, it } from 'vitest'

import { parseConfigOutput, parseEnvelope } from './protocol'

describe('stop gate protocol', () => {
  it('parses every valid envelope shape', () => {
    const clean = parseEnvelope(JSON.stringify({
      errorCount: 0,
      schemaVersion: 2,
      status: 'clean',
      warningCount: 0,
    }))
    const findings = parseEnvelope(JSON.stringify({
      errorCount: 1,
      findingsHash: 'a'.repeat(64),
      reportPath: '/tmp/report.json',
      schemaVersion: 2,
      status: 'errors',
      warningCount: 2,
    }))
    const runtimeError = parseEnvelope(JSON.stringify({
      errorCount: 0,
      message: 'failed',
      reportPath: '/tmp/failure-report.json',
      schemaVersion: 2,
      status: 'runtime-error',
      warningCount: 0,
    }))

    expect(clean?.status).toBe('clean')
    expect(findings?.status).toBe('errors')
    expect(runtimeError).toMatchObject({
      reportPath: '/tmp/failure-report.json',
      status: 'runtime-error',
    })
  })

  it('rejects findings without their protocol fields', () => {
    const withoutHash = parseEnvelope(JSON.stringify({
      errorCount: 1,
      reportPath: '/tmp/report.json',
      schemaVersion: 2,
      status: 'errors',
      warningCount: 0,
    }))
    const withoutReport = parseEnvelope(JSON.stringify({
      errorCount: 0,
      findingsHash: 'a'.repeat(64),
      schemaVersion: 2,
      status: 'warnings',
      warningCount: 1,
    }))

    expect(withoutHash).toBeUndefined()
    expect(withoutReport).toBeUndefined()
  })

  it('rejects counts that conflict with the reported status', () => {
    const negative = parseEnvelope(JSON.stringify({
      errorCount: -1,
      schemaVersion: 2,
      status: 'clean',
      warningCount: 0,
    }))
    const dirtyClean = parseEnvelope(JSON.stringify({
      errorCount: 0,
      schemaVersion: 2,
      status: 'clean',
      warningCount: 1,
    }))
    const emptyWarnings = parseEnvelope(JSON.stringify({
      errorCount: 0,
      findingsHash: 'a'.repeat(64),
      reportPath: '/tmp/report.json',
      schemaVersion: 2,
      status: 'warnings',
      warningCount: 0,
    }))

    expect(negative).toBeUndefined()
    expect(dirtyClean).toBeUndefined()
    expect(emptyWarnings).toBeUndefined()
  })

  it('requires runtime failures to include a message', () => {
    const result = parseEnvelope(JSON.stringify({
      errorCount: 0,
      schemaVersion: 2,
      status: 'runtime-error',
      warningCount: 0,
    }))

    expect(result).toBeUndefined()
  })

  it('rejects an empty runtime failure report path', () => {
    const result = parseEnvelope(JSON.stringify({
      errorCount: 0,
      message: 'failed',
      reportPath: '',
      schemaVersion: 2,
      status: 'runtime-error',
      warningCount: 0,
    }))

    expect(result).toBeUndefined()
  })

  it('rejects configuration timeouts outside the Codex hook budget', () => {
    const valid = parseConfigOutput([
      'enabled: true',
      'target: dirty-files',
      'timeoutMs: 86100000',
    ].join('\n'))
    const tooLarge = parseConfigOutput([
      'enabled: true',
      'target: dirty-files',
      'timeoutMs: 86100001',
    ].join('\n'))

    expect(valid?.timeoutMs).toBe(86_100_000)
    expect(tooLarge).toBeUndefined()
  })
})
