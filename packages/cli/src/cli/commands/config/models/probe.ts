import type { ProbeOptions } from '../probe'

import { errorMessageFrom } from '@moeru/std/error'

import { probeModels } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { providerHeadersFromOptions } from '../probe'

export const probe = defineCommand({
  async action(context, options: ProbeOptions) {
    if (!options.endpoint) {
      context.io.stderr.write('config models probe requires --endpoint.\n')
      return 2
    }

    try {
      const models = await probeModels(options.endpoint, providerHeadersFromOptions(options))
      context.io.stdout.write(`${models.join('\n')}${models.length > 0 ? '\n' : ''}`)
      return 0
    }
    catch (error) {
      context.io.stderr.write(`failed to probe models: ${errorMessageFrom(error) ?? String(error)}\n`)
      return 2
    }
  },
  description: 'Probe OpenAI-compatible models',
  name: 'probe',
  options: [
    { description: 'Provider endpoint', flags: '--endpoint <url>' },
    { description: 'Provider header', flags: '--provider-header <Key=Value>' },
  ],
})
