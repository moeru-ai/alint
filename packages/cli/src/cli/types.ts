import type { CAC } from 'cac'

export type Cli = CAC

export interface CliIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: CliWritable
  stdin?: CliReadable
  stdout: CliWritable
}

/**
 * A readable stream plus the TTY flag that the interactive commands read.
 *
 * `StreamMessageReader` in `vscode-jsonrpc` requires a full `NodeJS.ReadableStream`, so a narrower
 * structural type does not compile. `PassThrough` satisfies it, which is how the protocol tests
 * supply an in-memory stream.
 */
export interface CliReadable extends NodeJS.ReadableStream {
  isTTY?: boolean
}

export interface CliWritable {
  columns?: number
  isTTY?: boolean
  rows?: number
  write: (chunk: string) => unknown
}
