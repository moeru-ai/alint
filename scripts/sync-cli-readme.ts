import { copyFile } from 'node:fs/promises'

await copyFile('README.md', 'packages/cli/README.md')
