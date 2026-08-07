import type { AlintConfig, AlintConfigItem, StopGateConfig, StopGateTarget } from '../dsl/types'

import { resolveConfigForProject } from './config-array'

export interface ResolvedStopGateConfig {
  enabled: boolean
  target: StopGateTarget
  timeoutMs: number
}

// NOTICE: Codex caps the entire Stop hook at 24 hours. Keeping the public lint timeout five
// minutes lower leaves room for Git-root discovery, CLI resolution, process startup, and state
// persistence, so the plugin can report its own structured timeout instead of being killed by
// the host first.
export const maximumStopGateTimeoutMs = (23 * 60 + 55) * 60 * 1000

export const defaultStopGateConfig: Readonly<ResolvedStopGateConfig> = {
  enabled: false,
  target: 'dirty-files',
  timeoutMs: 15 * 60 * 1000,
}

export function resolveStopGateConfig(config: AlintConfig, cwd: string): ResolvedStopGateConfig {
  const project = resolveConfigForProject(cwd, config, { cwd })

  for (const skipped of project.skipped) {
    if (skipped.item.integrations?.stopGate !== undefined) {
      throw new Error('integrations.stopGate must be declared in a global config item without files, directories, or ignores.')
    }
  }

  return project.matched.reduce<ResolvedStopGateConfig>(
    (resolved, item) => mergeStopGateConfig(resolved, item),
    { ...defaultStopGateConfig },
  )
}

function assertStopGateConfig(value: StopGateConfig): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('integrations.stopGate must be an object.')
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new TypeError('integrations.stopGate.enabled must be a boolean.')
  }

  if (value.target !== undefined && value.target !== 'all' && value.target !== 'dirty-files') {
    throw new TypeError('integrations.stopGate.target must be "all" or "dirty-files".')
  }

  if (
    value.timeoutMs !== undefined
    && (
      !Number.isInteger(value.timeoutMs)
      || value.timeoutMs <= 0
      || value.timeoutMs > maximumStopGateTimeoutMs
    )
  ) {
    throw new TypeError(`integrations.stopGate.timeoutMs must be an integer from 1 to ${maximumStopGateTimeoutMs}.`)
  }
}

function mergeStopGateConfig(
  resolved: ResolvedStopGateConfig,
  item: AlintConfigItem,
): ResolvedStopGateConfig {
  const stopGate = item.integrations?.stopGate

  if (stopGate === undefined) {
    return resolved
  }

  assertStopGateConfig(stopGate)

  return {
    enabled: stopGate.enabled ?? resolved.enabled,
    target: stopGate.target ?? resolved.target,
    timeoutMs: stopGate.timeoutMs ?? resolved.timeoutMs,
  }
}
