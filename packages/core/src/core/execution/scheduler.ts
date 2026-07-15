export async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new TypeError('Rule execution concurrency must be a positive integer')

  const results = new Array<T>(tasks.length)
  let cursor = 0
  let firstError: Error | undefined

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await tasks[index]!()
      }
      catch (error) {
        firstError ??= normalizeError(error)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  )
  if (firstError)
    throw firstError
  return results
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error)
    return error
  return new Error(error != null ? String(error) : 'Unknown rule execution infrastructure error.')
}
