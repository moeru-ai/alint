import { defineConfig } from 'bumpp'

export default defineConfig({
  all: true,
  commit: 'release: v%s',
  push: false,
  recursive: true,
  sign: false,
})
