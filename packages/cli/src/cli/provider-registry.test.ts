import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { probeModels } from './provider-registry'

const invalidResponseMessage = 'Expected OpenAI-compatible models response with data array.'

async function withJsonServer<T>(body: unknown, run: (endpoint: string) => Promise<T>): Promise<T> {
  const server = createServer((_request, response) => {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new TypeError('Expected TCP test server address.')
  }

  try {
    return await run(`http://127.0.0.1:${address.port}/v1/`)
  }
  finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }
}

describe('probeModels', () => {
  it.each([
    { body: null, label: 'null' },
    { body: [], label: 'an array body' },
    { body: {}, label: 'an object without data' },
    { body: { data: null }, label: 'null data' },
    { body: { data: {} }, label: 'non-array data' },
  ])('rejects $label with the stable response-shape error', async ({ body }) => {
    await withJsonServer(body, async (endpoint) => {
      await expect(probeModels(endpoint)).rejects.toThrowError(
        new TypeError(invalidResponseMessage),
      )
    })
  })

  it.each([null, 'model', 42])(
    'rejects a non-object data member %j with the stable response-shape error',
    async (member) => {
      await withJsonServer({ data: [member] }, async (endpoint) => {
        await expect(probeModels(endpoint)).rejects.toThrowError(
          new TypeError(invalidResponseMessage),
        )
      })
    },
  )

  it('filters object members whose id is absent or non-string', async () => {
    await withJsonServer({
      data: [
        {},
        { id: null },
        { id: 42 },
        { id: '' },
        { id: 'valid' },
      ],
    }, async (endpoint) => {
      await expect(probeModels(endpoint)).resolves.toEqual(['valid'])
    })
  })
})
