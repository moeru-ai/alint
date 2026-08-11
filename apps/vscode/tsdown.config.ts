import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  // `vscode` has no package on disk. The extension host supplies it at run time.
  deps: { neverBundle: ['vscode'] },
  dts: false,
  entry: { index: 'src/extension.ts' },
  // Required, not a preference. The host loads extensions as CommonJS, and it injects the `vscode`
  // module into CommonJS modules only.
  format: 'cjs',
  platform: 'node',
})
