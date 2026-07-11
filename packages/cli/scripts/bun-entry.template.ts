import process from 'node:process'

import bindingPath from '__ALINT_OXC_BINDING__' with { type: 'file' }

import { errorMessageFrom } from '@moeru/std'

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bindingPath

const { executeCli } = await import('__ALINT_CLI_ENTRY__')

void executeCli(process.argv, {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdout: process.stdout,
}).then((exitCode) => {
  process.exitCode = exitCode
}).catch((error) => {
  process.stderr.write(`${errorMessageFrom(error)}\n`)
  process.exitCode = 2
})
