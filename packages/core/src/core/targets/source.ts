import type { ClassTarget, FileTarget, FunctionTarget, SourceTarget } from '../source/types'
import type { ExecutionTarget, PreparedFile, PreparedFileExecutionPlan, RuleRuntime, RuleTargetExecution } from './types'

import { createTargetIdentityResolver, normalizeCachePath } from '../cache'

export function createSourceExecutionPlans(
  files: PreparedFile[],
  cwd: string,
): PreparedFileExecutionPlan[] {
  return files.map((preparedFile, fileOffset) => {
    const targets = collectExecutionTargets(preparedFile)
    const resolveTargetIdentity = createTargetIdentityResolver(
      targets.map(target => toTargetIdentityInput(cwd, preparedFile.file.path, target)),
    )

    for (const target of targets) {
      target.identity = resolveTargetIdentity(toTargetIdentityInput(cwd, preparedFile.file.path, target))
    }

    const filePlan: PreparedFileExecutionPlan = {
      id: `source:${preparedFile.file.path}`,
      index: fileOffset + 1,
      kind: 'source',
      path: preparedFile.file.path,
      planned: 0,
      preparedFile,
      targets,
    }

    filePlan.planned = calculateFilePlanExecutions(filePlan)

    return filePlan
  })
}

function calculateFilePlanExecutions(filePlan: PreparedFileExecutionPlan): number {
  return filePlan.targets.reduce(
    (total, target) => total + target.executions.length,
    0,
  )
}

function collectExecutionTargets(
  preparedFile: PreparedFile,
): ExecutionTarget[] {
  const targets: ExecutionTarget[] = []

  for (const sourceTarget of preparedFile.targets) {
    const executions = preparedFile.ruleRuntimes
      .map((runtime): RuleTargetExecution | undefined => {
        return createSourceTargetExecution(runtime, sourceTarget)
      })
      .filter((execution): execution is RuleTargetExecution => execution !== undefined)

    if (executions.length === 0) {
      continue
    }

    targets.push({
      activeFilePath: preparedFile.file.path,
      cacheFilePaths: [preparedFile.file.path],
      configHash: preparedFile.configHash,
      executions,
      identity: sourceTarget.identity,
      kind: sourceTarget.kind,
      language: sourceTarget.language,
      loc: sourceTarget.loc,
      metadata: sourceTarget.metadata,
      name: sourceTarget.name,
      origin: sourceTarget.origin,
      range: sourceTarget.range,
      text: sourceTarget.text,
    })
  }

  return targets
}

function createSourceTargetExecution(
  runtime: RuleRuntime,
  target: SourceTarget,
): RuleTargetExecution | undefined {
  if (runtime.handlers.onTargetWith) {
    return {
      run: () => runtime.handlers.onTargetWith?.(target),
      runtime,
    }
  }

  if (target.kind === 'class' && runtime.handlers.onTargetClass) {
    return {
      run: () => runtime.handlers.onTargetClass?.(target as ClassTarget),
      runtime,
    }
  }

  if (target.kind === 'file' && runtime.handlers.onTargetFile) {
    return {
      run: () => runtime.handlers.onTargetFile?.(target as FileTarget),
      runtime,
    }
  }

  if (target.kind === 'function' && runtime.handlers.onTargetFunction) {
    return {
      run: () => runtime.handlers.onTargetFunction?.(target as FunctionTarget),
      runtime,
    }
  }

  return undefined
}

function toTargetIdentityInput(
  cwd: string,
  filePath: string,
  target: ExecutionTarget,
) {
  return {
    filePath: target.kind === 'file' ? normalizeCachePath(cwd, filePath) : undefined,
    identity: target.identity,
    kind: target.kind,
    name: target.name,
    range: target.range,
  }
}
