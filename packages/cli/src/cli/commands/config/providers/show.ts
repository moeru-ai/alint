import { formatProviderShow } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { loadMergedSetupConfig } from '../setup-config'

export const show = defineCommand({
  async action(context, providerId: string) {
    const config = await loadMergedSetupConfig(context.io)
    const provider = config.providers.find(item => item.id === providerId)

    if (provider === undefined) {
      context.io.stderr.write(`unknown provider "${providerId}".\n`)
      return 2
    }

    context.io.stdout.write(formatProviderShow(provider))
    return 0
  },
  arguments: '<provider>',
  description: 'Show configured provider',
  name: 'show',
})
