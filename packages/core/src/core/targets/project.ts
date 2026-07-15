import type { ProjectTarget } from '../../dsl/types'
import type { ExecutionTarget, PreparedFile, RuleRuntime, RuleTargetExecution, TargetExecutionPlan } from './types'

import { hashText, normalizeCachePath, stableHash } from '../cache'

export function createProjectExecutionPlan(options: {
  configHash: string
  files: PreparedFile[]
  index: number
  root: string
  ruleRuntimes: RuleRuntime[]
}): TargetExecutionPlan | undefined {
  const project = createProjectTarget(options.root, options.files)
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
    cacheFilePaths: options.files.map(file => file.file.path),
    configHash: options.configHash,
    executions,
    identity: 'project',
    kind: 'project',
    language: 'project',
    text: stableHash({
      files: options.files
        .map(file => ({
          configHash: file.configHash,
          contentHash: hashText(file.file.text),
          path: normalizeCachePath(options.root, file.file.path),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      targets: project.targets.map(target => ({
        filePath: normalizeCachePath(options.root, target.file.path),
        identity: target.identity,
        kind: target.kind,
        language: target.language,
        loc: target.loc,
        metadata: target.metadata,
        name: target.name,
        origin: target.origin,
        range: target.range,
        text: target.text,
      })),
      tree: createProjectTreeShape(options.files, options.root),
    }),
  }

  return {
    id: `project:${options.root}`,
    index: options.index,
    kind: 'project',
    path: options.root,
    planned: executions.length,
    targets: [target],
  }
}

export function createProjectTarget(root: string, files: PreparedFile[]): ProjectTarget {
  const preparedFiles = [...files].sort((left, right) => left.file.path.localeCompare(right.file.path))

  return {
    files: preparedFiles.map(file => file.file),
    kind: 'project',
    root,
    targets: preparedFiles.flatMap(file => file.targets),
  }
}

function createProjectTreeShape(files: PreparedFile[], root: string): { directories: string[], files: string[] } {
  const directories = new Set<string>()
  const paths = files
    .map(file => normalizeCachePath(root, file.file.path))
    .sort()

  for (const path of paths) {
    const parts = path.split('/')

    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'))
    }
  }

  return {
    directories: [...directories].sort(),
    files: paths,
  }
}
