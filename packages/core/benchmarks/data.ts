import { Buffer } from 'node:buffer'

export interface SourceFixture {
  path: string
  text: string
}

export function createLargeFile(bytes: number): SourceFixture {
  const line = 'export const value = 1\n'
  const lineBytes = Buffer.byteLength(line)
  const fullLines = Math.floor(bytes / lineBytes)
  const padding = bytes % lineBytes

  return {
    path: 'src/large.ts',
    text: `${line.repeat(fullLines)}${' '.repeat(padding)}`,
  }
}

export function createManyFiles(count: number, functionsPerFile: number): SourceFixture[] {
  return Array.from({ length: count }, (_, fileIndex) => ({
    path: `src/file-${fileIndex}.ts`,
    text: Array.from(
      { length: functionsPerFile },
      (_, functionIndex) => `export function value_${fileIndex}_${functionIndex}() { return ${functionIndex} }`,
    ).join('\n'),
  }))
}
