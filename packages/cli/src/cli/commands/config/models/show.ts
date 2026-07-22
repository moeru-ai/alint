import { findModels, formatAmbiguousModels, formatModelShow } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { loadMergedSetupConfig } from '../setup-config'

export const show = defineCommand({
  async action(context, model: string) {
    const candidates = findModels(await loadMergedSetupConfig(context.io), model)

    if (candidates.length === 0) {
      context.io.stderr.write(`unknown model "${model}".\n`)
      return 2
    }

    if (candidates.length > 1) {
      context.io.stderr.write(formatAmbiguousModels(model, candidates))
      return 2
    }

    context.io.stdout.write(formatModelShow(candidates[0]!))
    return 0
  },
  arguments: '<model>',
  description: 'Show configured model',
  name: 'show',
})
