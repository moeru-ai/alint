import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createTools, DEFAULT_IGNORE_PATTERNS, listFiles } from './index'
import { MAX_LISTED_FILES } from './list'
import { MAX_REPOSITORY_FILE_BYTES } from './repository'
import { searchFileContents } from './search'

async function createProject(): Promise<{ cwd: string, outsidePath: string, root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'alint-tools-fs-'))
  const cwd = join(root, 'project')

  await mkdir(join(cwd, 'src/alpha'), { recursive: true })
  await mkdir(join(cwd, 'src/beta'), { recursive: true })
  await mkdir(join(cwd, 'vendor/generated'), { recursive: true })
  await mkdir(join(cwd, '.venv'), { recursive: true })

  await writeFile(join(cwd, 'README.md'), '# Readme\n')
  await writeFile(join(cwd, 'src/alpha/keep.txt'), 'alpha NEEDLE line\nsecond line\n')
  await writeFile(join(cwd, 'src/beta/keep.txt'), 'beta NEEDLE line\n')
  await writeFile(join(cwd, 'vendor/generated/ignored.txt'), 'vendor NEEDLE line\n')
  await writeFile(join(cwd, '.venv/lib.txt'), 'venv NEEDLE line\n')

  const outsidePath = join(root, 'outside.txt')
  await writeFile(outsidePath, 'outside project root\n')

  return { cwd, outsidePath, root }
}

function toolNamed(cwd: string, name: string, options?: Parameters<typeof createTools>[1]) {
  const tool = createTools(cwd, options).find(candidate => candidate.name === name)

  if (!tool) {
    throw new Error(`Expected tool "${name}"`)
  }

  return tool
}

