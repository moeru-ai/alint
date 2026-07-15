import type { DirectoryTarget } from '../../dsl/types'
import type { ExecutionTarget, RuleRuntime, RuleTargetExecution, TargetExecutionPlan } from './types'

export interface PreparedDirectory {
  configHash: string
  ruleRuntimes: RuleRuntime[]
  target: DirectoryTarget
}

export function createDirectoryExecutionPlans(
  directories: PreparedDirectory[],
  sourcePlanCount: number,
): TargetExecutionPlan[] {
  return directories.map((directory, directoryOffset) => {
    const executions = directory.ruleRuntimes
      .map((runtime): RuleTargetExecution | undefined => {
        if (runtime.handlers.onTargetWith) {
          return {
            run: () => runtime.handlers.onTargetWith?.(directory.target),
            runtime,
          }
        }

        if (runtime.handlers.onTargetDirectory) {
          return {
            run: () => runtime.handlers.onTargetDirectory?.(directory.target),
            runtime,
          }
        }

        return undefined
      })
      .filter((execution): execution is RuleTargetExecution => execution !== undefined)
    const targets: ExecutionTarget[] = executions.length === 0
      ? []
      : [{
          activeFilePath: directory.target.path,
          // TODO: (directory-cache-snapshot) Directory caching stays disabled because rule read scope has no stable snapshot contract; revisit only with an owner-approved target-cache design.
          cacheFilePaths: [],
          configHash: directory.configHash,
          executions,
          identity: directory.target.path,
          kind: 'directory',
          language: 'directory',
          text: directory.target.path,
        }]

    return {
      id: `directory:${directory.target.path}`,
      index: sourcePlanCount + directoryOffset + 1,
      kind: 'directory',
      path: directory.target.path,
      planned: executions.length,
      targets,
    }
  })
}
