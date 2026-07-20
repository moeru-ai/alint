import type { AgentTool } from '@alint-js/core/agent'

import { defineTool } from '@alint-js/core/agent'
import { toolParametersFromSchema } from '@alint-js/core/structured-output'
import {
  array,
  description,
  integer,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  picklist,
  pipe,
  regex,
  safeParse,
  strictObject,
  string,
} from 'valibot'

export type NonEmptyCategories<Category extends string> = readonly [Category, ...Category[]]

export interface RepositoryFinding<Category extends string = string> {
  category: Category
  futureFailure?: string
  line: number
  message: string
  proof: string
  relatedLocations: string[]
  suggestion: string
}

export type RepositoryFindingWithRequiredEvidence<Category extends string = string> = Omit<
  RepositoryFinding<Category>,
  'futureFailure' | 'relatedLocations'
> & {
  futureFailure: string
  relatedLocations: [string, ...string[]]
}

export interface SubmitReviewController<Category extends string> {
  getFindings: () => RepositoryFinding<Category>[] | undefined
  tool: AgentTool
}

interface SubmitReviewOptions<Category extends string> {
  allowedCategories: NonEmptyCategories<Category>
  lineCount: number
  requireFutureFailure: boolean
  requireRelatedLocations: boolean
  validateFinding?: (finding: RepositoryFinding<Category>) => Promise<string | undefined>
  validateRelatedLocation: (location: string, primaryLine: number) => Promise<string | undefined>
  validateSubmission?: (findings: RepositoryFinding<Category>[]) => Promise<string | undefined>
}

export function createSubmitReviewTool<Category extends string>(
  options: SubmitReviewOptions<Category>,
): SubmitReviewController<Category> {
  const submissionSchema = createSubmissionSchema(options)
  let submittedFindings: RepositoryFinding<Category>[] | undefined
  let submissionState: 'open' | 'submitted' | 'validating' = 'open'

  return {
    getFindings: () => submittedFindings,
    tool: defineTool({
      description: 'Submit the complete repository review exactly once. Use an empty findings array when the review is clean.',
      execute: async (input) => {
        if (submissionState !== 'open') {
          return 'review rejected: a review submission is already in progress or was already submitted'
        }

        const result = safeParse(submissionSchema, input)

        if (!result.success) {
          return `review rejected: ${result.issues[0]?.message ?? 'submission did not match the required schema'}`
        }

        const normalizedFindings = result.output.findings.map(finding => ({
          category: finding.category,
          ...(finding.futureFailure ? { futureFailure: finding.futureFailure.trim() } : {}),
          line: finding.line,
          message: finding.message.trim(),
          proof: finding.proof.trim(),
          relatedLocations: finding.relatedLocations.map(location => location.trim()),
          suggestion: finding.suggestion.trim(),
        }))

        submissionState = 'validating'

        try {
          const submissionValidationError = await options.validateSubmission?.(normalizedFindings)

          if (submissionValidationError) {
            submissionState = 'open'
            return `review rejected: ${submissionValidationError}`
          }

          for (const finding of normalizedFindings) {
            for (const location of finding.relatedLocations) {
              const validationError = await options.validateRelatedLocation(location, finding.line)

              if (validationError) {
                submissionState = 'open'
                return `review rejected: ${validationError}`
              }
            }

            const findingValidationError = await options.validateFinding?.(finding)

            if (findingValidationError) {
              submissionState = 'open'
              return `review rejected: ${findingValidationError}`
            }
          }

          submittedFindings = normalizedFindings.map(finding => ({
            ...finding,
            relatedLocations: [...new Set(finding.relatedLocations)],
          }))
          submissionState = 'submitted'

          return 'review submitted'
        }
        catch {
          submissionState = 'open'
          return 'review rejected: related-location validation failed unexpectedly'
        }
      },
      name: 'submit_review',
      parameters: { ...toolParametersFromSchema(submissionSchema) },
    }),
  }
}

function createSubmissionSchema<Category extends string>(options: SubmitReviewOptions<Category>) {
  const nonBlankString = (field: string) => pipe(
    string(),
    minLength(1, `${field} must be a non-blank string.`),
    regex(/\S/, `${field} must be a non-blank string.`),
  )
  const futureFailureSchema = options.requireFutureFailure
    ? pipe(
        nonBlankString('futureFailure'),
        description('A concrete future change that this architecture would make fail or become costly.'),
      )
    : pipe(
        nullable(nonBlankString('futureFailure')),
        description('A concrete future failure when relevant, otherwise null.'),
      )
  const relatedLocationsSchema = options.requireRelatedLocations
    ? pipe(
        array(nonBlankString('relatedLocations entry')),
        minLength(1, 'relatedLocations must contain at least one repo-relative path:line citation.'),
        description('Other relevant repository locations, each formatted as an exact repo-relative path:line citation.'),
      )
    : pipe(
        array(nonBlankString('relatedLocations entry')),
        description('Other relevant repository locations, each formatted as an exact repo-relative path:line citation.'),
      )
  const findingSchema = strictObject({
    category: pipe(
      picklist(options.allowedCategories),
      description('Finding category. Use exactly one of the allowed categories.'),
    ),
    futureFailure: futureFailureSchema,
    line: pipe(
      number(),
      integer('line must be an integer.'),
      minValue(1, 'line must be at least 1.'),
      maxValue(options.lineCount, `line must not exceed ${options.lineCount}.`),
      description('The one-based target-file line where the finding is anchored.'),
    ),
    message: pipe(
      nonBlankString('message'),
      description('A concise explanation of the architectural problem.'),
    ),
    proof: pipe(
      nonBlankString('proof'),
      description('Concrete repository evidence that proves the finding.'),
    ),
    relatedLocations: relatedLocationsSchema,
    suggestion: pipe(
      nonBlankString('suggestion'),
      description('One concrete remediation direction.'),
    ),
  })

  return pipe(
    strictObject({
      findings: pipe(
        array(findingSchema),
        description('All validated repository findings. Use an empty array when the review is clean.'),
      ),
    }),
    description('The complete repository review submission.'),
  )
}
