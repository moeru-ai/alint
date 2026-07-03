import { defineCommand } from '../../command'
import { ls } from './ls'
import { probe } from './probe'
import { show } from './show'

export const models = defineCommand({
  children: [
    probe,
    ls,
    show,
  ],
  description: 'Manage configured models',
  name: 'models',
})
