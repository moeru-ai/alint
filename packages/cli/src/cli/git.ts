import { x } from 'tinyexec'

const gitTimeoutMs = 60_000

/** Finds every existing file whose working-tree content is not represented by HEAD. */
export async function findDirtyFiles(cwd: string): Promise<string[]> {
  const [unstaged, staged, untracked] = await Promise.all([
    diffFiles(cwd, []),
    diffFiles(cwd, ['--cached']),
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])

  return [...new Set([
    ...parseNullSeparatedPaths(unstaged),
    ...parseNullSeparatedPaths(staged),
    ...parseNullSeparatedPaths(untracked),
  ])].sort()
}

export async function findGitRoot(cwd: string): Promise<string> {
  const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()

  if (root.length === 0) {
    throw new Error('Git did not return a repository root.')
  }

  return root
}

function diffFiles(cwd: string, options: string[]): Promise<string> {
  return runGit(cwd, [
    'diff',
    ...options,
    '--name-only',
    '-z',
    // Deleted paths have no source left for alint to read. Rename detection keeps only the new path.
    '--diff-filter=ACMRTUXB',
    '--find-renames',
    '--',
  ])
}

function parseNullSeparatedPaths(output: string): string[] {
  return output.split('\0').filter(path => path.length > 0)
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await x('git', args, {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
    timeout: gitTimeoutMs,
  })

  return result.stdout
}
