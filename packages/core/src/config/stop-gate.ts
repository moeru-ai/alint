import type { AlintConfig, AlintConfigItem, StopGateConfig, StopGateTarget } from '../dsl/types'

import { boolean, integer, looseObject, maxValue, minValue, number, optional, parse, picklist, pipe } from 'valibot'

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

const stopGateConfigSchema = looseObject({
  enabled: optional(boolean('integrations.stopGate.enabled must be a boolean.')),
  target: optional(picklist(
    ['all', 'dirty-files'],
    'integrations.stopGate.target must be "all" or "dirty-files".',
  )),
  timeoutMs: optional(pipe(
    number(`integrations.stopGate.timeoutMs must be an integer from 1 to ${maximumStopGateTimeoutMs}.`),
    integer(`integrations.stopGate.timeoutMs must be an integer from 1 to ${maximumStopGateTimeoutMs}.`),
    minValue(1, `integrations.stopGate.timeoutMs must be an integer from 1 to ${maximumStopGateTimeoutMs}.`),
    maxValue(maximumStopGateTimeoutMs, `integrations.stopGate.timeoutMs must be an integer from 1 to ${maximumStopGateTimeoutMs}.`),
  )),
}, 'integrations.stopGate must be an object.')

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
  parse(stopGateConfigSchema, value)
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
