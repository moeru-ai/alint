import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createReportScope } from './scope'

describe('createReportScope', () => {
  it('uses includeFiles and excludeFiles to decide reportable files', () => {
    const scope = createReportScope({
      cwd: '/repo',
      excludeFiles: ['**/*_test.py', '**/vendor/**'],
      includeFiles: ['src/**/*.py'],
    })

    expect(scope.canReport(join('/repo', 'src', 'service.py'))).toBe(true)
    expect(scope.canReport(join('/repo', 'src', 'service_test.py'))).toBe(false)
    expect(scope.canReport(join('/repo', 'src', 'vendor', 'lib.py'))).toBe(false)
    expect(scope.canReport(join('/repo', 'README.md'))).toBe(false)
  })

  it('allows the current target file when includeFiles is omitted', () => {
    const scope = createReportScope({
      cwd: '/repo',
      excludeFiles: [],
      includeFiles: undefined,
      targetFilePath: join('/repo', 'src', 'main.go'),
    })

    expect(scope.canReport(join('/repo', 'src', 'main.go'))).toBe(true)
    expect(scope.canReport(join('/repo', 'src', 'other.go'))).toBe(false)
  })

  it('allows fileless reports only when no file scope is configured', () => {
    const scope = createReportScope({
      cwd: '/repo',
      excludeFiles: [],
    })

    expect(scope.canReport(undefined)).toBe(true)
    expect(scope.canReport(join('/repo', 'src', 'main.go'))).toBe(false)

    const includedScope = createReportScope({
      cwd: '/repo',
      excludeFiles: [],
      includeFiles: ['src/**/*.go'],
    })

    expect(includedScope.canReport(undefined)).toBe(false)
  })

  it('matches dotfiles with glob patterns', () => {
    const scope = createReportScope({
      cwd: '/repo',
      excludeFiles: ['**/.secret.*'],
      includeFiles: ['**/*.env'],
    })

    expect(scope.canReport(join('/repo', '.app.env'))).toBe(true)
    expect(scope.canReport(join('/repo', '.secret.env'))).toBe(false)
  })

  it('rejects paths outside cwd before matching include globs', () => {
    const scope = createReportScope({
      cwd: '/repo',
      excludeFiles: [],
      includeFiles: ['**/*.py'],
    })

    expect(scope.canReport(join('/repo', 'src', 'main.py'))).toBe(true)
    expect(scope.canReport('/outside/main.py')).toBe(false)
    expect(scope.canReport('/repo/../outside/main.py')).toBe(false)

    const escapingPatternScope = createReportScope({
      cwd: '/repo',
      excludeFiles: [],
      includeFiles: ['../**/*.py'],
    })

    expect(escapingPatternScope.canReport('/outside/main.py')).toBe(false)
  })

  it('rejects target files outside cwd', () => {
    const scope = createReportScope({
      cwd: '/repo',
      excludeFiles: [],
      targetFilePath: '/outside/main.py',
    })

    expect(scope.canReport('/outside/main.py')).toBe(false)
  })

  it('rejects drive-qualified paths outside cwd before matching include globs', () => {
    const scope = createReportScope({
      cwd: 'C:/repo',
      excludeFiles: [],
      includeFiles: ['**/*.py'],
    })

    expect(scope.canReport('C:/repo/src/main.py')).toBe(true)
    expect(scope.canReport('D:/other/main.py')).toBe(false)
  })
})
