import { defineCommand } from '../../command'
import { ls } from './ls'
import { probe } from './probe'
import { set } from './set'
import { show } from './show'
import { unset } from './unset'
import { update } from './update'

export const providers = defineCommand({
  children: [
    ls,
    show,
    probe,
    update,
    set,
    unset,
  ],
  description: 'Manage configured providers',
  name: 'providers',
})
