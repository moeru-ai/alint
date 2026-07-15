const retryableTransportCodes = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

export function isRetryableApeiraFailure(error: unknown): boolean {
  const seen = new Set<object>()
  let candidate = error

  while (isObject(candidate) && !seen.has(candidate)) {
    seen.add(candidate)

    if (readProperty(candidate, 'name') === 'AbortError') {
      return false
    }

    const statusCode = readProperty(candidate, 'statusCode')
    if (
      typeof statusCode === 'number'
      && (statusCode === 408 || statusCode === 429 || (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599))
    ) {
      return true
    }

    const code = readProperty(candidate, 'code')
    if (typeof code === 'string' && retryableTransportCodes.has(code)) {
      return true
    }

    candidate = readProperty(candidate, 'cause')
  }

  return false
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
