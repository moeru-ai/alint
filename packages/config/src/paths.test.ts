import { homedir } from 'node:os'

import { join } from 'pathe'
import { describe, expect, it } from 'vitest'

import {
  getGlobalSetupConfigPath,
  getProjectPluginLockPath,
  getProjectPluginStorePath,
  getProjectSetupConfigPath,
  getStatsDir,
} from './paths'

describe('setup config paths', () => {
  it('uses XDG_CONFIG_HOME when explicitly provided', () => {
    expect(getGlobalSetupConfigPath({ XDG_CONFIG_HOME: '/tmp/alint-config' }, { isMacOS: true })).toBe(
      '/tmp/alint-config/alint/config.toml',
    )
  })

  it('uses ~/.config on macOS by default', () => {
    expect(getGlobalSetupConfigPath({}, { isMacOS: true, xdgConfig: '/xdg/config' })).toBe(
      join(homedir(), '.config', 'alint', 'config.toml'),
    )
  })

  it('uses xdg-basedir config path outside macOS', () => {
    expect(getGlobalSetupConfigPath({}, { isMacOS: false, xdgConfig: '/xdg/config' })).toBe(
      '/xdg/config/alint/config.toml',
    )
  })

  it('uses project-local config under .alint', () => {
    expect(getProjectSetupConfigPath('/repo')).toBe('/repo/.alint/config.toml')
  })

  it('uses project-local plugin lock under .alint/plugins', () => {
    expect(getProjectPluginLockPath('/repo')).toBe('/repo/.alint/plugins/lock.json')
  })

  it('uses project-local plugin store under .alint/plugins', () => {
    expect(getProjectPluginStorePath('/repo')).toBe('/repo/.alint/plugins/store')
  })
})

describe('stats dir', () => {
  it('shares the alint home base with the global config', () => {
    expect(getStatsDir({ XDG_CONFIG_HOME: '/tmp/alint-config' }, { isMacOS: true })).toBe(
      '/tmp/alint-config/alint/stats',
    )
  })

  it('uses ~/.config on macOS by default', () => {
    expect(getStatsDir({}, { isMacOS: true, xdgConfig: '/xdg/config' })).toBe(
      join(homedir(), '.config', 'alint', 'stats'),
    )
  })

  it('uses xdg-basedir config path outside macOS', () => {
    expect(getStatsDir({}, { isMacOS: false, xdgConfig: '/xdg/config' })).toBe(
      '/xdg/config/alint/stats',
    )
  })
})
