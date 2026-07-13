import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hasDeclarativeRuleFiles, loadDeclarativeRules } from './parse'
import {
  builtInAgentNames,
  declarativeRuleFilePattern,
  isBuiltInAgentName,
} from './types'

async function createRuleRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alint-declarative-rules-'))
}

describe('declarative rule types', () => {
  it('defines the supported rule file pattern and built-in agents', () => {
    expect(declarativeRuleFilePattern).toBe('**/rule.alint.{toml,yaml,yml,json,jsonc,json5}')
    expect(builtInAgentNames).toEqual(['basic-structured', 'basic-coding-agent'])
    expect(isBuiltInAgentName('basic-structured')).toBe(true)
    expect(isBuiltInAgentName('basic-coding-agent')).toBe(true)
    expect(isBuiltInAgentName('custom-agent')).toBe(false)
  })
})

describe('hasDeclarativeRuleFiles', () => {
  it('detects nested rule.alint files with supported extensions', async () => {
    const root = await createRuleRoot()
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'rule.alint.yml'), 'name: nested\n')

    await expect(hasDeclarativeRuleFiles(root)).resolves.toBe(true)
  })

  it('ignores unsupported and partial rule file names', async () => {
    const root = await createRuleRoot()
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'other.rule.alint.yml'), 'name: ignored\n')
    await writeFile(join(root, 'nested', 'rule.alint.yml.bak'), 'name: ignored\n')

    await expect(hasDeclarativeRuleFiles(root)).resolves.toBe(false)
  })
})

describe('loadDeclarativeRules', () => {
  it('loads nested TOML, YAML, JSON, JSONC, and JSON5 rule files', async () => {
    const root = await createRuleRoot()
    await mkdir(join(root, 'toml'), { recursive: true })
    await mkdir(join(root, 'yaml'), { recursive: true })
    await mkdir(join(root, 'json'), { recursive: true })
    await mkdir(join(root, 'jsonc'), { recursive: true })
    await mkdir(join(root, 'json5'), { recursive: true })

    await writeFile(join(root, 'toml', 'rule.alint.toml'), 'name = "toml-rule"\nbuiltInAgent = "basic-structured"\ninstruction = "review toml"\n')
    await writeFile(join(root, 'yaml', 'rule.alint.yaml'), 'name: yaml-rule\nbuiltInAgent: basic-structured\ninstruction: review yaml\n')
    await writeFile(join(root, 'json', 'rule.alint.json'), JSON.stringify({ builtInAgent: 'basic-structured', instruction: 'review json', name: 'json-rule' }))
    await writeFile(join(root, 'jsonc', 'rule.alint.jsonc'), '{\n  // comment\n  "name": "jsonc-rule",\n  "builtInAgent": "basic-structured",\n  "instruction": "review jsonc"\n}\n')
    await writeFile(join(root, 'json5', 'rule.alint.json5'), '{ name: \'json5-rule\', builtInAgent: \'basic-structured\', instruction: \'review json5\' }\n')

    const rules = await loadDeclarativeRules({ alias: 'local', root })

    expect(rules.map(rule => rule.name).sort()).toEqual([
      'json-rule',
      'json5-rule',
      'jsonc-rule',
      'toml-rule',
      'yaml-rule',
    ])
  })

  it('normalizes includeFiles and excludeFiles to arrays', async () => {
    const root = await createRuleRoot()
    await mkdir(join(root, 'rule'), { recursive: true })
    await writeFile(join(root, 'rule', 'rule.alint.toml'), [
      'name = "scoped"',
      'builtInAgent = "basic-structured"',
      'instruction = "review scoped files"',
      'includeFiles = ["src/**/*.py"]',
      'excludeFiles = ["**/*_test.py"]',
    ].join('\n'))

    const rules = await loadDeclarativeRules({ alias: 'local', root })

    expect(rules[0]).toMatchObject({
      builtInAgent: 'basic-structured',
      excludeFiles: ['**/*_test.py'],
      includeFiles: ['src/**/*.py'],
      instruction: 'review scoped files',
      name: 'scoped',
    })
  })

  it('defaults excludeFiles to an empty array', async () => {
    const root = await createRuleRoot()
    await mkdir(join(root, 'rule'), { recursive: true })
    await writeFile(join(root, 'rule', 'rule.alint.toml'), 'name = "default-excludes"\nbuiltInAgent = "basic-structured"\ninstruction = "review"\n')

    const rules = await loadDeclarativeRules({ alias: 'local', root })

    expect(rules[0]?.excludeFiles).toEqual([])
  })

  it('rejects invalid names, unknown built-in agents, and duplicate names', async () => {
    const invalidRoot = await createRuleRoot()
    await mkdir(join(invalidRoot, 'rule'), { recursive: true })
    await writeFile(join(invalidRoot, 'rule', 'rule.alint.toml'), 'name = "bad/name"\nbuiltInAgent = "basic-structured"\ninstruction = "review"\n')

    await expect(loadDeclarativeRules({ alias: 'local', root: invalidRoot }))
      .rejects
      .toThrow('Declarative rule "name" must contain only letters, numbers, dots, underscores, and hyphens.')

    const unknownRoot = await createRuleRoot()
    await mkdir(join(unknownRoot, 'rule'), { recursive: true })
    await writeFile(join(unknownRoot, 'rule', 'rule.alint.toml'), 'name = "valid"\nbuiltInAgent = "other"\ninstruction = "review"\n')

    await expect(loadDeclarativeRules({ alias: 'local', root: unknownRoot }))
      .rejects
      .toThrow('Unknown builtInAgent "other"')

    const duplicateRoot = await createRuleRoot()
    await mkdir(join(duplicateRoot, 'a'), { recursive: true })
    await mkdir(join(duplicateRoot, 'b'), { recursive: true })
    const firstPath = join(duplicateRoot, 'a', 'rule.alint.toml')
    const secondPath = join(duplicateRoot, 'b', 'rule.alint.toml')
    await writeFile(firstPath, 'name = "same"\nbuiltInAgent = "basic-structured"\ninstruction = "review a"\n')
    await writeFile(secondPath, 'name = "same"\nbuiltInAgent = "basic-structured"\ninstruction = "review b"\n')

    await expect(loadDeclarativeRules({ alias: 'local', root: duplicateRoot }))
      .rejects
      .toThrow(`Duplicate declarative rule name "same" in ${secondPath} and ${firstPath}`)
  })

  it('throws a directory plugin error when no rule files are found', async () => {
    const root = await createRuleRoot()

    await expect(loadDeclarativeRules({ alias: 'local', root }))
      .rejects
      .toThrow('Directory plugin "local" must contain package.json or rule.alint.* files.')
  })
})
