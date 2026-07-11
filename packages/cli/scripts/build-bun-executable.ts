import process from 'node:process'

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findWorkspaceDir } from '@pnpm/find-workspace-dir'
import { findDynamicImports, findStaticImports, parseStaticImport } from 'mlly'

export interface BuildBunExecutableOptions {
  bunTarget: string
  outfile: string
  oxcBinding: string
  target: string
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url)

if (isCli) {
  await runCli(process.argv.slice(2))
}

export async function buildBunExecutable(options: BuildBunExecutableOptions): Promise<void> {
  const root = await resolveWorkspaceRoot()
  const bindingPath = resolveBindingPath(root, options.oxcBinding)

  const tempRoot = join(root, '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const tempDir = await mkdtemp(join(tempRoot, `alint-bun-${options.target}-`))
  const entryPath = join(tempDir, 'entry.ts')
  const cliEntryPath = join(root, 'packages/cli/src/cli/index.ts')
  const templatePath = fileURLToPath(new URL('./bun-entry.template.ts', import.meta.url))

  try {
    // NOTICE: `oxc-parser` loads its NAPI-RS binding while alint core is
    // imported. Bun only embeds `.node` files into standalone executables when
    // the binding file is a direct static import, so the generated bootstrap
    // must import the platform binding file before importing the CLI entry.
    await writeFile(entryPath, rewriteBootstrapImports(await readFile(templatePath, 'utf8'), {
      __ALINT_CLI_ENTRY__: toImportSpecifier(relative(tempDir, cliEntryPath)),
      __ALINT_OXC_BINDING__: toImportSpecifier(relative(tempDir, bindingPath)),
    }))

    await mkdir(dirname(options.outfile), { recursive: true })

    const result = spawnSync('bun', [
      'build',
      '--compile',
      `--target=${options.bunTarget}`,
      entryPath,
      '--outfile',
      options.outfile,
    ], {
      stdio: 'inherit',
    })

    if (result.status !== 0) {
      throw new Error(`Bun executable build failed with exit code ${result.status ?? 1}.`)
    }
  }
  finally {
    await rm(tempDir, { force: true, recursive: true })
  }
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

function parseDynamicImportSpecifier(expression: string): string | undefined {
  const quote = expression[0]

  if ((quote !== '\'' && quote !== '"' && quote !== '`') || expression.at(-1) !== quote) {
    return undefined
  }

  return expression.slice(1, -1)
}

function replaceImportSpecifier(code: string, specifier: string, replacement: string): string {
  for (const quote of ['\'', '"', '`']) {
    const quoted = `${quote}${specifier}${quote}`

    if (code.includes(quoted)) {
      return code.replace(quoted, `${quote}${replacement}${quote}`)
    }
  }

  throw new Error(`Could not replace import specifier ${specifier}.`)
}

function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name)

  if (!value) {
    throw new Error(`Missing required argument --${name}`)
  }

  return value
}

function resolveBindingPath(root: string, binding: string): string {
  const requireFromCore = createRequire(join(root, 'packages/core/package.json'))
  const oxcPackageJson = requireFromCore.resolve('oxc-parser/package.json')
  const requireFromOxc = createRequire(oxcPackageJson)
  const bindingPath = requireFromOxc.resolve(`@oxc-parser/binding-${binding}`)

  if (!bindingPath.endsWith('.node')) {
    throw new TypeError(`Invalid @oxc-parser/binding-${binding} package entry.`)
  }

  return bindingPath
}

async function resolveWorkspaceRoot(): Promise<string> {
  const workspaceRoot = await findWorkspaceDir(fileURLToPath(new URL('../../..', import.meta.url)))

  if (!workspaceRoot) {
    throw new Error('Could not find pnpm workspace root.')
  }

  return workspaceRoot
}

function rewriteBootstrapImports(code: string, replacements: Record<string, string>): string {
  let rewritten = code
  const pending = new Set(Object.keys(replacements))
  const imports = [
    ...findStaticImports(code).map(matched => ({
      code: matched.code,
      end: matched.end,
      specifier: parseStaticImport(matched).specifier,
      start: matched.start,
    })),
    ...findDynamicImports(code).map(matched => ({
      code: matched.code,
      end: matched.end,
      specifier: parseDynamicImportSpecifier(matched.expression),
      start: matched.start,
    })),
  ].sort((left, right) => right.start - left.start)

  for (const matched of imports) {
    if (!matched.specifier) {
      continue
    }

    const replacement = replacements[matched.specifier]
    if (!replacement) {
      continue
    }

    rewritten = `${rewritten.slice(0, matched.start)}${replaceImportSpecifier(matched.code, matched.specifier, replacement)}${rewritten.slice(matched.end)}`
    pending.delete(matched.specifier)
  }

  if (pending.size > 0) {
    throw new Error(`Could not find bootstrap import placeholder: ${[...pending].join(', ')}`)
  }

  return rewritten
}

async function runCli(values: string[]): Promise<void> {
  const args = parseArgs(values)

  await buildBunExecutable({
    bunTarget: requiredArg(args, 'bun-target'),
    outfile: requiredArg(args, 'outfile'),
    oxcBinding: requiredArg(args, 'oxc-binding'),
    target: requiredArg(args, 'target'),
  })
}

function toImportSpecifier(path: string): string {
  const normalized = path.split(sep).join('/')

  return normalized.startsWith('.') ? normalized : `./${normalized}`
}
