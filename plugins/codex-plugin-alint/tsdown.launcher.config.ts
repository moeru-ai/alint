import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: false,
  deps: {
    alwaysBundle: ['@alint-js/utils/node', '@moeru/std', 'tinyexec'],
  },
  dts: false,
  entry: {
    'stop-gate-launcher': 'src/stop-gate-launcher.ts',
  },
  format: 'esm',
  outDir: 'dist',
  // Keep the launcher self-contained so it can report a runtime bundle load failure.
  outputOptions: {
    codeSplitting: false,
  },
})
