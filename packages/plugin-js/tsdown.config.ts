import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: ['oxc-parser'],
  },
  dts: true,
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
})
