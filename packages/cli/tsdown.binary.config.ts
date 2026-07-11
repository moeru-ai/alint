import process from 'node:process'

import { defineConfig } from 'tsdown'

import { buildBunExecutable } from './scripts/build-bun-executable.ts'

const buildOptions = parseBuildOptions(process.argv.slice(2))

export default defineConfig({
  clean: false,
  dts: false,
  entry: {
    'binary/index': 'src/bin/index.ts',
  },
  format: 'esm',
  hooks: {
    'build:done': async () => {
      await buildBunExecutable(buildOptions)
    },
  },
  write: false,
})

function parseArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>()

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]

    if (value === '--') {
      continue
    }

    if (!value.startsWith('--')) {
      continue
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

function parseBuildOptions(values: string[]): Parameters<typeof buildBunExecutable>[0] {
  const args = parseArgs(values)

  return {
    bunTarget: requiredArg(args, 'bun-target'),
    outfile: requiredArg(args, 'outfile'),
    oxcBinding: requiredArg(args, 'oxc-binding'),
    target: requiredArg(args, 'target'),
  }
}

function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name)

  if (!value) {
    throw new Error(`Missing required argument --${name}`)
  }

  return value
}
