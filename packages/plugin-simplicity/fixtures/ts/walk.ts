import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export function walkDirectory(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true })
  const found = entries.filter(entry => entry.isDirectory())

  return found.map(entry => join(root, entry.name))
}

// Graded by neither eval list, on purpose. The two do the same job with a different
// filter, no fingerprint matches them, and the agent has called it both ways across
// runs, so a pass or fail here would only measure noise.
export function walkFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true })

  return entries.filter(entry => entry.isFile()).map(entry => join(root, entry.name))
}
