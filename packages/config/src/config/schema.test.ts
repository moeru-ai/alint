import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function collectArrayItemsSchemas(value: unknown, schemas: unknown[] = []): unknown[] {
  if (!value || typeof value !== 'object') {
    return schemas
  }

  if ('items' in value) {
    schemas.push((value as { items?: unknown }).items)
  }

  for (const nestedValue of Object.values(value)) {
    collectArrayItemsSchemas(nestedValue, schemas)
  }

  return schemas
}

async function loadSchema(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(packageRoot, 'schemas', 'alint-config.schema.json'), 'utf8'))
}

describe('static config schema', () => {
  it('exists and describes config.group', async () => {
    const schema = await loadSchema()

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(JSON.stringify(schema)).toContain('config')
    expect(JSON.stringify(schema)).toContain('group')
    expect(JSON.stringify(schema)).toContain('plugins')
  })

  it('uses draft 2020-12 tuple keywords', async () => {
    const schema = await loadSchema()

    expect(collectArrayItemsSchemas(schema).some(Array.isArray)).toBe(false)
    expect(JSON.stringify(schema)).toContain('prefixItems')
  })

  it('describes static config fields supported by flat config items', async () => {
    const schema = await loadSchema()
    const configGroup = schema.$defs.configGroup

    expect(schema.$defs.flatConfig.items.$ref).toBe('#/$defs/configInput')
    expect(schema.$defs.configInput.oneOf[0].$ref).toBe('#/$defs/configGroup')
    expect(schema.$defs.configInput.oneOf[1].items.$ref).toBe('#/$defs/configInput')
    expect(configGroup.additionalProperties).toBe(false)
    expect(Object.keys(configGroup.properties).sort()).toEqual([
      'basePath',
      'extends',
      'files',
      'ignore',
      'ignores',
      'language',
      'languageOptions',
      'linterOptions',
      'name',
      'plugins',
      'processor',
      'rules',
      'runner',
      'settings',
    ])
    expect(configGroup.properties.files.items.oneOf).toHaveLength(2)
    expect(configGroup.properties.extends.items.oneOf).toHaveLength(2)
    expect(configGroup.properties.extends.items.oneOf[1].$ref).toBe('#/$defs/configInput')
    expect(configGroup.properties.processor.type).toBe('string')
  })

  it('matches parser-compatible exact plugin versions', async () => {
    const schema = await loadSchema()
    const pluginPattern = new RegExp(schema.$defs.configGroup.properties.plugins.additionalProperties.pattern, 'u')

    expect(pluginPattern.test('@alint-js/plugin-python@0.3.1')).toBe(true)
    expect(pluginPattern.test('plugin-python@1.2.3-alpha.1+build.5')).toBe(true)
    expect(pluginPattern.test('@alint-js/plugin-python@01.2.3')).toBe(false)
    expect(pluginPattern.test('@alint-js/plugin-python@1.2.3-alpha..1')).toBe(false)
    expect(pluginPattern.test('@alint-js/plugin-python@1.2.3+.build')).toBe(false)
    expect(pluginPattern.test('@alint-js/plugin-python@1.2.3-01')).toBe(false)
  })
})
