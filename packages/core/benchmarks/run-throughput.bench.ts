import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, bench } from 'vitest'

import { defineConfig, definePlugin, defineRule, runAlint } from '../src/index'
import { createManyFiles } from './data'

const fixtures = createManyFiles(100, 1)
const files = fixtures.map(fixture => fixture.path)
const setupConfig = { providers: [], version: 1 } as const
const rule = defineRule({
  cache: true,
  create: () => ({
    onTargetFile: () => {},
  }),
})
const config = defineConfig([
  {
    plugins: {
      benchmark: definePlugin({ rules: { noop: rule } }),
    },
    rules: { 'benchmark/noop': 'warn' },
  },
])

let cachePath: string
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'alint-run-throughput-'))
  cachePath = join(root, '.alintcache')

  await mkdir(join(root, 'src'))
  await Promise.all(fixtures.map(fixture =>
    writeFile(join(root, fixture.path), fixture.text),
  ))
})

afterAll(async () => {
  await rm(root, { force: true, recursive: true })
})

// NOTICE: Vitest 4 exposes cycle-level setup, not an untimed per-sample hook, so cold samples include cache eviction.
bench('cold file targets', async () => {
  await rm(cachePath, { force: true })
  await runAlint({ config, cwd: root, files, projectTargets: false, setupConfig })
})

bench('warm file targets', async () => {
  await runAlint({ config, cwd: root, files, projectTargets: false, setupConfig })
}, {
  setup: async () => {
    await rm(cachePath, { force: true })
    await runAlint({ config, cwd: root, files, projectTargets: false, setupConfig })
  },
})
