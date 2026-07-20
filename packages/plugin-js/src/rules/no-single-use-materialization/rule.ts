import type { SyntaxNode } from '../../agents/syntax'

import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import {
  childSyntaxNodes,
  isSyntaxNode,
  parseProgram,
  sourceLinesForNodes,
  visitSyntax,
} from '../../agents/syntax'
import {
  singleUseMaterializationInstructions,
  singleUseMaterializationPrompt,
  singleUseMaterializationVerificationPrompt,
} from './prompt'

const SINGLE_USE_MATERIALIZATION_CATEGORIES = ['single-use-materialization'] as const
const COLLECTION_CONSUMER_METHODS = new Set([
  'concat',
  'entries',
  'every',
  'filter',
  'find',
  'findIndex',
  'flatMap',
  'forEach',
  'has',
  'includes',
  'join',
  'keys',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'values',
])
const COLLECTION_MUTATION_METHODS = new Set(['add', 'push', 'set', 'splice', 'unshift'])

export const singleUseMaterializationRule = defineRule({
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      const source = ctx.src.getText(target)
      const candidates = findMaterializationCandidates(target.file.path, source)

      if (candidates.length === 0) {
        return
      }

      const candidatePrompt = formatCandidatePrompt(candidates)
      let findings = await reviewRepository(ctx, target, {
        allowedCategories: SINGLE_USE_MATERIALIZATION_CATEGORIES,
        instructions: singleUseMaterializationInstructions,
        operation: 'single-use-materialization-review',
        prompt: `${singleUseMaterializationPrompt}\n\n${candidatePrompt}`,
      })

      if (findings.length === 0) {
        findings = await reviewRepository(ctx, target, {
          allowedCategories: SINGLE_USE_MATERIALIZATION_CATEGORIES,
          instructions: singleUseMaterializationInstructions,
          operation: 'single-use-materialization-verification',
          prompt: `${singleUseMaterializationVerificationPrompt}\n\n${candidatePrompt}`,
        })
      }

      for (const finding of findings) {
        ctx.report({
          evidence: {
            category: finding.category,
            ...(finding.futureFailure ? { futureFailure: finding.futureFailure } : {}),
            proof: finding.proof,
            relatedLocations: finding.relatedLocations,
            suggestion: finding.suggestion,
          },
          filePath: target.file.path,
          loc: { start: { column: 0, line: finding.line } },
          message: finding.message,
        })
      }
    },
  }),
})

function containsIdentifier(value: unknown, name: string): boolean {
  if (!isSyntaxNode(value)) {
    return false
  }

  if (identifierName(value) === name) {
    return true
  }

  return childSyntaxNodes(value).some(child => containsIdentifier(child, name))
}

function findMaterializationCandidates(filePath: string, source: string): { line: number, text: string }[] {
  const program = parseProgram(filePath, source)

  if (!program) {
    return []
  }

  const candidates: SyntaxNode[] = []

  visitSyntax(program, (node) => {
    if (node.type !== 'VariableDeclarator') {
      return
    }

    const id = isSyntaxNode(node.id) ? node.id : undefined
    const initializer = isSyntaxNode(node.init) ? node.init : undefined
    const name = id?.type === 'Identifier' && typeof id.name === 'string' ? id.name : undefined

    if (!name || !initializer || !isCollectionProducer(initializer)) {
      return
    }

    const producerMutations: SyntaxNode[] = []
    const consumers: SyntaxNode[] = []

    visitSyntax(program, (candidate) => {
      if ((candidate.start ?? 0) <= (node.end ?? 0)) {
        return
      }

      if (isCollectionMutation(candidate, name)) {
        producerMutations.push(candidate)
      }

      if (isCollectionConsumer(candidate, name)) {
        consumers.push(candidate)
      }
    })

    if (consumers.length > 0) {
      candidates.push(node, ...producerMutations, ...consumers)
    }
  })

  return sourceLinesForNodes(source, candidates)
}

function formatCandidatePrompt(candidates: readonly { line: number, text: string }[]): string {
  return [
    'The following target collection-flow syntax was extracted mechanically. It is evidence to investigate, not a conclusion:',
    JSON.stringify(candidates),
  ].join('\n')
}

function identifierName(node: unknown): string | undefined {
  return isSyntaxNode(node) && node.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : undefined
}

function isCollectionConsumer(node: { [key: string]: unknown, type: string }, name: string): boolean {
  if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && containsIdentifier(node.right, name)) {
    return true
  }

  if (node.type === 'SpreadElement' && identifierName(node.argument) === name) {
    return true
  }

  if (node.type !== 'CallExpression' || !isSyntaxNode(node.callee)) {
    return false
  }

  const member = node.callee

  if (member.type === 'MemberExpression') {
    const objectName = identifierName(member.object)
    const methodName = identifierName(member.property)

    if (objectName === name && methodName && COLLECTION_CONSUMER_METHODS.has(methodName)) {
      return true
    }

    if (objectName === 'Array' && methodName === 'from' && Array.isArray(node.arguments)) {
      return node.arguments.some(argument => containsIdentifier(argument, name))
    }
  }

  return false
}

function isCollectionMutation(node: { [key: string]: unknown, type: string }, name: string): boolean {
  if (node.type !== 'CallExpression' || !isSyntaxNode(node.callee) || node.callee.type !== 'MemberExpression') {
    return false
  }

  const objectName = identifierName(node.callee.object)
  const methodName = identifierName(node.callee.property)

  return objectName === name && methodName !== undefined && COLLECTION_MUTATION_METHODS.has(methodName)
}

function isCollectionProducer(node: { [key: string]: unknown, type: string }): boolean {
  if (node.type === 'ArrayExpression' || node.type === 'CallExpression') {
    return true
  }

  if (node.type !== 'NewExpression') {
    return false
  }

  return ['Array', 'Map', 'Set', 'WeakMap', 'WeakSet'].includes(identifierName(node.callee) ?? '')
}
