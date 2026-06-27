import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    'bin/index': 'src/bin/index.ts',
    'index': 'src/index.ts',
  },
  format: 'esm',
})
