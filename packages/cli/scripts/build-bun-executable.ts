import process from 'node:process'

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

interface BindingPackageJson {
  main?: unknown
}

interface BuildEntryOptions {
  bindingSpecifier: string
  cliSpecifier: string
}

const args = parseArgs(process.argv.slice(2))
const target = requiredArg(args, 'target')
const bunTarget = requiredArg(args, 'bun-target')
const oxcBinding = requiredArg(args, 'oxc-binding')
const outfile = requiredArg(args, 'outfile')
const root = fileURLToPath(new URL('../../..', import.meta.url))
const bindingRoot = await findBindingRoot(root, oxcBinding)
const bindingPackageJson = JSON.parse(await readFile(join(bindingRoot, 'package.json'), 'utf8')) as BindingPackageJson
const bindingMain = bindingPackageJson.main

if (typeof bindingMain !== 'string' || !bindingMain.endsWith('.node')) {
  throw new TypeError(`Invalid @oxc-parser/binding-${oxcBinding} package main.`)
}

const tempRoot = join(root, '.tmp')
await mkdir(tempRoot, { recursive: true })
const tempDir = await mkdtemp(join(tempRoot, `alint-bun-${target}-`))
const entryPath = join(tempDir, 'entry.ts')
const bindingPath = join(bindingRoot, bindingMain)
const cliEntryPath = join(root, 'packages/cli/src/cli/index.ts')

try {
  await writeFile(entryPath, createEntry({
    bindingSpecifier: toImportSpecifier(relative(tempDir, bindingPath)),
    cliSpecifier: toImportSpecifier(relative(tempDir, cliEntryPath)),
  }))

  await mkdir(dirname(outfile), { recursive: true })

  const result = spawnSync('bun', [
    'build',
    '--compile',
    `--target=${bunTarget}`,
    entryPath,
    '--outfile',
    outfile,
  ], {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
finally {
  await rm(tempDir, { force: true, recursive: true })
}

function createEntry({ bindingSpecifier, cliSpecifier }: BuildEntryOptions): string {
  return `${[
    'import process from "node:process"',
    '',
    `import bindingPath from "${bindingSpecifier}" with { type: "file" }`,
    '',
    'process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bindingPath',
    '',
    `const { executeCli } = await import("${cliSpecifier}")`,
    '',
    'void executeCli(process.argv, {',
    '  cwd: process.cwd(),',
    '  stderr: process.stderr,',
    '  stdout: process.stdout,',
    '}).then((exitCode) => {',
    '  process.exitCode = exitCode',
    '}).catch((error) => {',
    '  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n")',
    '  process.exitCode = 2',
    '})',
  ].join('\n')}\n`
}

async function findBindingRoot(root: string, binding: string): Promise<string> {
  const packageName = `@oxc-parser/binding-${binding}`
  const pnpmDir = join(root, 'node_modules/.pnpm')
  const entries = await readdir(pnpmDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`@oxc-parser+binding-${binding}@`)) {
      continue
    }

    return join(pnpmDir, entry.name, 'node_modules', packageName)
  }

  throw new Error(`Could not find ${packageName}. Install it before building the Bun executable.`)
}

function parseArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>()

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]

    if (!value.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${value}`)
    }

    const [key, inlineValue] = value.slice(2).split('=', 2)
    const nextValue = inlineValue ?? values[index + 1]

    if (!nextValue || nextValue.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    parsed.set(key, nextValue)

    if (inlineValue === undefined) {
      index += 1
    }
  }

  return parsed
}

function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name)

  if (!value) {
    throw new Error(`Missing required argument --${name}`)
  }

  return value
}

function toImportSpecifier(path: string): string {
  const normalized = path.split(sep).join('/')

  return normalized.startsWith('.') ? normalized : `./${normalized}`
}
