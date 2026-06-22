#!/usr/bin/env tsx

import process, { exit } from 'node:process'

let stopping = false

async function shutdown() {
  if (stopping)
    return

  stopping = true
  exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// eslint-disable-next-line no-console
console.log('Starting alint...')
