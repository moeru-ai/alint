import type { CacheStore } from '../cache'
import type { ProjectIndex } from '../project/types'
import type { ExecutionTarget, RuleRuntime, RuleTargetExecution, TargetExecutionPlan } from './types'

export function createProjectExecutionPlan(options: {
  cacheStore: CacheStore
  configHash: string
  index: number
  project: ProjectIndex
  ruleRuntimes: RuleRuntime[]
}): TargetExecutionPlan | undefined {
  const { hash, target: project } = options.project
  const executions = options.ruleRuntimes
    .map((runtime): RuleTargetExecution | undefined => {
      if (runtime.handlers.onTargetWith) {
        return {
          run: () => runtime.handlers.onTargetWith?.(project),
          runtime,
        }
      }

      if (runtime.handlers.onTargetProject) {
        return {
          run: () => runtime.handlers.onTargetProject?.(project),
          runtime,
        }
      }

      return undefined
    })
    .filter((execution): execution is RuleTargetExecution => execution !== undefined)

  if (executions.length === 0) {
    return undefined
  }

  const target: ExecutionTarget = {
    cacheOwner: options.cacheStore.beginOwner({ kind: 'project', path: project.root }),
    cacheTargetHash: hash,
    configHash: options.configHash,
    executions,
    identity: 'project',
    kind: 'project',
    language: 'project',
    text: hash,
  }

  return {
    id: `project:${project.root}`,
    index: options.index,
    kind: 'project',
    path: project.root,
    planned: executions.length,
    targets: [target],
  }
}