describe('createTools', () => {
  it('exposes the four filesystem tools', () => {
    const names = createTools('/repo').map(tool => tool.name)

    expect(names).toEqual(['read_file', 'list_files', 'search_files', 'search_in_files'])
  })

  it('uses strict-provider-compatible parameter schemas', () => {
    for (const tool of createTools('/repo')) {
      const parameters = tool.parameters as {
        properties: Record<string, unknown>
        required?: string[]
      }

      expect(parameters.required).toEqual(Object.keys(parameters.properties))
    }

    const listParameters = toolNamed('/repo', 'list_files').parameters as {
      properties: Record<string, unknown>
    }

    expect(JSON.stringify(listParameters.properties)).toContain('"type":"null"')

    for (const toolName of ['search_files', 'search_in_files']) {
      const searchParameters = toolNamed('/repo', toolName).parameters as {
        properties: { query: Record<string, unknown> }
      }

      expect(searchParameters.properties.query).toMatchObject({
        minLength: 1,
        pattern: '\\S',
        type: 'string',
      })
    }
  })

  it.each(['search_files', 'search_in_files'])('rejects blank queries for %s', async (toolName) => {
    const { cwd } = await createProject()
    const tool = toolNamed(cwd, toolName, { confined: true })

    await expect(tool.execute({ query: '' })).rejects.toThrow(/non-blank string/i)
    await expect(tool.execute({ query: '   ' })).rejects.toThrow(/non-blank string/i)
  })

  it('lists files while honoring base ignores and glob patterns', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files').execute({ patterns: '**/*.txt' }))

    expect(listed).toContain('src/alpha/keep.txt')
    expect(listed).toContain('src/beta/keep.txt')
    // vendor is a base default ignore.
    expect(listed).not.toContain('vendor/generated/ignored.txt')
  })

  it('preserves the public listFiles default cap', async () => {
    const { cwd } = await createProject()
    await mkdir(join(cwd, 'many'), { recursive: true })

    for (let index = 0; index < MAX_LISTED_FILES + 5; index += 1) {
      await writeFile(join(cwd, 'many', `${String(index).padStart(3, '0')}.txt`), 'value\n')
    }

    await expect(listFiles(cwd, { patterns: '**/*.txt' })).resolves.toHaveLength(MAX_LISTED_FILES)
  })

  it('stops content search at an explicit total byte budget', async () => {
    const { cwd } = await createProject()
    const first = join(cwd, 'first-budget.txt')
    const second = join(cwd, 'second-budget.txt')
    await writeFile(first, '12345678')
    await writeFile(second, 'BUDGET_MARKER')

    const result = await searchFileContents(cwd, 'BUDGET_MARKER', [first, second], 8)

    expect(result).not.toContain('BUDGET_MARKER')
    expect(result).toMatch(/byte budget/i)
  })

  it('extends the builtins by spreading DEFAULT_IGNORE_PATTERNS', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files', { ignore: [...DEFAULT_IGNORE_PATTERNS, '**/.venv/**'] }).execute({ patterns: '**/*.txt' }))

    expect(listed).toContain('src/alpha/keep.txt')
    expect(listed).not.toContain('vendor/generated/ignored.txt') // still ignored via the spread base
    expect(listed).not.toContain('.venv/lib.txt') // ignored via the added pattern
  })

  it('replaces the builtins when ignore is passed without them', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files', { ignore: ['**/.venv/**'] }).execute({ patterns: '**/*.txt' }))

    expect(listed).not.toContain('.venv/lib.txt') // the only pattern we passed
    // The base is fully replaced, so vendor is no longer ignored.
    expect(listed).toContain('vendor/generated/ignored.txt')
  })

  it('reads files relative to cwd and absolute paths outside the project root', async () => {
    const { cwd, outsidePath } = await createProject()

    const readFile = toolNamed(cwd, 'read_file')

    expect(String(await readFile.execute({ path: 'README.md' }))).toContain('# Readme')
    expect(String(await readFile.execute({ path: outsidePath }))).toContain('outside project root')
  })

  it('rejects absolute paths and lexical traversal in repository-confined mode', async () => {
    const { cwd, outsidePath } = await createProject()
    const confinedOptions = { confined: true }

    await expect(toolNamed(cwd, 'read_file', confinedOptions).execute({ path: outsidePath })).rejects.toThrow(/absolute paths are not allowed/i)
    await expect(toolNamed(cwd, 'read_file', confinedOptions).execute({ path: '../outside.txt' })).rejects.toThrow(/parent traversal is not allowed/i)
    await expect(toolNamed(cwd, 'list_files', confinedOptions).execute({ directory: '../' })).rejects.toThrow(/parent traversal is not allowed/i)
    await expect(toolNamed(cwd, 'search_files', confinedOptions).execute({ directory: outsidePath, query: 'outside' })).rejects.toThrow(/absolute paths are not allowed/i)
    await expect(toolNamed(cwd, 'search_in_files', confinedOptions).execute({ patterns: '../*.txt', query: 'outside' })).rejects.toThrow(/parent traversal is not allowed/i)
  })

  it('rejects symlink escapes in repository-confined mode', async () => {
    const { cwd, outsidePath } = await createProject()
    await symlink(outsidePath, join(cwd, 'outside-link.txt'))

    const readFile = toolNamed(cwd, 'read_file', { confined: true })

    await expect(readFile.execute({ path: 'outside-link.txt' })).rejects.toThrow(/outside the repository/i)
  })

  it('does not traverse directory symlinks during repository-confined list and search walks', async () => {
    const { cwd, root } = await createProject()
    const externalDirectory = join(root, 'external-tree')
    const marker = 'EXTERNAL_DIRECTORY_MARKER'
    await mkdir(join(externalDirectory, 'nested'), { recursive: true })
    await writeFile(join(externalDirectory, 'nested/outside-only.txt'), `${marker}\n`)
    await symlink(externalDirectory, join(cwd, 'linked-external'), 'dir')

    const walkedFiles = await listFiles(cwd, { followSymbolicLinks: false })
    const confinedOptions = { confined: true }
    const listed = String(await toolNamed(cwd, 'list_files', confinedOptions).execute({}))
    const pathMatches = String(await toolNamed(cwd, 'search_files', confinedOptions).execute({ query: 'outside-only' }))
    const contentMatches = String(await toolNamed(cwd, 'search_in_files', confinedOptions).execute({ query: marker }))

    expect(walkedFiles).not.toContain(join(cwd, 'linked-external/nested/outside-only.txt'))
    expect(listed).not.toContain('linked-external')
    expect(pathMatches).toBe('')
    expect(contentMatches).toBe('')
  })

  it('blocks ignored and likely-secret direct reads in repository-confined mode', async () => {
    const { cwd } = await createProject()
    await writeFile(join(cwd, '.env.local'), 'PRIVATE_TOKEN=do-not-expose\n')

    const readFile = toolNamed(cwd, 'read_file', { confined: true })

    await expect(readFile.execute({ path: 'vendor/generated/ignored.txt' })).rejects.toThrow(/ignored by repository policy/i)
    await expect(readFile.execute({ path: '.env.local' })).rejects.toThrow(/likely secret/i)
  })

  it('blocks .envrc direct reads in repository-confined mode', async () => {
    const { cwd } = await createProject()
    await writeFile(join(cwd, '.envrc'), 'PRIVATE_TOKEN=do-not-expose\n')

    const readFile = toolNamed(cwd, 'read_file', { confined: true })

    await expect(readFile.execute({ path: '.envrc' })).rejects.toThrow(/likely secret/i)
  })

  it('excludes .env-prefixed files from repository-confined discovery', async () => {
    const { cwd } = await createProject()
    const marker = 'ENVRC_PRIVATE_MARKER'
    await writeFile(join(cwd, '.envrc'), `${marker}\n`)

    const confinedOptions = { confined: true }
    const listed = String(await toolNamed(cwd, 'list_files', confinedOptions).execute({}))
    const pathMatches = String(await toolNamed(cwd, 'search_files', confinedOptions).execute({ query: '.envrc' }))
    const contentMatches = String(await toolNamed(cwd, 'search_in_files', confinedOptions).execute({ query: marker }))

    expect(listed).not.toContain('.envrc')
    expect(pathMatches).not.toContain('.envrc')
    expect(contentMatches).not.toContain(marker)
  })

  it('allows common environment templates and credential source files in repository-confined mode', async () => {
    const { cwd } = await createProject()
    const safeFiles = [
      '.env.example',
      '.env.sample',
      '.env.template',
      '.environment.ts',
      'credentials.ts',
    ]

    for (const file of safeFiles) {
      await writeFile(join(cwd, file), `SAFE_TEMPLATE_MARKER ${file}\n`)
    }

    const confinedOptions = { confined: true }
    const readFile = toolNamed(cwd, 'read_file', confinedOptions)
    const listed = String(await toolNamed(cwd, 'list_files', confinedOptions).execute({}))
    const contentMatches = String(await toolNamed(cwd, 'search_in_files', confinedOptions).execute({ query: 'SAFE_TEMPLATE_MARKER' }))

    for (const file of safeFiles) {
      await expect(readFile.execute({ path: file })).resolves.toContain(`SAFE_TEMPLATE_MARKER ${file}`)
      expect(listed).toContain(file)
      expect(contentMatches).toContain(file)
    }
  })

  it('blocks common credential containers while preserving safe config files in repository-confined mode', async () => {
    const { cwd } = await createProject()
    const credentialFiles = [
      '.npmrc',
      '.netrc',
      '.pypirc',
      '.git-credentials',
      '.docker/config.json',
      '.docker/config.json.example',
      '.aws/credentials',
      '.aws/config',
      '.config/gh/hosts.yml',
      '.config/gcloud/application_default_credentials.json',
    ]

    for (const file of credentialFiles) {
      await mkdir(join(cwd, dirname(file)), { recursive: true })
      await writeFile(join(cwd, file), `CREDENTIAL_CONTAINER_MARKER ${file}\n`)
    }

    const safeFiles = [
      '.npmrc.example',
      'settings/config.json',
    ]

    for (const file of safeFiles) {
      await mkdir(join(cwd, dirname(file)), { recursive: true })
      await writeFile(join(cwd, file), `SAFE_CONFIG_MARKER ${file}\n`)
    }

    const confinedOptions = { confined: true }
    const readFile = toolNamed(cwd, 'read_file', confinedOptions)
    const listed = String(await toolNamed(cwd, 'list_files', confinedOptions).execute({}))
    const pathMatches = String(await toolNamed(cwd, 'search_files', confinedOptions).execute({ query: '.' }))
    const credentialContentMatches = String(await toolNamed(cwd, 'search_in_files', confinedOptions).execute({ query: 'CREDENTIAL_CONTAINER_MARKER' }))
    const safeContentMatches = String(await toolNamed(cwd, 'search_in_files', confinedOptions).execute({ query: 'SAFE_CONFIG_MARKER' }))

    for (const file of credentialFiles) {
      await expect(readFile.execute({ path: file })).rejects.toThrow(/likely secret/i)
      expect(listed.split('\n')).not.toContain(file)
      expect(pathMatches.split('\n')).not.toContain(file)
      expect(credentialContentMatches).not.toContain(file)
    }

    for (const file of safeFiles) {
      await expect(readFile.execute({ path: file })).resolves.toContain(`SAFE_CONFIG_MARKER ${file}`)
      expect(listed.split('\n')).toContain(file)
      expect(pathMatches.split('\n')).toContain(file)
      expect(safeContentMatches).toContain(file)
    }
  })

  it('continues blocking environment, credential-config, PEM, key, and SSH private-key artifacts', async () => {
    const { cwd } = await createProject()
    const secretFiles = [
      '.env',
      '.env.local',
      '.envrc',
      'credentials.json',
      'credentials.yaml',
      'server.pem',
      'server.key',
      'id_rsa',
    ]

    for (const file of secretFiles) {
      await writeFile(join(cwd, file), `PRIVATE_MARKER ${file}\n`)
    }

    const confinedOptions = { confined: true }
    const readFile = toolNamed(cwd, 'read_file', confinedOptions)
    const listed = String(await toolNamed(cwd, 'list_files', confinedOptions).execute({}))
    const contentMatches = String(await toolNamed(cwd, 'search_in_files', confinedOptions).execute({ query: 'PRIVATE_MARKER' }))

    for (const file of secretFiles) {
      await expect(readFile.execute({ path: file })).rejects.toThrow(/likely secret/i)
      expect(listed).not.toContain(file)
      expect(contentMatches).not.toContain(file)
    }
  })

  it('honors configured ignores for direct reads in repository-confined mode', async () => {
    const { cwd } = await createProject()

    const readFile = toolNamed(cwd, 'read_file', {
      confined: true,
      ignore: ['**/src/beta/**'],
    })

    await expect(readFile.execute({ path: 'src/beta/keep.txt' })).rejects.toThrow(/ignored by repository policy/i)
  })

  it('rejects oversized direct reads without returning file contents', async () => {
    const { cwd } = await createProject()
    const marker = 'OVERSIZED_PRIVATE_CONTENT'
    await writeFile(join(cwd, 'large.txt'), `${marker}${'x'.repeat(250_000)}`)

    const readFile = toolNamed(cwd, 'read_file', { confined: true })
    let error: unknown

    try {
      await readFile.execute({ path: 'large.txt' })
    }
    catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/maximum readable size/i)
    expect((error as Error).message).not.toContain(marker)
  })

  it('reads and searches a UTF-8 file exactly at the repository byte cap', async () => {
    const { cwd } = await createProject()
    const marker = 'EXACT_CAP_MARKER'
    const content = `${'x'.repeat(MAX_REPOSITORY_FILE_BYTES - Buffer.byteLength(marker) - 2)}\n${marker}\n`
    await writeFile(join(cwd, 'exact-cap.txt'), content)

    expect(Buffer.byteLength(content, 'utf8')).toBe(MAX_REPOSITORY_FILE_BYTES)
    await expect(toolNamed(cwd, 'read_file', { confined: true }).execute({ path: 'exact-cap.txt' })).resolves.toBe(content)
    await expect(toolNamed(cwd, 'search_in_files', { confined: true }).execute({ query: marker })).resolves.toContain('exact-cap.txt:2: EXACT_CAP_MARKER')
  })

  it('rejects and skips a UTF-8 file one byte over the repository cap', async () => {
    const { cwd } = await createProject()
    const marker = 'OVER_CAP_MARKER'
    const content = `${'x'.repeat(MAX_REPOSITORY_FILE_BYTES - Buffer.byteLength(marker) - 1)}\n${marker}\n`
    await writeFile(join(cwd, 'over-cap.txt'), content)

    expect(Buffer.byteLength(content, 'utf8')).toBe(MAX_REPOSITORY_FILE_BYTES + 1)
    await expect(toolNamed(cwd, 'read_file', { confined: true }).execute({ path: 'over-cap.txt' })).rejects.toThrow(/maximum readable size/i)
    await expect(toolNamed(cwd, 'search_in_files', { confined: true }).execute({ query: marker })).resolves.toBe('')
  })

  it('skips multibyte files over the repository byte cap during confined content search', async () => {
    const { cwd } = await createProject()
    const marker = 'MULTIBYTE_OVERSIZED_PRIVATE_CONTENT'
    const content = `${'界'.repeat(70_000)}\n${marker}\n`

    expect(content.length).toBeLessThan(200_000)
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(200_000)

    await writeFile(join(cwd, 'multibyte-large.txt'), content)

    const contentMatches = String(await toolNamed(cwd, 'search_in_files', { confined: true }).execute({ query: marker }))

    expect(contentMatches).toBe('')
    expect(contentMatches).not.toContain(marker)
  })

  it('searches file paths and file contents by substring', async () => {
    const { cwd } = await createProject()

    const pathMatches = String(await toolNamed(cwd, 'search_files').execute({ query: 'alpha/keep' }))
    const contentMatches = String(await toolNamed(cwd, 'search_in_files').execute({ query: 'NEEDLE' }))

    expect(pathMatches).toContain('src/alpha/keep.txt')
    expect(pathMatches).not.toContain('src/beta/keep.txt')
    expect(contentMatches).toContain('src/alpha/keep.txt:1: alpha NEEDLE line')
    // vendor is ignored, so its NEEDLE never surfaces.
    expect(contentMatches).not.toContain('vendor/generated/ignored.txt')
  })

  it('scopes search to the requested directory', async () => {
    const { cwd } = await createProject()

    const contentMatches = String(await toolNamed(cwd, 'search_in_files').execute({ directory: 'src/alpha', query: 'NEEDLE' }))

    expect(contentMatches).toContain('src/alpha/keep.txt')
    // The same NEEDLE in src/beta is outside the requested directory.
    expect(contentMatches).not.toContain('src/beta/keep.txt')
  })

  it('scopes list_files to the requested directory', async () => {
    const { cwd } = await createProject()

    const listed = String(await toolNamed(cwd, 'list_files').execute({ directory: 'src/beta', patterns: '**/*.txt' }))

    expect(listed).toContain('src/beta/keep.txt')
    expect(listed).not.toContain('src/alpha/keep.txt')
  })

  it('searches all files before truncating matches and marks truncated listings', async () => {
    const { cwd } = await createProject()
    const manyDirectory = join(cwd, 'many')
    await mkdir(manyDirectory)

    for (let index = 0; index < 170; index += 1) {
      const suffix = index === 169 ? '-late-search-target' : ''
      const content = index === 169 ? 'late content target\n' : 'ordinary content\n'
      await writeFile(join(manyDirectory, `${String(index).padStart(3, '0')}${suffix}.txt`), content)
    }

    const pathMatches = String(await toolNamed(cwd, 'search_files').execute({ directory: 'many', query: 'late-search-target' }))
    const contentMatches = String(await toolNamed(cwd, 'search_in_files').execute({ directory: 'many', query: 'late content target' }))
    const listed = String(await toolNamed(cwd, 'list_files').execute({ directory: 'many' }))

    expect(pathMatches).toContain('many/169-late-search-target.txt')
    expect(contentMatches).toContain('many/169-late-search-target.txt:1: late content target')
    expect(listed).toMatch(/truncated/i)
  })

  it('counts every content match before bounding truncated search output', async () => {
    const { cwd } = await createProject()
    const matchesDirectory = join(cwd, 'content-matches')
    await mkdir(matchesDirectory)

    for (let index = 0; index < 30; index += 1) {
      await writeFile(join(matchesDirectory, `${String(index).padStart(2, '0')}.txt`), `COUNTED_NEEDLE ${index}\n`)
    }

    const contentMatches = String(await toolNamed(cwd, 'search_in_files').execute({
      directory: 'content-matches',
      query: 'COUNTED_NEEDLE',
    }))
    const outputLines = contentMatches.split('\n')

    expect(outputLines).toHaveLength(25)
    expect(outputLines.at(-1)).toBe('[truncated: showing the first 24 of 30 matches]')
    expect(contentMatches).toContain('content-matches/23.txt:1: COUNTED_NEEDLE 23')
    expect(contentMatches).not.toContain('content-matches/24.txt:1: COUNTED_NEEDLE 24')
    expect(contentMatches).not.toContain('content-matches/29.txt:1: COUNTED_NEEDLE 29')
  })

  it('counts every matching line in one file while returning only the first 24 snippets', async () => {
    const { cwd } = await createProject()
    const lines = Array.from({ length: 40 }, (_, index) => `LINE_FLOOD_NEEDLE ${index}`)
    await writeFile(join(cwd, 'line-flood.txt'), `${lines.join('\n')}\n`)

    const contentMatches = String(await toolNamed(cwd, 'search_in_files').execute({ query: 'LINE_FLOOD_NEEDLE' }))
    const outputLines = contentMatches.split('\n')

    expect(outputLines).toHaveLength(25)
    expect(outputLines.at(-1)).toBe('[truncated: showing the first 24 of 40 matches]')
    expect(contentMatches).toContain('line-flood.txt:24: LINE_FLOOD_NEEDLE 23')
    expect(contentMatches).not.toContain('line-flood.txt:25: LINE_FLOOD_NEEDLE 24')
  })

  it('counts every matching path while returning only the first 24 paths', async () => {
    const { cwd } = await createProject()
    const matchesDirectory = join(cwd, 'path-matches')
    await mkdir(matchesDirectory)

    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(matchesDirectory, `${String(index).padStart(2, '0')}-PATH_FLOOD_NEEDLE.txt`), 'content\n')
    }

    const pathMatches = String(await toolNamed(cwd, 'search_files').execute({
      directory: 'path-matches',
      query: 'PATH_FLOOD_NEEDLE',
    }))
    const outputLines = pathMatches.split('\n')

    expect(outputLines).toHaveLength(25)
    expect(outputLines.at(-1)).toBe('[truncated: showing the first 24 of 40 matches]')
    expect(pathMatches).toContain('path-matches/23-PATH_FLOOD_NEEDLE.txt')
    expect(pathMatches).not.toContain('path-matches/24-PATH_FLOOD_NEEDLE.txt')
  })
})
