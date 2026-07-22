import { bench } from 'vitest'

import { extractJsSourceTargets } from '../src/core/languages/js/public'
import { createSourceFile } from '../src/index'
import { createLargeFile, createManyFiles } from './data'

const smallFileFixtures = createManyFiles(1_000, 1)
const semanticTargetFixtures = createManyFiles(120, 80)
const largeFileFixture = createLargeFile(20 * 1024 * 1024)

// Fixture generation stays outside the timing boundary; public runtime construction and extraction remain measured.
bench('extracts 1,000 small files', () => {
  for (const fixture of smallFileFixtures) {
    extractJsSourceTargets(createSourceFile(fixture.path, fixture.text))
  }
})

bench('extracts 120 files with 80 functions each', () => {
  for (const fixture of semanticTargetFixtures) {
    extractJsSourceTargets(createSourceFile(fixture.path, fixture.text))
  }
})

bench('extracts one 20 MiB file', () => {
  extractJsSourceTargets(createSourceFile(largeFileFixture.path, largeFileFixture.text))
})
