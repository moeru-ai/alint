import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  copy: ['schemas'],
  dts: true,
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
})
