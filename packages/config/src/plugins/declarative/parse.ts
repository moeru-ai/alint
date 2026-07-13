import type {
  DeclarativeRuleDefinition,
} from './types'

import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { errorMessageFrom } from '@moeru/std/error'
import { loadConfig } from 'c12'
import { array, check, object, optional, parse, picklist, pipe, string } from 'valibot'

import { builtInAgentNames, isBuiltInAgentName } from './types'

export interface LoadDeclarativeRulesOptions {
  alias: string
  root: string
}

const declarativeRuleFileNamePattern = /^rule\.alint\.(?:toml|ya?ml|json|jsonc|json5)$/
const declarativeRuleNamePattern = /^[\w.-]+$/
const nonEmptyStringSchema = pipe(
  string(),
  check(value => value.trim() !== '', 'must be a non-empty string'),
)
const declarativeRuleFileSchema = object({
  builtInAgent: picklist(builtInAgentNames),
  excludeFiles: optional(array(string())),
  includeFiles: optional(array(string())),
  instruction: nonEmptyStringSchema,
  name: pipe(
    nonEmptyStringSchema,
    check(
      value => declarativeRuleNamePattern.test(value),
      'Declarative rule "name" must contain only letters, numbers, dots, underscores, and hyphens.',
    ),
  ),
})

export async function hasDeclarativeRuleFiles(root: string): Promise<boolean> {
  return (await findDeclarativeRuleFiles(root)).length > 0
}

export async function loadDeclarativeRules(
  options: LoadDeclarativeRulesOptions,
): Promise<DeclarativeRuleDefinition[]> {
  const files = await findDeclarativeRuleFiles(options.root)

  if (files.length === 0) {
    throw new Error(`Directory plugin "${options.alias}" must contain package.json or rule.alint.* files.`)
  }

  const rules: DeclarativeRuleDefinition[] = []
  const filesByName = new Map<string, string>()

  for (const file of files) {
    const rule = await loadDeclarativeRuleFile(file)
    const duplicateFile = filesByName.get(rule.name)

    if (duplicateFile !== undefined) {
      throw new Error(`Duplicate declarative rule name "${rule.name}" in ${file} and ${duplicateFile}.`)
    }

    filesByName.set(rule.name, file)
    rules.push(rule)
  }

  return rules
}

async function collectDeclarativeRuleFiles(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      await collectDeclarativeRuleFiles(path, files)
      return
    }

    if (entry.isFile() && declarativeRuleFileNamePattern.test(entry.name)) {
      files.push(path)
    }
  }))
}

async function findDeclarativeRuleFiles(root: string): Promise<string[]> {
  const files: string[] = []

  await collectDeclarativeRuleFiles(root, files)

  return files.sort((left, right) => left.localeCompare(right))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadDeclarativeRuleFile(filePath: string): Promise<DeclarativeRuleDefinition> {
  const input = await loadDeclarativeRuleFileContent(filePath)

  if (!isPlainObject(input)) {
    throw new Error(`Declarative rule file ${filePath} must contain an object.`)
  }

  const parsed = parseDeclarativeRuleFileInput(input, filePath)

  return {
    builtInAgent: parsed.builtInAgent,
    excludeFiles: parsed.excludeFiles ?? [],
    filePath,
    includeFiles: parsed.includeFiles,
    instruction: parsed.instruction,
    name: parsed.name,
  }
}

async function loadDeclarativeRuleFileContent(filePath: string): Promise<unknown> {
  try {
    const result = await loadConfig({
      configFile: basename(filePath),
      cwd: dirname(filePath),
      envName: false,
      extend: false,
      packageJson: false,
      rcFile: false,
    })

    return result.config
  }
  catch (error) {
    throw new Error(`Could not parse declarative rule file ${filePath}: ${errorMessageFrom(error) ?? 'Unknown error'}`, {
      cause: error,
    })
  }
}

function parseDeclarativeRuleFileInput(input: Record<string, unknown>, filePath: string) {
  try {
    return parse(declarativeRuleFileSchema, input)
  }
  catch (error) {
    if (typeof input.builtInAgent === 'string' && !isBuiltInAgentName(input.builtInAgent)) {
      throw new Error(`Unknown builtInAgent "${input.builtInAgent}" in ${filePath}.`, { cause: error })
    }

    throw new Error(`Invalid declarative rule file ${filePath}: ${errorMessageFrom(error) ?? 'Unknown error'}`, {
      cause: error,
    })
  }
}
