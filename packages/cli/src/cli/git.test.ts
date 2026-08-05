import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { x } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { findDirtyFiles, findGitRoot } from './git'

describe('git discovery', () => {
  it('finds staged, unstaged, and untracked files but excludes deleted files', async () => {
    const cwd = await createRepository()
    await writeFile(join(cwd, 'unstaged.ts'), 'changed\n', 'utf8')
    await writeFile(join(cwd, 'staged.ts'), 'staged\n', 'utf8')
    await git(cwd, ['add', 'staged.ts'])
    await writeFile(join(cwd, 'untracked.ts'), 'new\n', 'utf8')
    await rename(join(cwd, 'renamed-old.ts'), join(cwd, 'renamed-new.ts'))

    const files = await findDirtyFiles(cwd)

    expect(files).toContain('renamed-new.ts')
    expect(files).toContain('staged.ts')
    expect(files).toContain('unstaged.ts')
    expect(files).toContain('untracked.ts')
    expect(files).not.toContain('renamed-old.ts')
    expect(files).not.toContain('deleted.ts')
  })

  it('finds the root from a nested directory', async () => {
    const cwd = await createRepository()
    const nested = join(cwd, 'nested')
    await mkdir(nested)

    expect(await findGitRoot(nested)).toBe(cwd)
  })
})

async function createRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-git-'))
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'test@example.com'])
  await git(cwd, ['config', 'user.name', 'Test'])

  for (const file of ['deleted.ts', 'renamed-old.ts', 'staged.ts', 'unstaged.ts']) {
    await writeFile(join(cwd, file), 'original\n', 'utf8')
  }

  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])
  await rm(join(cwd, 'deleted.ts'))
  return cwd
}

async function git(cwd: string, args: string[]): Promise<void> {
  await x('git', args, {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
}
