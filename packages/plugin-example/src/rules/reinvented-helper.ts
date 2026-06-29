/// Super WIP

import type { AgentAdapter, AgentTool } from '@alint-js/agent'
import type { RuleDefinition, SourceFile, SourceRuntime } from '@alint-js/core'

import { resolve } from 'node:path'

import { defineTool } from '@alint-js/agent'
import { errorMessageFrom } from '@moeru/std/error'

export interface ReinventedHelperFinding {
  line: number
  message: string
  suggestion: string
}

export const reinventedHelperInstructions = [
  'You review one TypeScript file for local helper functions that duplicate a utility already available in the repository or in a dependency.',
  'Use the read_file tool to inspect the modules the file imports, and any shared utilities, before deciding.',
  'When a local helper clearly duplicates an available utility, call report_finding once for that helper.',
  'This is a warning-level design smell, not a correctness error. If nothing qualifies, report nothing.',
].join('\n')

export function createReadFileTool(src: Pick<SourceRuntime, 'readFile'>, cwd: string): AgentTool {
  return defineTool({
    description: 'Read a source file by its path (relative to the project root) and return its full text.',
    execute: async (input) => {
      const { path } = input as { path: string }

      try {
        const file = await src.readFile(resolve(cwd, path))

        return file.text
      }
      catch (error) {
        return `Could not read "${path}": ${errorMessageFrom(error) ?? String(error)}`
      }
    },
    name: 'read_file',
    parameters: {
      additionalProperties: false,
      properties: {
        path: { description: 'Path of the file to read, relative to the project root.', type: 'string' },
      },
      required: ['path'],
      type: 'object',
    },
  })
}

export function createReinventedHelperRule(adapter: AgentAdapter): RuleDefinition {
  return {
    cache: false,
    create: ctx => ({
      async onFile(file) {
        const findings: ReinventedHelperFinding[] = []
        const tools: AgentTool[] = [
          createReadFileTool(ctx.src, ctx.cwd),
          createReportFindingTool(findings),
        ]

        const model = await ctx.model()

        await adapter({
          instructions: reinventedHelperInstructions,
          model,
          prompt: buildPrompt(file),
          tools,
        })

        for (const finding of findings) {
          ctx.report({
            evidence: { suggestion: finding.suggestion },
            filePath: file.path,
            loc: { start: { column: 0, line: finding.line } },
            message: finding.message,
          })
        }
      },
    }),
  }
}

export function createReportFindingTool(findings: ReinventedHelperFinding[]): AgentTool {
  return defineTool({
    description: 'Report one helper function that duplicates a utility already available in the repo or a dependency. Call once per finding.',
    execute: (input) => {
      const finding = input as ReinventedHelperFinding

      findings.push({
        line: finding.line,
        message: finding.message,
        suggestion: finding.suggestion,
      })

      return 'recorded'
    },
    name: 'report_finding',
    parameters: {
      additionalProperties: false,
      properties: {
        line: { description: 'Declaration line of the duplicated helper in the target file.', type: 'number' },
        message: { description: 'What the helper duplicates and why it is redundant. Keep it short.', type: 'string' },
        suggestion: { description: 'One concrete direction to remove the duplication.', type: 'string' },
      },
      required: ['line', 'message', 'suggestion'],
      type: 'object',
    },
  })
}

function buildPrompt(file: SourceFile): string {
  return [
    `Review this file: ${file.path}`,
    '',
    'Code with line numbers:',
    '',
    file.text.split('\n').map((line, index) => `${index + 1} | ${line}`).join('\n'),
  ].join('\n')
}
