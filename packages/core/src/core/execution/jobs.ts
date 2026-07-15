import type { TargetExecutionPlan } from '../targets/types'
import type { RuleExecutionJob } from './types'

export function createRuleExecutionJobs(plans: TargetExecutionPlan[]): RuleExecutionJob[] {
  const jobs: RuleExecutionJob[] = []
  const jobsTotal = plans.reduce((total, plan) => total + plan.planned, 0)

  for (const plan of plans) {
    for (const [targetOffset, target] of plan.targets.entries()) {
      for (const [ruleOffset, execution] of target.executions.entries()) {
        jobs.push({
          execution,
          path: {
            job: {
              index: jobs.length + 1,
              total: jobsTotal,
            },
            plan: {
              id: plan.id,
              index: plan.index,
              kind: plan.kind,
              path: plan.path,
              planned: plan.planned,
              total: plans.length,
            },
            rule: {
              id: execution.runtime.enabledRule.id,
              index: ruleOffset + 1,
              total: target.executions.length,
            },
            target: {
              identity: target.identity,
              index: targetOffset + 1,
              kind: target.kind,
              name: target.name,
              total: plan.targets.length,
            },
          },
          plan,
          target,
        })
      }
    }
  }

  return jobs
}
