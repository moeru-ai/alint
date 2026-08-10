import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: ['@alint-js/utils/node', '@moeru/std', 'tinyexec'],
  },
  dts: false,
  entry: {
    'stop-gate': 'src/stop-gate.ts',
  },
  format: 'esm',
  outDir: 'dist',
})
