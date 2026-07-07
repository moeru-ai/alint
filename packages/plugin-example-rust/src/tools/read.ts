import { readFile as readNodeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function readFile(cwd: string, inputPath: string | undefined): Promise<string> {
  if (!inputPath) {
    throw new TypeError('Expected file path')
  }

  return readNodeFile(resolve(cwd, inputPath), 'utf8')
}
