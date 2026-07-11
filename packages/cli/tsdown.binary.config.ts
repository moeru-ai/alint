import type { BuildBunExecutableOptions } from './scripts/tsdown-plugin-bun-sea'

import process from 'node:process'

import { defineConfig } from 'tsdown'

import { pluginBunSea } from './scripts/tsdown-plugin-bun-sea'
import { parseArgs, requiredArg } from './scripts/utils'

const args = parseArgs(process.argv.slice(2))

const buildOptions = {
  bunTarget: requiredArg(args, 'bun-target'),
  outfile: requiredArg(args, 'outfile'),
  oxcBinding: requiredArg(args, 'oxc-binding'),
  target: requiredArg(args, 'target'),
} satisfies BuildBunExecutableOptions

export default defineConfig({
  clean: false,
  dts: false,
  entry: {
    'binary/index': 'src/bin/index.ts',
  },
  format: 'esm',
  hooks: {
    'build:done': async () => await pluginBunSea(buildOptions),
  },
  write: false,
})
