import type { InspectOptions } from 'node:util'

import type { CliIo, CliWritable } from './types'

import { inspect } from 'node:util'

import { cac } from 'cac'

import { commandTree, registerCommandTree } from './commands'

export type { CliIo } from './types'

export async function executeCli(argv: string[], io: CliIo): Promise<number> {
  const cli = cac('alint')
  const setupNoInteractive = argv.includes('-N') || argv.includes('--no-interactive')
  const globalOptions = {
    outputLanguage: parseStringOption(argv, ['--lang', '-l']),
  }
  let pendingResult: Promise<number> | undefined
  const setPendingResult = (result: Promise<number>) => {
    pendingResult = result
    return result
  }

  cli
    .option('--no-cache', 'Disable cache for this run')
    .option('--cache-location <path>', 'Path to the alint cache file or directory')
    .option('--config <path>', 'Path to alint config file')
    .option('--file-concurrency <count>', 'Number of files to lint concurrently')
    .option('--format <format>', 'Reporter format', { default: 'stylish' })
    .option('--model <model>', 'Force a model override')
    .option('-l, --lang <language>', 'Ask model-backed rules to write diagnostics in this language')
    .option('--progress', 'Show run progress')
    .option('--rule-concurrency <count>', 'Number of rules to run concurrently within a file')
    .option('--timeout-ms <ms>', 'Rule execution timeout in milliseconds')
    .help()

  registerCommandTree(cli, commandTree, {
    globalOptions,
    interceptConsoleOutput,
    io,
    setupNoInteractive,
  }, setPendingResult)

  const restoreConsole = interceptConsoleOutput(shouldCaptureHelp(argv) ? io.stdout : io.stderr)

  try {
    cli.parse(argv)
    return await (pendingResult ?? Promise.resolve(0))
  }
  finally {
    restoreConsole()
  }
}

function interceptConsoleOutput(stdout: CliWritable): () => void {
  const cliConsole = globalThis.console
  const originalConsoleDebug = cliConsole.debug
  const originalConsoleDir = cliConsole.dir
  const originalConsoleInfo = console.info
  const originalConsoleLog = cliConsole.log

  const writeConsoleLine = (...args: unknown[]) => {
    stdout.write(`${args.map(String).join(' ')}\n`)
  }
  const writeConsoleDir = (item?: unknown, options?: InspectOptions) => {
    stdout.write(`${inspect(item, options)}\n`)
  }

  cliConsole.debug = writeConsoleLine
  cliConsole.dir = writeConsoleDir
  console.info = writeConsoleLine
  cliConsole.log = writeConsoleLine

  return () => {
    cliConsole.debug = originalConsoleDebug
    cliConsole.dir = originalConsoleDir
    console.info = originalConsoleInfo
    cliConsole.log = originalConsoleLog
  }
}

function parseStringOption(argv: readonly string[], flags: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    for (const flag of flags) {
      const equalsPrefix = `${flag}=`

      if (value?.startsWith(equalsPrefix)) {
        return value.slice(equalsPrefix.length)
      }

      if (value === flag) {
        return argv[index + 1]
      }
    }
  }

  return undefined
}

function shouldCaptureHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}
