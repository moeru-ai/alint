import { formatModelList } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { loadMergedSetupConfig } from '../setup-config'

export const ls = defineCommand({
  async action(context) {
    context.io.stdout.write(formatModelList(await loadMergedSetupConfig(context.io)))
    return 0
  },
  alias: ['ls'],
  description: 'List configured models',
  name: 'list',
})
