import { Buffer } from 'node:buffer'
import { readdir } from 'node:fs/promises'

import { x } from 'tinyexec'

const startupTimeoutMs = 60_000
const stderrExcerptLimitBytes = 4 * 1024
const stderrTruncationMarker = '\n... stderr truncated ...\n'

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  const execution = x('git', ['rev-parse', '--show-toplevel'], commandOptions(cwd))
  const result = await execution

  if (execution.killed) {
    throw new Error('Git root discovery exceeded the 1 minute startup limit.')
  }

  if (result.exitCode !== 0) {
    return undefined
  }

  return result.stdout.trim() || undefined
}

export async function hasProjectConfig(gitRoot: string): Promise<boolean> {
  const entries = await readdir(gitRoot, { withFileTypes: true })

  return entries.some(entry => entry.isFile() && entry.name.startsWith('alint.config.'))
}

export async function isHeadDetached(gitRoot: string): Promise<boolean> {
  const execution = x('git', ['symbolic-ref', '--quiet', 'HEAD'], commandOptions(gitRoot))
  const result = await execution

  if (execution.killed) {
    throw new Error('Git HEAD inspection exceeded the 1 minute startup limit.')
  }

  if (result.exitCode === 0) {
    return false
  }

  if (result.exitCode === 1) {
    return true
  }

  const detail = truncateStderr(result.stderr.trim())
  throw new Error(detail.length === 0
    ? `Git HEAD inspection failed with exit code ${result.exitCode ?? 'unknown'} and produced no stderr output.`
    : `Git HEAD inspection failed with exit code ${result.exitCode ?? 'unknown'}: ${detail}`)
}

function commandOptions(cwd: string) {
  return {
    nodeOptions: { cwd },
    nodePath: false,
    timeout: startupTimeoutMs,
  } as const
}

function truncateStderr(stderr: string): string {
  const bytes = Buffer.from(stderr, 'utf8')

  if (bytes.length <= stderrExcerptLimitBytes) {
    return stderr
  }

  const markerBytes = Buffer.byteLength(stderrTruncationMarker)
  const excerptBytes = stderrExcerptLimitBytes - markerBytes
  const headBytes = Math.ceil(excerptBytes / 2)
  const tailBytes = Math.floor(excerptBytes / 2)
  let headEnd = headBytes
  let tailStart = bytes.length - tailBytes

  // Byte budgets may land inside a UTF-8 continuation sequence. Move both cuts inward so the
  // excerpt never substitutes a split code point with U+FFFD or exceeds the agreed byte limit.
  while (headEnd > 0 && ((bytes[headEnd] ?? 0) & 0xC0) === 0x80) {
    headEnd -= 1
  }
  while (tailStart < bytes.length && ((bytes[tailStart] ?? 0) & 0xC0) === 0x80) {
    tailStart += 1
  }

  return `${bytes.toString('utf8', 0, headEnd)}${stderrTruncationMarker}${bytes.toString('utf8', tailStart)}`
}
