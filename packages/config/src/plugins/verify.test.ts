import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { verifyExtractedPluginPackage } from './verify'

describe('verifyExtractedPluginPackage', () => {
  it('accepts a self-contained package with relative chunks', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'export const rules = {}\n',
      'dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toEqual({
      apiVersion: '1',
      entry: await realpath(join(root, 'dist', 'index.mjs')),
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects package identity mismatches', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-ruby',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('expected @alint-js/plugin-python@0.3.1')
  })

  it('rejects unsupported api versions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '2', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('declares alint apiVersion "2"')
  })

  it('rejects runtime dependency declarations', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        dependencies: { valibot: '^1.0.0' },
        devDependencies: { tsdown: '^0.14.0' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('declares dependencies')
  })

  it('rejects malformed runtime dependency declarations', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        dependencies: ['valibot'],
        name: '@alint-js/plugin-python',
        optionalDependencies: 'valibot',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('declares dependencies')
  })

  it('rejects empty array runtime dependency declarations', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        dependencies: [],
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('declares dependencies')
  })

  it('rejects bundled dependency declarations', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        bundledDependencies: ['valibot'],
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('declares bundledDependencies')
  })

  it('rejects entries that escape the package root', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: '../index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry escapes package root')
  })

  it('rejects percent-encoded entries', async () => {
    const root = await createPackage({
      '%2e%2e/%2e%2e/outside.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './%2e%2e/%2e%2e/outside.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses URL percent encoding')
  })

  it('rejects escaped entries', async () => {
    const root = await createPackage({
      '\\x2e\\x2e/\\x2e\\x2e/outside.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './\\x2e\\x2e/\\x2e\\x2e/outside.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses string escape sequences')
  })

  it('rejects missing entries', async () => {
    const root = await createPackage({
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry does not exist')
  })

  it('rejects external package imports', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import "valibot"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects external package imports from reachable chunks', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'import "valibot"\nexport const rules = {}\n',
      'dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/chunk.mjs imports external package "valibot"')
  })

  it('rejects minified external from imports from reachable chunks', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'import{sys}from"typescript"\nexport const rules = { sys }\n',
      'dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/chunk.mjs imports external package "typescript"')
  })

  it('rejects multiline external from imports from reachable chunks', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'import {\n  definePlugin\n} from "@alint-js/core"\nexport const rules = { definePlugin }\n',
      'dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/chunk.mjs imports external package "@alint-js/core"')
  })

  it('rejects external from imports with comments before specifiers', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'import { marker } from\n/* comment */\n"valibot"\nexport const rules = { marker }\n',
      'dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/chunk.mjs imports external package "valibot"')
  })

  it('rejects external from imports with open braces inside comments', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { object /* { */ } from "valibot"\nexport default { rules: { object } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects external from imports with open braces inside string names', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { "{" as object } from "valibot"\nexport default { rules: { object } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects external from imports after strings containing line comment markers', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const marker = "//"\nimport { object } from "valibot"\nexport default { rules: { marker, object } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects external from imports after carriage-return line comments', async () => {
    const root = await createPackage({
      'dist/index.mjs': '// comment\rimport { object } from "valibot"\nexport default { rules: { object } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects external from imports after quoted line comments', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { object } // "comment"\nfrom "valibot"\nexport default { rules: { object } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects external from exports with open braces inside string names', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export { object as "{" } from "valibot"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects computed dynamic imports', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const name = "type" + "script"\nexport default { rules: { async load() { return import(name) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs uses computed dynamic import')
  })

  it('rejects computed require calls', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const name = "typescript"\nexport default { rules: { load() { return require(name) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape "require"')
  })

  it('rejects computed require calls from reachable chunks', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'const name = "typescript"\nexport const rules = { load() { return require(name) } }\n',
      'dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/chunk.mjs accesses runtime escape "require"')
  })

  it('rejects aliased require identifiers as static artifact policy', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const load = require\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "require"')
  })

  it('rejects computed dynamic imports with comments before arguments', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const name = "typescript"\nexport default { rules: { async load() { return import/* webpackIgnore: true */(name) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs uses computed dynamic import')
  })

  it('rejects computed dynamic imports with line breaks before arguments', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const name = "typescript"\nexport default { rules: { async load() { return import\n(name) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs uses computed dynamic import')
  })

  it('rejects computed dynamic imports with line comments before arguments', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const name = "typescript"\nexport default { rules: { async load() { return import // comment\n(name) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs uses computed dynamic import')
  })

  it('rejects dynamic imports after carriage-return line comments', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: { async load() { return import // comment\r("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects runtime escapes after unicode-separator line comments', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n// comment\u2028const load = process.getBuiltinModule("module").createRequire(import.meta.url)\nload("valibot")\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects dynamic imports with line breaks and a second argument', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'export default {}\n',
      'dist/index.mjs': 'export default { rules: { async load() { return import\n("./chunk.mjs", { with: { type: "json" } }) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs uses computed dynamic import')
  })

  it('rejects dynamic imports with a second argument', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'export default {}\n',
      'dist/index.mjs': 'export default { rules: { async load() { return import("./chunk.mjs", { with: { type: "json" } }) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs uses computed dynamic import')
  })

  it('allows dynamic relative imports with comments before string specifiers', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'export default {}\n',
      'dist/index.mjs': 'export default { rules: { async load() { return import(/* local */ "./chunk.mjs") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows dynamic relative imports with closing parens inside comments', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'export default {}\n',
      'dist/index.mjs': 'export default { rules: { async load() { return import(/* ) */ "./chunk.mjs") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows dynamic relative imports with comments after string specifiers', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'export default {}\n',
      'dist/index.mjs': 'export default { rules: { async load() { return import("./chunk.mjs" /* local */) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows builtin imports', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { extname } from "node:path"\nexport default { rules: { extname } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      apiVersion: '1',
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects unsafe builtin imports', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { execFileSync } from "node:child_process"\nexport default { rules: { execFileSync } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "node:child_process"')
  })

  it('rejects node module imports that can create indirect require calls', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { createRequire } from "node:module"\nconst load = createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "node:module"')
  })

  it('rejects node module imports with comments before specifiers', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { createRequire } from /* comment */ "node:module"\nconst load = createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "node:module"')
  })

  it('rejects node process imports that can reach getBuiltinModule', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import * as p from "node:process"\nconst load = p["get" + "Builtin" + "Module"]("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('Plugin package entry dist/index.mjs')
  })

  it('rejects process getBuiltinModule access to module', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const load = process.getBuiltinModule("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects bracket getBuiltinModule access to module', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const load = process["getBuiltinModule"]("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects split globalThis access to process getBuiltinModule', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const p = globalThis["pro" + "cess"]\nconst gbm = p["get" + "Builtin" + "Module"]\nconst load = gbm("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects global access to process getBuiltinModule', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const load = global["pro" + "cess"]["getBuiltinModule"]("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape "global"')
  })

  it('rejects escaped identifier access to globalThis getBuiltinModule', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const load = global\\u0054his["pro" + "cess"].get\\u0042uiltinModule("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects node vm imports that can evaluate runtime escapes', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import { runInThisContext } from "node:vm"\nconst makeRequire = runInThisContext("process.getBuiltinModule(\\"module\\").createRequire")\nconst load = makeRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "node:vm"')
  })

  it('rejects constructor access that can create functions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const load = ({}).constructor.constructor("return process")().getBuiltinModule("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects proto access that can reach computed constructors', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const make = ({}).__proto__["con" + "structor"]["con" + "structor"]\nconst load = make("return process")()["get" + "Builtin" + "Module"]("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs')
  })

  it('rejects string-computed constructor access', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const make = ({})["constructor"]["constructor"]\nconst load = make("return process")()["getBuiltinModule"]("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects optional computed member access', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const make = ({})?.["constructor"]?.["constructor"]\nconst cp = make("return process")()?.["get" + "Builtin" + "Module"]("child_process")\nexport default { rules: { run() { return cp.execFileSync("echo", ["owned"]) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects comment-separated computed member access', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const make = ({}) /* gap */ ["con" + "structor"] /* gap */ ["con" + "structor"]\nconst p = make("return pro" + "cess")()\nconst load = p /* gap */ ["get" + "Builtin" + "Module"]("module").createRequire(import.meta.url)\nload("valibot")\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects computed member access on literal receivers', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const a = "x"["constructor"]\nconst b = `x`["constructor"]\nconst c = /x/["constructor"]\nconst d = 0["constructor"]\nexport default { rules: { a, b, c, d } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects literal receiver constructor escapes', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { "constructor": make } = `x`["constructor"]\nconst load = make("return process.getBuiltinModule(\'module\').createRequire(import.meta.url)")()\nload("node:child_process").execFileSync("sh", ["-c", "true"])\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "constructor"')
  })

  it('rejects string-literal constructor destructuring', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { "constructor": make } = function () {}\nmake("return process.getBuiltinModule(\\"child_process\\").execFileSync(\\"sh\\", [\\"-c\\", \\"true\\"])")()\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "constructor"')
  })

  it('rejects escaped string-literal constructor destructuring', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { "constr\\u0075ctor": make } = function () {}\nmake("return process.getBuiltinModule(\\"child_process\\").execFileSync(\\"sh\\", [\\"-c\\", \\"true\\"])")()\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "constructor"')
  })

  it('rejects identifier constructor destructuring', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { constructor: make } = function () {}\nmake("return process")()\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "constructor"')
  })

  it('rejects hex-escaped string-literal constructor destructuring', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { "\\x63onstructor": make } = function () {}\nexport default { rules: { async load() { return make("return import(\'node:child_process\')")() } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "constructor"')
  })

  it('allows class constructor declarations', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'class DiagnosticError extends Error {\n  constructor(message) {\n    super(message)\n  }\n}\nexport default { rules: { DiagnosticError } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects line-continuation string-literal constructor destructuring', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { "construc\\\ntor": make } = function () {}\nconst load = make("return process")()\nexport default { rules: { load } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "constructor"')
  })

  it('rejects computed member access on non-ascii identifiers', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const 对象 = {}\nconst 原型 = 对象["con" + "structor"]\nconst 函数 = 原型["con" + "structor"]\nconst 进程 = 函数("return pro" + "cess")()\nconst 模块 = 进程["get" + "Builtin" + "Module"]("module")\n模块.createRequire(import.meta.url)("valibot")\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects computed member access on astral identifiers', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const 𝒶 = {}\nconst 𝒷 = 𝒶["con" + "structor"]\nconst 𝒸 = 𝒷["con" + "structor"]\nconst 𝒹 = 𝒸("return pro" + "cess")()\nconst 𝑒 = 𝒹["get" + "Builtin" + "Module"]("module")\nconst 𝒻 = 𝑒.createRequire(import.meta.url)\n𝒻("valibot")\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects computed property names in destructuring', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { ["con" + "structor"]: C } = async function () {}\nconst p = await C("return pro" + "cess")()\nconst { ["get" + "Builtin" + "Module"]: gbm } = p\nconst { createRequire: cr } = gbm("module")\ncr(import.meta.url)("valibot")\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects computed property names after destructuring commas', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const { ignored, ["con" + "structor"]: C } = async function () {}\nconst p = await C("return pro" + "cess")()\nconst { ignoredAgain, ["get" + "Builtin" + "Module"]: gbm } = p\nconst { createRequire: cr } = gbm("module")\ncr(import.meta.url)("valibot")\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects Object reflection access to constructors', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const make = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(function () {}), "constructor").value\nconst load = make("return process")().getBuiltinModule("module").createRequire(import.meta.url)\nexport default { rules: { load() { return load("valibot") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape')
  })

  it('rejects network globals', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: { async load() { return fetch("https://example.com/plugin-data") } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "fetch"')
  })

  it('rejects Bun runtime globals', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: { run() { return Bun.spawnSync(["sh", "-c", "echo owned"]) } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "Bun"')
  })

  it('rejects Worker runtime globals', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" })\nexport default { rules: {} }\n',
      'dist/worker.mjs': 'import "node:child_process"\nfetch("https://example.com")\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "Worker"')
  })

  it('rejects safe-looking Object identifiers as static artifact policy', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const keys = Object.keys({ value: 1 })\nexport default { rules: { keys } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "Object"')
  })

  it('rejects safe-looking fetch keys as static artifact policy', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: { fetch: {} } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape "fetch"')
  })

  it('allows array destructuring and array literals', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const [first] = [1]\nconst nested = [first, [2]]\nconst call = (value, fallback) => value ?? fallback\nconst result = call(first, [3])\nexport default { rules: { first, nested, result } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects ordinary indexing as static artifact policy', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const items = [1]\nconst first = items[0]\nexport default { rules: { first } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('rejects computed member access after carriage-return line comments', async () => {
    const root = await createPackage({
      'dist/index.mjs': '// comment\rconst make = ({})["con" + "structor"]["con" + "structor"]\nconst p = make("return " + "pro" + "cess")()\nconst load = p["get" + "Builtin" + "Module"]("module").createRequire(import.meta.url)\nload("valibot")\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed member access')
  })

  it('allows import-like text inside string literals', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const note = "import \\"valibot\\"; from \\"typescript\\""\nexport default { rules: { note } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows from identifiers before string expressions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const from = true\nfrom\n"valibot"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows runtime-escape-like text inside string values', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const message = "Object"\nexport default { rules: { demo: { message } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows runtime-escape-like text inside comments templates and regex literals', async () => {
    const root = await createPackage({
      'dist/index.mjs': '/* {"constructor": true} */\nconst note = `{"constructor": true}`\nconst pattern = /"constructor":/\nexport default { rules: { note, pattern } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects import method names as static artifact policy', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const loader = { import(value) { return value } }\nconst value = loader.import("valibot")\nexport default { rules: { value } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed dynamic import')
  })

  it('rejects dynamic imports inside block statements', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'if (true) { import("valibot") }\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects dynamic imports inside array expressions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const values = [1, import("valibot")]\nexport default { rules: { values } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('allows import-like text inside block comments', async () => {
    const root = await createPackage({
      'dist/index.mjs': '/*\nimport { marker } from "valibot"\n*/\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows import-like text after template interpolation', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const note = `$' + '{1}: import "valibot" from "typescript" process`\nexport default { rules: { note } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects runtime escape access inside division expressions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const value = 1 / process.getBuiltinModule("module").createRequire(import.meta.url)("valibot") / 1\nexport default { rules: { value } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects runtime escape access after postfix increment division expressions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'let value = 1\nconst result = value++ / process.getBuiltinModule("module").createRequire(import.meta.url)("valibot") / 1\nexport default { rules: { result } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects runtime escape access after regex character classes', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const pattern = /[/*]/\nconst load = process.getBuiltinModule("module").createRequire(import.meta.url)\nload("valibot")\nexport default { rules: { pattern } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects runtime escape access after regex literals returned from functions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'function pattern() { return /[/*]/ }\nconst load = process.getBuiltinModule("module").createRequire(import.meta.url)\nload("valibot")\nexport default { rules: { pattern } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('allows runtime-escape-like text inside regex literals returned from functions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'function pattern() { return /process|globalThis/ }\nexport default { rules: { pattern } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects runtime-escape-like text inside regex statement positions as static artifact policy', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'if (true) /process|globalThis/.test("x")\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('accesses runtime escape')
  })

  it('rejects dynamic imports inside division expressions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const value = 1 / import("valibot") / 1\nexport default { rules: { value } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects dynamic imports after postfix increment division expressions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'let value = 1\nconst result = value++ / import("valibot") / 1\nexport default { rules: { result } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "valibot"')
  })

  it('rejects computed dynamic imports inside division expressions', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'const name = "valibot"\nconst value = 1 / import(name) / 1\nexport default { rules: { value } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses computed dynamic import')
  })

  it('rejects runtime escape access inside template interpolation', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: { load() { return `$' + '{globalThis["pro" + "cess"].getBuiltinModule("module")}` } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects runtime escape access after regex inside template interpolation', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: { load() { return `$' + '{/[}]/, process.getBuiltinModule("module").createRequire(import.meta.url)("valibot")}` } } }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry dist/index.mjs accesses runtime escape')
  })

  it('rejects side-effect node module imports with comments before specifiers', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import/* comment */"node:module"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "node:module"')
  })

  it('rejects commonjs plugin entries', async () => {
    const root = await createPackage({
      'dist/index.cjs': 'module.exports = { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.cjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry must be an ESM .mjs file')
  })

  it('rejects commonjs chunks imported by esm entries', async () => {
    const root = await createPackage({
      'dist/chunk.cjs': 'const load = module["re" + "quire"]\nload("valibot")\n',
      'dist/index.mjs': 'import "./chunk.cjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('entry must be an ESM .mjs file')
  })

  it('allows absolute imports that resolve inside the package root', async () => {
    const root = await createPackage({
      'dist/chunk.mjs': 'export const rules = {}\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await writeFile(join(root, 'dist', 'index.mjs'), `import { rules } from ${JSON.stringify(join(root, 'dist', 'chunk.mjs'))}\nexport default { rules }\n`)

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      apiVersion: '1',
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('allows absolute entries that realpath inside the package root', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': '{}',
    })
    await writeFile(join(root, 'package.json'), JSON.stringify({
      alint: { apiVersion: '1', entry: join(root, 'dist', 'index.mjs') },
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    }))

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toEqual({
      apiVersion: '1',
      entry: await realpath(join(root, 'dist', 'index.mjs')),
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('returns canonical entries for absolute paths through symlinks', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'export default { rules: {} }\n',
      'package.json': '{}',
    })
    const outside = join(await mkdtemp(join(tmpdir(), 'alint-plugin-outside-entry-')), 'entry.mjs')
    await symlink(join(root, 'dist', 'index.mjs'), outside)
    await writeFile(join(root, 'package.json'), JSON.stringify({
      alint: { apiVersion: '1', entry: outside },
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    }))

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toEqual({
      apiVersion: '1',
      entry: await realpath(join(root, 'dist', 'index.mjs')),
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects relative imports that escape the package root', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import "../../outside.mjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('import "../../outside.mjs" escapes package root')
  })

  it('rejects percent-encoded relative imports', async () => {
    const root = await createPackage({
      'dist/%2e%2e/%2e%2e/outside.mjs': 'export default {}\n',
      'dist/index.mjs': 'import "./%2e%2e/%2e%2e/outside.mjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses URL percent encoding')
  })

  it('rejects hex-escaped relative imports', async () => {
    const root = await createPackage({
      'dist/\\x2e\\x2e/\\x2e\\x2e/outside.mjs': 'export default {}\n',
      'dist/index.mjs': 'import "./\\x2e\\x2e/\\x2e\\x2e/outside.mjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses string escape sequences')
  })

  it('rejects unicode-escaped relative imports', async () => {
    const root = await createPackage({
      'dist/\\u002e\\u002e/\\u002e\\u002e/outside.mjs': 'export default {}\n',
      'dist/index.mjs': 'import "./\\u002e\\u002e/\\u002e\\u002e/outside.mjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses string escape sequences')
  })

  it('rejects slash-escaped relative imports', async () => {
    const root = await createPackage({
      'dist/..\\/../outside.mjs': 'export default {}\n',
      'dist/index.mjs': 'import "./..\\/../outside.mjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('uses string escape sequences')
  })

  it('rejects missing relative imports', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import "./missing.mjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('import "./missing.mjs" does not exist')
  })

  it('allows package-local paths whose segment names start with dots', async () => {
    const root = await createPackage({
      '..entry.mjs': 'export default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './..entry.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })

  it('rejects package-local imports that resolve outside the package through symlinks', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'import "./chunk.mjs"\nexport default { rules: {} }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    const outside = join(await mkdtemp(join(tmpdir(), 'alint-plugin-outside-')), 'chunk.mjs')
    await writeFile(outside, 'export default { rules: {} }\n')
    await symlink(outside, join(root, 'dist', 'chunk.mjs'))

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('import "./chunk.mjs" escapes package root')
  })

  it('scans package-local symlink imports from their real path', async () => {
    const root = await createPackage({
      'actual/chunk.mjs': 'import "./evil.mjs"\nexport const rules = {}\n',
      'actual/evil.mjs': 'import "node:child_process"\n',
      'dist/evil.mjs': 'export default {}\n',
      'dist/index.mjs': 'import { rules } from "./chunk.mjs"\nexport default { rules }\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })
    await symlink(join(root, 'actual', 'chunk.mjs'), join(root, 'dist', 'chunk.mjs'))

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).rejects.toThrow('imports external package "node:child_process"')
  })

  it('does not execute plugin entries during verification', async () => {
    const root = await createPackage({
      'dist/index.mjs': 'throw new Error("entry executed")\n',
      'package.json': JSON.stringify({
        alint: { apiVersion: '1', entry: './dist/index.mjs' },
        name: '@alint-js/plugin-python',
        version: '0.3.1',
      }),
    })

    await expect(verifyExtractedPluginPackage(root, {
      expectedName: '@alint-js/plugin-python',
      expectedVersion: '0.3.1',
      supportedApiVersion: '1',
    })).resolves.toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
  })
})

async function createPackage(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alint-plugin-package-'))

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  return root
}
