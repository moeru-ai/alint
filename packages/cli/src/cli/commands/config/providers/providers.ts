import { defineCommand } from '../../command'
import { ls } from './ls'
import { probe } from './probe'
import { show } from './show'

export const providers = defineCommand({
  children: [
    ls,
    show,
    probe,
  ],
  description: 'Manage configured providers',
  name: 'providers',
})
