import type { CAC } from 'cac'

export type Cli = CAC

export interface CliIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: CliWritable
  stdin?: { isTTY?: boolean }
  stdout: CliWritable
}

export interface CliWritable {
  columns?: number
  isTTY?: boolean
  write: (chunk: string) => unknown
}
