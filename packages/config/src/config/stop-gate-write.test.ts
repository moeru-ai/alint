import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { maximumStopGateTimeoutMs } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import { setStopGateConfig } from './stop-gate-write'

describe('stop Gate config writes', () => {
  it('creates a minimal TOML config containing only non-default overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))

    const result = await setStopGateConfig({ cwd, target: 'all' })

    expect(result.config).toEqual({ enabled: false, target: 'all', timeoutMs: 900_000 })
    expect(await readFile(join(cwd, 'alint.config.toml'), 'utf8')).toBe([
      '[[config.group]]',
      'name = "alint stop gate"',
      '',
      '[config.group.integrations.stopGate]',
      'target = "all"',
      '',
    ].join('\n'))
  })

  it('writes and removes the explicit repository activation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))

    const enabled = await setStopGateConfig({ cwd, enabled: true })

    expect(enabled.config.enabled).toBe(true)
    expect(await readFile(join(cwd, 'alint.config.toml'), 'utf8')).toContain('enabled = true')

    const disabled = await setStopGateConfig({ cwd, enabled: false })

    expect(disabled.config.enabled).toBe(false)
    expect(await readFile(join(cwd, 'alint.config.toml'), 'utf8')).not.toContain('enabled =')
  })

  it('removes fields set back to their defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))
    await writeFile(join(cwd, 'alint.config.toml'), [
      '[[config.group]]',
      'name = "rules"',
      '',
      '[[config.group]]',
      'name = "alint stop gate"',
      '',
      '[config.group.integrations.stopGate]',
      'target = "all"',
      'timeoutMs = 30000',
      '',
    ].join('\n'), 'utf8')

    await setStopGateConfig({ cwd, target: 'dirty-files', timeoutMs: 900_000 })

    expect(await readFile(join(cwd, 'alint.config.toml'), 'utf8')).toBe([
      '[[config.group]]',
      'name = "rules"',
      '',
    ].join('\n'))
  })

  it('removes every earlier override when restoring a field default', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))
    const configFile = join(cwd, 'alint.config.toml')
    await writeFile(configFile, [
      '[[config.group]]',
      'name = "first stop gate"',
      '',
      '[config.group.integrations.stopGate]',
      'target = "all"',
      '',
      '[[config.group]]',
      'name = "second stop gate"',
      '',
      '[config.group.integrations.stopGate]',
      'target = "all"',
      'timeoutMs = 30000',
      '',
    ].join('\n'), 'utf8')

    const result = await setStopGateConfig({ cwd, target: 'dirty-files' })
    const written = await readFile(configFile, 'utf8')

    expect(result.config.target).toBe('dirty-files')
    expect(written).not.toContain('target =')
    expect(written).toContain('timeoutMs = 30000')
  })

  it('refuses to create a second config beside an executable config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))
    await writeFile(join(cwd, 'alint.config.ts'), 'export default []\n', 'utf8')

    await expect(setStopGateConfig({ cwd, target: 'all' })).rejects.toThrow(
      'Stop Gate config writes require an alint.config.toml file.',
    )
  })

  it('refuses scoped Stop Gate config without rewriting the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))
    const configFile = join(cwd, 'alint.config.toml')
    const original = [
      '[[config.group]]',
      'files = ["src/**"]',
      '',
      '[config.group.integrations.stopGate]',
      'target = "all"',
      '',
    ].join('\n')
    await writeFile(configFile, original, 'utf8')

    await expect(setStopGateConfig({ cwd, timeoutMs: 30_000 })).rejects.toThrow(
      'integrations.stopGate must be declared in a global config item',
    )
    expect(await readFile(configFile, 'utf8')).toBe(original)
  })

  it('writes an explicitly selected nested TOML config atomically', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))
    await mkdir(join(cwd, 'configs'))
    await writeFile(join(cwd, 'configs', 'alint.config.toml'), '[[config.group]]\nname = "rules"\n', 'utf8')

    await setStopGateConfig({
      configFile: 'configs/alint.config.toml',
      cwd,
      timeoutMs: 30_000,
    })

    expect(await readFile(join(cwd, 'configs', 'alint.config.toml'), 'utf8')).toContain('timeoutMs = 30000')
  })

  it('rejects an oversized timeout before creating a config file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-config-'))

    await expect(setStopGateConfig({
      cwd,
      timeoutMs: maximumStopGateTimeoutMs + 1,
    })).rejects.toThrow(`integrations.stopGate.timeoutMs must be an integer from 1 to ${maximumStopGateTimeoutMs}.`)
    await expect(readFile(join(cwd, 'alint.config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
