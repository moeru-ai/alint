import process from 'node:process'

import { defineConfig } from 'tsdown'

import { buildBunExecutable } from './scripts/build-bun-executable.ts'

export default defineConfig({
  clean: false,
  dts: false,
  entry: {
    'binary/index': 'src/bin/index.ts',
  },
  format: 'esm',
  hooks: {
    'build:done': async () => {
      await buildBunExecutable({
        bunTarget: requiredEnv('ALINT_BUN_TARGET'),
        outfile: requiredEnv('ALINT_BINARY_OUTFILE'),
        oxcBinding: requiredEnv('ALINT_OXC_BINDING'),
        target: requiredEnv('ALINT_BINARY_TARGET'),
      })
    },
  },
  write: false,
})

function requiredEnv(name: string): string {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}
