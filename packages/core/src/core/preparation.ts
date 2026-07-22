import type { AgentAdapter } from '../agent/types'
import type { EffectiveAlintConfig } from '../config/config-array'
import type { AlintConfig, DirectoryTarget, EnabledRule, LanguageDefinition } from '../dsl/types'
import type { RunOptions } from './types'

import { cwd as processCwd } from 'node:process'

import { resolve } from 'pathe'

import { resolveConfigForDirectory, resolveConfigForFile, resolveConfigForProject } from '../config/config-array'
import { buildRuleRegistry } from '../dsl/registry'
import { stableHash } from './hash'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguageForPath } from './languages'

export interface PreparationIndex {
  directories: readonly PreparedDirectoryInput[]
  files: readonly PreparedInput[]
  project?: PreparedProjectInput
}

export interface PreparedDirectoryInput {
  agent?: AgentAdapter
  configHash: string
  directoryIndex: number
  rules: readonly PreparedRule[]
  settings: Record<string, unknown>
  target: DirectoryTarget
}

export interface PreparedInput {
  agent?: AgentAdapter
  configHash: string
  fileIndex: number
  language: LanguageDefinition
  languageOptions: Record<string, unknown>
  path: string
  rules: readonly PreparedRule[]
  settings: Record<string, unknown>
}

export interface PreparedProjectInput {
  agent?: AgentAdapter
  configHash: string
  root: string
  rules: readonly PreparedRule[]
  settings: Record<string, unknown>
}

export interface PreparedRule {
  enabledRule: EnabledRule
  // Zero-based enabled-registry position, distinct from a job's per-rule occurrence index.
  ruleIndex: number
}

export function prepareRun(options: RunOptions = {}): PreparationIndex {
  const cwd = options.cwd ?? processCwd()
  const config = options.config ?? []
  const files: PreparedInput[] = []
  const directories: PreparedDirectoryInput[] = []

  for (const filePath of options.files ?? []) {
    const path = resolve(cwd, filePath)
    const resolvedConfig = resolveConfigForFile(path, config, { cwd })
    if (resolvedConfig.ignored)
      continue

    const effectiveConfig = resolvedConfig.config
    const languageRegistry = createLanguageRegistry(effectiveConfig)
    const language = resolveLanguageForPath(path, languageRegistry, { language: effectiveConfig.language })

    files.push({
      agent: effectiveConfig.agent,
      configHash: stableHash({
        language: effectiveConfig.language,
        languageOptions: effectiveConfig.languageOptions,
        processor: effectiveConfig.processor,
        resolvedLanguage: language.name,
        settings: effectiveConfig.settings,
      }),
      fileIndex: files.length,
      language,
      languageOptions: effectiveConfig.languageOptions,
      path,
      rules: prepareRules(effectiveConfig),
      settings: effectiveConfig.settings,
    })
  }

  for (const directoryPath of options.directories ?? []) {
    const path = resolve(cwd, directoryPath)
    const resolvedConfig = resolveConfigForDirectory(path, config, { cwd })
    if (resolvedConfig.ignored)
      continue

    const effectiveConfig = resolvedConfig.config
    directories.push({
      agent: effectiveConfig.agent,
      configHash: stableHash({ settings: effectiveConfig.settings }),
      directoryIndex: directories.length,
      rules: prepareRules(effectiveConfig),
      settings: effectiveConfig.settings,
      target: { kind: 'directory', path },
    })
  }

  return {
    directories,
    files,
    project: options.projectTargets === false ? undefined : prepareProject(cwd, config),
  }
}

function createLanguageRegistry(config: EffectiveAlintConfig) {
  const registry = createBuiltInLanguageRegistry()

  for (const plugin of Object.values(config.plugins)) {
    for (const language of Object.values(plugin.languages ?? {}))
      registerLanguage(registry, language)
  }

  return registry
}

function prepareProject(root: string, config: AlintConfig): PreparedProjectInput | undefined {
  const resolvedConfig = resolveConfigForProject(root, config, { cwd: root })
  if (resolvedConfig.ignored)
    return undefined

  const effectiveConfig = resolvedConfig.config
  return {
    agent: effectiveConfig.agent,
    configHash: stableHash({ settings: effectiveConfig.settings }),
    root,
    rules: prepareRules(effectiveConfig),
    settings: effectiveConfig.settings,
  }
}

function prepareRules(config: EffectiveAlintConfig): PreparedRule[] {
  return buildRuleRegistry(config).enabledRules.map((enabledRule, ruleIndex) => ({
    enabledRule,
    ruleIndex,
  }))
}
