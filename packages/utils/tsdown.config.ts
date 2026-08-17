import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    node: 'src/node.ts',
  },
  format: 'esm',
})
