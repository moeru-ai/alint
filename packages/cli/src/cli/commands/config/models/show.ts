import { findModel, formatModelShow } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { loadMergedSetupConfig } from '../setup-config'

export const show = defineCommand({
  async action(context, model: string) {
    const candidate = findModel(await loadMergedSetupConfig(context.io), model)

    if (candidate === undefined) {
      context.io.stderr.write(`unknown model "${model}".\n`)
      return 2
    }

    context.io.stdout.write(formatModelShow(candidate))
    return 0
  },
  arguments: '<model>',
  description: 'Show configured model',
  name: 'show',
})
