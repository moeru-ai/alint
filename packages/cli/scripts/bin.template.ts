import process from 'node:process'

// @ts-expect-error - stub/template file
import bindingPath from '__ALINT_OXC_BINDING__' with { type: 'file' }

import { errorMessageFrom } from '@moeru/std'

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bindingPath

// @ts-expect-error - stub/template file
const { executeCli } = await import('__ALINT_CLI_ENTRY__')

void executeCli(process.argv, {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdout: process.stdout,
}).then((exitCode: number) => {
  process.exitCode = exitCode
}).catch((error: unknown) => {
  process.stderr.write(`${errorMessageFrom(error)}\n`)
  process.exitCode = 2
})
