import type { Buffer } from 'node:buffer'

import { createHash } from 'node:crypto'

const SUPPORTED_INTEGRITY_ALGORITHMS = ['sha512', 'sha256'] as const
const SUPPORTED_INTEGRITY_TOKEN_PATTERN = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/u

interface IntegrityToken {
  algorithm: SupportedIntegrityAlgorithm
  expected: string
}

type SupportedIntegrityAlgorithm = typeof SUPPORTED_INTEGRITY_ALGORITHMS[number]

export function checkIntegrity(data: Buffer, integrity: string, specifier: string): void {
  const result = parseIntegrity(integrity, specifier)

  const matches = result.tokens.some(({ algorithm, expected }) => {
    if (algorithm !== result.strongestAlgorithm) {
      return false
    }

    const actual = createHash(algorithm).update(data).digest('base64')
    return actual === expected
  })

  if (!matches) {
    throw new Error(`Integrity mismatch for "${specifier}".`)
  }
}

export function parseIntegrity(integrity: string, specifier: string): {
  strongestAlgorithm: SupportedIntegrityAlgorithm
  tokens: IntegrityToken[]
} {
  const tokens = integrity
    .trim()
    .split(/\s+/u)
    .map(token => SUPPORTED_INTEGRITY_TOKEN_PATTERN.exec(token))
    .filter(match => match !== null)
    .map(([, algorithm, expected]) => ({
      algorithm: algorithm as SupportedIntegrityAlgorithm,
      expected,
    }))

  const strongestAlgorithm = SUPPORTED_INTEGRITY_ALGORITHMS.find(algorithm =>
    tokens.some(token => token.algorithm === algorithm),
  )

  if (strongestAlgorithm === undefined) {
    throw new Error(`Unsupported npm integrity format for "${specifier}": "${integrity}".`)
  }

  return {
    strongestAlgorithm,
    tokens,
  }
}
