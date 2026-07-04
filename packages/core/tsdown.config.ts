import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    agent: 'src/agent/index.ts',
    index: 'src/index.ts',
  },
  format: 'esm',
})
