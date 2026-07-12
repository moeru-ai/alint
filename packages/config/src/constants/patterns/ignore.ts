// NOTICE: Mirrors ESLint flat config's built-in global ignore baseline.
// ESLint documents these defaults as `["**/node_modules/", ".git/"]`.
//
// Source:
// `https://github.com/eslint/eslint/blob/d4eb2dc95f17cdf491edca91b7d9caf05b86253f/docs/src/use/configure/ignore.md#L35`
export const ignorePatternsEslintDefaults = [
  '**/node_modules/**',
  '.git/**',
  '**/.git/**',
] as const

// NOTICE: Adapted from antfu/eslint-config's `GLOB_EXCLUDE` build-output
// entries. Directory patterns use `/**` here so alint discovery can prune
// contents consistently when these strings are used as global ignores.
//
// Source:
// `https://github.com/antfu/eslint-config/blob/5ada54fd1f6527b012203c9694212eb8fa11bc82/src/globs.ts#L56-L80`
export const ignorePatternsBuildOutputs = [
  '**/dist/**',
  '**/coverage/**',
  '**/output/**',
  '**/.output/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.vercel/**',
] as const

// NOTICE: Adapted from antfu/eslint-config's cache and temporary-directory
// entries in `GLOB_EXCLUDE`.
//
// Source:
// `https://github.com/antfu/eslint-config/blob/5ada54fd1f6527b012203c9694212eb8fa11bc82/src/globs.ts#L66-L81`
export const ignorePatternsCaches = [
  '**/.cache/**',
  '**/.temp/**',
  '**/.tmp/**',
  '**/temp/**',
  '**/tmp/**',
  '**/.vitepress/cache/**',
  '**/.vite-inspect/**',
] as const

// NOTICE: Adapted from antfu/eslint-config's generated, minified, and
// project-metadata exclusions in `GLOB_EXCLUDE`.
//
// Source:
// `https://github.com/antfu/eslint-config/blob/5ada54fd1f6527b012203c9694212eb8fa11bc82/src/globs.ts#L83-L91`
export const ignorePatternsGenerated = [
  '**/CHANGELOG*.md',
  '**/LICENSE*',
  '**/*.min.*',
  '**/__snapshots__/**',
  '**/components.d.ts',
] as const

// NOTICE: Adapted from antfu/eslint-config's AI-related exclusions. This
// preset intentionally stays limited to externally sourced patterns; project
// local agent artifacts should live in that project's `.gitignore`.
//
// Source:
// `https://github.com/antfu/eslint-config/blob/5ada54fd1f6527b012203c9694212eb8fa11bc82/src/globs.ts#L93-L97`
export const ignorePatternsAIAgents = [
  '**/.agents/**',
  '**/.claude/**',
] as const

export const ignorePatternsCommon = [
  ...ignorePatternsEslintDefaults,
  ...ignorePatternsBuildOutputs,
  ...ignorePatternsCaches,
  ...ignorePatternsGenerated,
] as const
