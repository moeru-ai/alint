import type { Cli, CliIo, CliWritable } from '../types'

export type CommandAction = (
  context: CommandContext,
  ...args: any[]
) => number | Promise<number>

export interface CommandContext {
  interceptConsoleOutput: (stdout: CliWritable) => () => void
  io: CliIo
  setupNoInteractive: boolean
}

export interface CommandNode {
  action?: CommandAction
  alias?: readonly string[]
  allowUnknownOptions?: boolean
  arguments?: string
  children?: readonly CommandNode[]
  default?: boolean
  description: string
  name: string
  options?: readonly CommandOption[]
}

export interface CommandOption {
  config?: {
    default?: unknown
    type?: unknown[]
  }
  description: string
  flags: string
}

export function defineCommand(node: CommandNode): CommandNode {
  return node
}

export function registerCommandTree(
  cli: Cli,
  nodes: readonly CommandNode[],
  context: CommandContext,
  setPendingResult: (result: Promise<number>) => Promise<number>,
): void {
  for (const node of nodes) {
    registerRootCommand(cli, node, context, setPendingResult)
  }
}

function collectCommandOptions(node: CommandNode): CommandOption[] {
  const options = new Map<string, CommandOption>()

  for (const option of node.options ?? []) {
    options.set(option.flags, option)
  }

  for (const child of node.children ?? []) {
    for (const option of collectCommandOptions(child)) {
      options.set(option.flags, option)
    }
  }

  return [...options.values()]
}

function commandPattern(node: CommandNode): string {
  if (node.default) {
    return node.arguments ?? node.name
  }

  return [node.name, node.children ? '[...args]' : node.arguments]
    .filter(Boolean)
    .join(' ')
}

function dispatchCommand(
  context: CommandContext,
  node: CommandNode,
  args: readonly string[],
  options: unknown,
  path: readonly string[],
): Promise<number> {
  const [subcommand, ...restArgs] = args
  const child = node.children?.find(item =>
    item.name === subcommand || item.alias?.includes(subcommand ?? ''),
  )

  if (child) {
    return dispatchCommand(context, child, restArgs, options, [...path, child.name])
  }

  if (!node.action) {
    return Promise.resolve(reportUnknownCommand(context, path, args))
  }

  return Promise.resolve(node.action(context, ...parseCommandArguments(node, args), options))
}

function formatUnknownCommand(path: readonly string[], args: readonly string[]): string {
  return [...path, ...args].filter(Boolean).join(' ')
}

function parseCommandArguments(node: CommandNode, args: readonly string[]): unknown[] {
  if (!node.arguments) {
    return []
  }

  const parts = node.arguments.split(/\s+/u).filter(Boolean)
  const values: unknown[] = []
  let argIndex = 0

  for (const part of parts) {
    if (part.startsWith('[...') || part.startsWith('<...')) {
      values.push(args.slice(argIndex))
      argIndex = args.length
      continue
    }

    if (part.startsWith('<') && argIndex >= args.length) {
      throw new Error(`Missing required argument ${part}.`)
    }

    values.push(args[argIndex])
    argIndex += 1
  }

  return values
}

function registerRootCommand(
  cli: Cli,
  node: CommandNode,
  context: CommandContext,
  setPendingResult: (result: Promise<number>) => Promise<number>,
): void {
  const command = cli.command(commandPattern(node), node.description)

  if (node.allowUnknownOptions || node.children) {
    command.allowUnknownOptions()
  }

  for (const alias of node.alias ?? []) {
    command.alias(alias)
  }

  for (const option of collectCommandOptions(node)) {
    command.option(option.flags, option.description, option.config)
  }

  command.action((...args: unknown[]) => {
    const options = args.at(-1)
    const result = node.children
      ? dispatchCommand(context, node, (args[0] as string[] | undefined) ?? [], options, [node.name])
      : Promise.resolve(node.action?.(context, ...args.slice(0, -1), options) ?? 0)

    return setPendingResult(result)
  })
}

function reportUnknownCommand(
  context: CommandContext,
  path: readonly string[],
  args: readonly string[],
): number {
  context.io.stderr.write(`unknown config command: ${formatUnknownCommand(path, args)}\n`)
  return 2
}
