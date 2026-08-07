import { readFile } from 'node:fs/promises'

import { parsePatch } from 'diff'
import { resolve } from 'pathe'
import { x } from 'tinyexec'

const gitTimeoutMs = 60_000
const gitlinkMode = '160000'

export interface ChangedLineRange {
  endLine: number
  startLine: number
}

export interface DirtyChanges {
  changedLines: ReadonlyMap<string, readonly ChangedLineRange[]>
  files: string[]
}

/**
 * Collects staged, unstaged, and untracked changes relative to HEAD.
 * Deleted files and Git-controlled submodule worktrees stay outside the lint boundary.
 */
export async function findDirtyChanges(cwd: string): Promise<DirtyChanges> {
  const [tracked, untracked, patch, stagedEntries] = await Promise.all([
    diffFiles(cwd),
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    diffPatch(cwd),
    runGit(cwd, ['ls-files', '--stage', '-z']),
  ])
  const gitlinks = parseGitlinks(stagedEntries)
  const trackedFiles = withoutGitlinks(parseNullSeparatedPaths(tracked), gitlinks)
  const untrackedFiles = withoutGitlinks(parseNullSeparatedPaths(untracked), gitlinks)
  const files = [...new Set([...trackedFiles, ...untrackedFiles])].sort()
  const changedLines = changedLinesFromPatch(patch, gitlinks)

  await Promise.all(untrackedFiles.map(async (file) => {
    const content = await readFile(resolve(cwd, file), 'utf8')
    const lineCount = content.length === 0
      ? 0
      : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)

    if (lineCount > 0) {
      changedLines.set(file, [{ endLine: lineCount, startLine: 1 }])
    }
  }))

  return { changedLines, files }
}

export async function findGitRoot(cwd: string): Promise<string> {
  const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()

  if (root.length === 0) {
    throw new Error('Git did not return a repository root.')
  }

  return root
}

function changedLinesFromPatch(patch: string, gitlinks: ReadonlySet<string>): Map<string, ChangedLineRange[]> {
  const changedLines = new Map<string, ChangedLineRange[]>()

  for (const file of parsePatch(patch)) {
    const path = newPatchPath(file.newFileName)

    if (path === undefined || isWithinGitlink(path, gitlinks)) {
      continue
    }

    const lines: number[] = []

    for (const hunk of file.hunks) {
      let newLine = hunk.newStart

      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          lines.push(newLine)
          newLine += 1
        }
        else if (!line.startsWith('-') && !line.startsWith('\\')) {
          newLine += 1
        }
      }
    }

    const ranges = lineRanges(lines)

    if (ranges.length > 0) {
      changedLines.set(path, ranges)
    }
  }

  return changedLines
}

function diffFiles(cwd: string): Promise<string> {
  return runGit(cwd, [
    'diff',
    '--name-only',
    '-z',
    // Deleted paths have no source left for alint to read. Rename detection keeps only the new path.
    '--diff-filter=ACMRTUXB',
    '--find-renames',
    '--ignore-submodules=none',
    'HEAD',
    '--',
  ])
}

function diffPatch(cwd: string): Promise<string> {
  return runGit(cwd, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--unified=0',
    '--diff-filter=ACMRTUXB',
    '--find-renames',
    '--ignore-submodules=none',
    '--submodule=short',
    'HEAD',
    '--',
  ])
}

function isWithinGitlink(path: string, gitlinks: ReadonlySet<string>): boolean {
  for (const gitlink of gitlinks) {
    if (path === gitlink || path.startsWith(`${gitlink}/`)) {
      return true
    }
  }

  return false
}

function lineRanges(lines: readonly number[]): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = []

  for (const line of lines) {
    const previous = ranges.at(-1)

    if (previous && line === previous.endLine + 1) {
      previous.endLine = line
    }
    else {
      ranges.push({ endLine: line, startLine: line })
    }
  }

  return ranges
}

function newPatchPath(fileName: string | undefined): string | undefined {
  if (fileName === undefined || fileName === '/dev/null') {
    return undefined
  }

  return fileName.startsWith('b/') ? fileName.slice(2) : fileName
}

function parseGitlinks(output: string): Set<string> {
  const gitlinks = new Set<string>()

  for (const entry of parseNullSeparatedPaths(output)) {
    const separator = entry.indexOf('\t')

    if (separator === -1 || !entry.startsWith(`${gitlinkMode} `)) {
      continue
    }

    gitlinks.add(entry.slice(separator + 1))
  }

  return gitlinks
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

function withoutGitlinks(paths: readonly string[], gitlinks: ReadonlySet<string>): string[] {
  return paths.filter(path => !isWithinGitlink(path, gitlinks))
}
