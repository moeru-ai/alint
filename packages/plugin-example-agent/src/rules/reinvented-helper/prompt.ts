export const reinventedHelperInstructions = [
  'You review one TypeScript file for local helper functions that reimplement a utility already available in the repository or in a dependency.',
  'Use the read_file tool to inspect the modules the file imports, and any shared utilities, before deciding.',
  'When a local helper clearly reimplements an available utility, call report_finding once for that helper.',
  'This is a warning-level design smell, not a correctness error. If nothing qualifies, report nothing.',
].join('\n')

export function buildReinventedHelperPrompt(path: string, source: string): string {
  return [
    `Review this file: ${path}`,
    '',
    'Code with line numbers:',
    '',
    source.split('\n').map((line, index) => `${index + 1} | ${line}`).join('\n'),
  ].join('\n')
}
