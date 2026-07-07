import { definePlugin } from '@alint-js/core'

export { createTools } from './tools'

export function createRustPlugin() {
  return definePlugin({
    configs: {
      example: [
        {
          files: ['**/*.rs'],
          language: 'text/plain',
          rules: {},
        },
      ],
    },
    rules: {},
  })
}

export const rustPlugin = createRustPlugin()

export default rustPlugin
