import { defineCommand } from '../../command'
import { ls } from './ls'
import { probe } from './probe'
import { show } from './show'
import { update } from './update'

export const providers = defineCommand({
  children: [
    ls,
    show,
    probe,
    update,
  ],
  description: 'Manage configured providers',
  name: 'providers',
})
