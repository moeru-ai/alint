export function parseArgs(values: string[]): Record<string, any> {
  const parsed = new Map<string, any>()

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]

    if (value === '--') {
      continue
    }

    if (!value.startsWith('--')) {
      continue
    }

    const [key, inlineValue] = value.slice(2).split('=', 2)
    const nextValue = inlineValue ?? values[index + 1]

    if (!nextValue || nextValue.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    parsed.set(key, nextValue)

    if (inlineValue === undefined) {
      index += 1
    }
  }

  return Object.fromEntries(parsed)
}

export function requiredArg(args: Record<string, any>, name: string): string {
  const value = args[name]
  if (!value) {
    throw new Error(`Missing required argument --${name}`)
  }

  return value
}
