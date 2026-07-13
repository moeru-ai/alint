import type {
  BuiltInAgentName,
  DeclarativeRuleDefinition,
} from './types'

import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { errorMessageFrom } from '@moeru/std/error'
import { loadConfig } from 'c12'

import { isBuiltInAgentName } from './types'

export interface LoadDeclarativeRulesOptions {
  alias: string
  root: string
}

const declarativeRuleFileNamePattern = /^rule\.alint\.(?:toml|ya?ml|json|jsonc|json5)$/
const declarativeRuleNamePattern = /^[\w.-]+$/

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

  const name = readRuleName(input.name, filePath)
  const builtInAgent = readBuiltInAgent(input.builtInAgent, filePath)
  const instruction = readNonEmptyString(input.instruction, 'instruction', filePath)
  const includeFiles = readOptionalStringArray(input.includeFiles, 'includeFiles', filePath)
  const excludeFiles = readOptionalStringArray(input.excludeFiles, 'excludeFiles', filePath) ?? []

  return {
    builtInAgent,
    excludeFiles,
    filePath,
    includeFiles,
    instruction,
    name,
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

function readBuiltInAgent(value: unknown, filePath: string): BuiltInAgentName {
  const builtInAgent = readNonEmptyString(value, 'builtInAgent', filePath)

  if (!isBuiltInAgentName(builtInAgent)) {
    throw new Error(`Unknown builtInAgent "${builtInAgent}" in ${filePath}.`)
  }

  return builtInAgent
}

function readNonEmptyString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Declarative rule "${field}" in ${filePath} must be a non-empty string.`)
  }

  return value
}

function readOptionalStringArray(
  value: unknown,
  field: string,
  filePath: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Declarative rule "${field}" in ${filePath} must be an array of strings.`)
  }

  return value
}

function readRuleName(value: unknown, filePath: string): string {
  const name = readNonEmptyString(value, 'name', filePath)

  if (!declarativeRuleNamePattern.test(name)) {
    throw new Error(`Declarative rule "name" in ${filePath} must contain only letters, numbers, dots, underscores, and hyphens.`)
  }

  return name
}
