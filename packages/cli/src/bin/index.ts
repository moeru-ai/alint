#!/usr/bin/env node

import process from 'node:process'

import { executeCli } from '../cli'

void executeCli(process.argv, {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
}).then((exitCode) => {
  process.exitCode = exitCode
}).catch((error) => {
  process.stderr.write(`${formatError(error)}\n`)
  process.exitCode = 2
})

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
