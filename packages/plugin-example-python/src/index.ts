import { definePlugin } from '@alint-js/core'

import { pythonSemanticBoundaryRule } from './rules/semantic-boundary'
import { pythonTypedArtifactBoundaryRule } from './rules/typed-artifact-boundary'

export {
  collectPythonSemanticBoundaryContext,
  createPythonSemanticBoundaryMessages,
  createReportFindingsToolParameters,
  pythonSemanticBoundaryFindingSchema,
  pythonSemanticBoundaryPrompt,
  pythonSemanticBoundaryResponseSchema,
  reportPythonSemanticBoundaryFindings,
} from './rules/semantic-boundary'
export {
  createPythonTypedArtifactBoundaryMessages,
  pythonTypedArtifactBoundaryFindingSchema,
  pythonTypedArtifactBoundaryPrompt,
  pythonTypedArtifactBoundaryResponseSchema,
  reportPythonTypedArtifactBoundaryFindings,
} from './rules/typed-artifact-boundary'
export { createTools } from './tools'

export function createPythonPlugin() {
  return definePlugin({
    configs: {
      example: [
        {
          files: ['**/*.py'],
          language: 'text/plain',
          rules: {
            'python/semantic-boundary': 'warn',
            'python/typed-artifact-boundary': 'warn',
          },
        },
      ],
    },
    rules: {
      'semantic-boundary': pythonSemanticBoundaryRule,
      'typed-artifact-boundary': pythonTypedArtifactBoundaryRule,
    },
  })
}

export const pythonPlugin = createPythonPlugin()

export default pythonPlugin
