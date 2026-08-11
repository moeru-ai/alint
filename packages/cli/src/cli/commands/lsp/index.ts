import { defineCommand } from '../command'

export const lsp = defineCommand({
  // Loaded on demand, so a plain `alint` run does not load the protocol stack.
  action: async context => (await import('./server')).startLspServer(context.io),
  description: 'Run alint as a language server over stdio',
  examples: [
    [
      '# Point an editor at the project\'s own alint',
      'alint lsp',
    ].join('\n'),
  ],
  help: [
    'Serve alint diagnostics over the Language Server Protocol on stdin/stdout.',
    'The server is cache-first: it publishes findings that are already cached and never calls a model on its own. Runs that spend tokens happen only through the `alint.runFile` and `alint.runWorkspace` commands.',
  ].join('\n\n'),
  name: 'lsp',
  options: [
    // NOTICE: LSP clients send --stdio without being asked. stdio is the only transport alint
    // serves, so accept the flag and ignore it. A rejected flag fails the first connection.
    { description: 'Use stdio transport (default; accepted for client compatibility)', flags: '--stdio' },
  ],
})
