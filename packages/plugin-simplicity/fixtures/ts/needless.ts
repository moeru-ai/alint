interface Entry {
  name: string
  size: number
}

// Two helpers that do not earn their existence, and two that do. A rule that reports
// the first two and stays quiet about the last two is working; one that reports all
// four has only noticed that short functions are short.

// Stays silent. The name is the documentation: `clamp(x, 0, 1)` reads at a glance and
// `Math.min(Math.max(x, 0), 1)` has to be worked out.
export function clamp(value: number, low: number, high: number): number {
  // eslint-disable-next-line no-restricted-syntax
  return Math.min(Math.max(value, low), high)
}

export function describeEntry(value: unknown, raw: string): string {
  if (!isEntry(value)) {
    return String(parse(raw))
  }

  return `${value.name}: ${clamp(nameLength(value), 0, 1024)}`
}

// Stays silent, and this is the one a rule gets wrong. Inlining a type guard still runs
// the check, but the call site loses the named type it narrowed to.
function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && 'size' in value
}

// Report. `entry.name.length` is shorter than `nameLength(entry)` and says as much.
// It reads `.name` and not `.size` on purpose: `.size` would make it a renamed copy of
// `accessors.ts`, which is the other rule's job.
//
// The comment inside the body is the point of this one: every grammar reports a comment as a
// named child of the block, so counting it as a statement would take this helper to two and
// hide it from the rule.
function nameLength(entry: Entry): number {
  // The name's length.
  return entry.name.length
}

// Report. A pure forward that hides which parser is used, so the name tells a reader
// less than the body does.
function parse(text: string): unknown {
  return JSON.parse(text)
}

// `isEntry` is exported here rather than on its declaration, so the corpus covers the
// export an extractor is likeliest to miss: nothing on the declaration says it.
export { isEntry }
