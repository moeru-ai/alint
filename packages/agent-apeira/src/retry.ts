export function isRetryableApeiraFailure(error: unknown): boolean {
  const seen = new Set<object>()
  let candidate = error
  let retryable = false

  while (isObject(candidate) && !seen.has(candidate)) {
    seen.add(candidate)

    if (readProperty(candidate, 'name') === 'AbortError') {
      return false
    }

    // NOTICE: xsAI's APICallError exposes response statuses as `statusCode`. Revisit this read if its upstream contract changes:
    // `https://github.com/moeru-ai/xsai/blob/642bb49212083aca2e1d23df5e65a00116c1f4d0/packages/shared/src/error/index.ts#L56-L66`
    const statusCode = readProperty(candidate, 'statusCode')
    if (
      typeof statusCode === 'number'
      && (statusCode === 408 || statusCode === 429 || (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599))
    ) {
      retryable = true
    }

    candidate = readProperty(candidate, 'cause')
  }

  return retryable
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function readProperty(value: object, property: string): unknown {
  try {
    return Reflect.get(value, property)
  }
  catch {
    return undefined
  }
}
