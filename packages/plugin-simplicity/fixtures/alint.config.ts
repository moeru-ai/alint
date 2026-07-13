import { createApeiraAdapter } from '@alint-js/agent-apeira'
import { defineConfig } from '@alint-js/core'

import { simplicityPlugin } from '../src/index'

/*
 * A hand-run demo, over the corpus the evaluation is graded against. Every language
 * ships the same cases:
 *
 *   store / archive  a character-for-character copy       (an exact match)
 *   renamed          a copy that renamed what it declares (a renamed match)
 *   accessors        one shape, two questions             (must stay silent)
 *   needless         two helpers that earn their existence and two that do not
 *
 * TypeScript adds `reimplemented.ts`, which no fingerprint can settle, and `arrows.ts`,
 * which repeats the cases in the shape a TypeScript codebase actually writes them in.
 *
 * The plugin is imported from source, so the demo needs no build.
 *
 * `judge: false` keeps the demo at zero tokens: it shows the AST approach and calls no
 * model. Turn it on to see the agentic approach and `no-needless-helper`, which has no AST
 * approach and reports nothing without a model. Leave it off unless you mean to spend money.
 */
export default defineConfig([
  {
    agent: createApeiraAdapter(),
    files: ['**/*.{ts,rs,go,py}'],
    ignores: ['alint.config.ts'],
    language: 'text/plain',
    plugins: {
      simplicity: simplicityPlugin,
    },
    rules: {
      'simplicity/no-duplicated-helper': 'warn',
      'simplicity/no-needless-helper': 'warn',
    },
    settings: {
      simplicity: {
        ignores: ['alint.config.ts'],
        judge: false,
      },
    },
  },
])
