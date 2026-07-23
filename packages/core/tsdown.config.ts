import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    'agent': 'src/agent/index.ts',
    'dsl': 'src/dsl/index.ts',
    'index': 'src/index.ts',
    'languages': 'src/core/languages/public.ts',
    'languages-js': 'src/core/languages/js/public.ts',
    'structured-output': 'src/structuredOutput/index.ts',
  },
  format: 'esm',
})
