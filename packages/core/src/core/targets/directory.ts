import type { DirectoryTarget } from '../../dsl/types'
import type { ExecutionTarget, RuleRuntime, RuleTargetExecution, TargetExecutionPlan } from './types'

export interface PreparedDirectory {
  configHash: string
  ruleRuntimes: RuleRuntime[]
  target: DirectoryTarget
}

export function createDirectoryExecutionPlans(
  directories: PreparedDirectory[],
  fileOffset: number,
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
          cacheFilePaths: [],
          configHash: directory.configHash,
          executions,
          identity: directory.target.path,
          kind: 'directory',
          language: 'directory',
          text: directory.target.path,
        }]

    return {
      emitFileProgress: true,
      fileIndex: fileOffset + directoryOffset + 1,
      path: directory.target.path,
      planned: executions.length,
      targets,
    }
  })
}
