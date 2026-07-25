import type { AgentAdapter } from '../agent/types'
import type { EffectiveAlintConfig } from '../config/config-array'
import type { AlintConfig, DirectoryTarget, EnabledRule, LanguageDefinition } from '../dsl/types'
import type { LanguageRegistry } from './languages'
import type { MissingLanguage, UnregisteredLanguage } from './languages/diagnostics'
import type { SourceRuntime } from './source/types'
import type { RunOptions } from './types'

import { cwd as processCwd } from 'node:process'

import { resolve } from 'pathe'

import { resolveConfigForDirectory, resolveConfigForFile, resolveConfigForProject } from '../config/config-array'
import { buildRuleRegistry } from '../dsl/registry'
import { stableHash } from './hash'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguageForPath } from './languages'
import { recordMissingLanguage, recordUnregistered, unregisteredLanguageSeverity } from './languages/diagnostics'
import { isTargetLanguageAccepted, resolveRuleLanguages } from './languages/rule-languages'

export interface PreparationIndex {
  directories: readonly PreparedDirectoryInput[]
  files: readonly PreparedInput[]
  /**
   * Languages that enabled rules named and no plugin registered, grouped by language id. `run` turns
   * these into error-severity `alint/missing-language` diagnostics.
   */
  missingLanguages: ReadonlyMap<string, MissingLanguage>
  project?: PreparedProjectInput
  /**
   * Linted files no language claimed, so they were handled as plain text. Reports are grouped by
   * extension so one missing language pack is one diagnostic, not one per file. `run` turns these into
   * `alint/unregistered-language` diagnostics. Empty when nothing mismatched.
   */
  unregisteredLanguages: ReadonlyMap<string, UnregisteredLanguage>
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

/**
 * The `ctx.src.extract` a run hands to rules, for parsing files it was never asked to lint, which
 * an index builder sweeping the workspace needs.
 *
 * It resolves each file's OWN config rather than a caller's, because the language a file resolves to
 * is a config decision and two config groups may register different plugins. It extracts on demand
 * and holds nothing: the windowed lint pipeline (`executeSourceSessions`) releases sources to bound
 * memory, and a run-wide parse memo here would put that back. A caller keeps only what it derives.
 *
 * `getSrc` defers reading the runtime because the runtime is built around this closure. It is assigned
 * before any rule runs, so by the first call it is present.
 */
export function createSourceExtractor(
  cwd: string,
  config: AlintConfig,
  getSrc: () => SourceRuntime,
): SourceRuntime['extract'] {
  return async (filePath, options = {}) => {
    const path = resolve(cwd, filePath)
    const resolvedConfig = resolveConfigForFile(path, config, { cwd })

    // An ignored file is not a missing language: the config excluded it, so a caller sweeping the
    // tree should skip it, not fail. Returning nothing lets every caller do that without guarding.
    if (resolvedConfig.ignored)
      return []

    const effectiveConfig = resolvedConfig.config
    const language = resolveLanguageForPath(path, createLanguageRegistry(effectiveConfig), {
      language: options.language ?? effectiveConfig.language,
    })
    const src = getSrc()
    const file = await src.readFile(path)

    return language.extract(file, { cwd, languageOptions: effectiveConfig.languageOptions, src })
  }
}

export function prepareRun(options: RunOptions = {}): PreparationIndex {
  const cwd = options.cwd ?? processCwd()
  const config = options.config ?? []
  const files: PreparedInput[] = []
  const directories: PreparedDirectoryInput[] = []
  const missingLanguages = new Map<string, MissingLanguage>()
  const unregisteredLanguages = new Map<string, UnregisteredLanguage>()

  for (const filePath of options.files ?? []) {
    const path = resolve(cwd, filePath)
    const resolvedConfig = resolveConfigForFile(path, config, { cwd })
    if (resolvedConfig.ignored)
      continue

    const effectiveConfig = resolvedConfig.config
    const languageRegistry = createLanguageRegistry(effectiveConfig)
    const language = resolveLanguageForPath(path, languageRegistry, { language: effectiveConfig.language })
    const rules = prepareRules(effectiveConfig)

    recordMissingLanguages(missingLanguages, rules, languageRegistry, path)

    // The mismatch only the run can see: rules that need a real language were configured for this
    // file, yet nothing claimed its extension, so it fell back to plain text and those rules are
    // turned away. An explicit `language:` pin (including `plaintext`) is intent and stays silent.
    if (effectiveConfig.language === undefined && language.name === 'plaintext' && languageDegradedRules(rules)) {
      recordUnregistered(unregisteredLanguages, path, unregisteredLanguageSeverity(effectiveConfig.linterOptions))
    }

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
      rules,
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
    missingLanguages,
    project: options.projectTargets === false ? undefined : prepareProject(cwd, config),
    unregisteredLanguages,
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

/**
 * Whether any enabled rule is turned off because of the file being handled as plain text (fallback).
 */
function languageDegradedRules(rules: readonly PreparedRule[]): boolean {
  return rules.some(({ enabledRule }) => !isTargetLanguageAccepted(resolveRuleLanguages(enabledRule.rule.languages), 'file', 'plaintext'))
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

function recordMissingLanguages(
  into: Map<string, MissingLanguage>,
  rules: readonly PreparedRule[],
  registry: LanguageRegistry,
  path: string,
): void {
  for (const { enabledRule } of rules) {
    const languages = resolveRuleLanguages(enabledRule.rule.languages)

    if (languages.kind !== 'list' || languages.skipMissing)
      continue

    for (const languageId of languages.ids) {
      if (!registry.languages.has(languageId))
        recordMissingLanguage(into, languageId, enabledRule.id, path)
    }
  }
}
