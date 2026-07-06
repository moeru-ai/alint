export interface LintCommandOptions {
  cache?: boolean
  cacheLocation?: string
  config?: string
  fileConcurrency?: string
  format: string
  lang?: string
  model?: string
  outputLanguage?: string
  progress?: boolean
  ruleConcurrency?: string
  stats?: boolean
  timeoutMs?: string
}
