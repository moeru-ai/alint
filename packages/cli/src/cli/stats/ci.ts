import process from 'node:process'

// A very simple dependency-free CI detection helper function.
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI

  if (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false') {
    return true
  }

  return Boolean(
    env.GITHUB_ACTIONS
    || env.GITLAB_CI
    || env.CIRCLECI
    || env.BUILDKITE
    || env.TF_BUILD,
  )
}
