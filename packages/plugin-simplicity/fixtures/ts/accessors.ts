interface Entry {
  name: string
  size: number
}

// The pair `no-duplicated-helper` must not report: one shape, two questions. A property is
// not a name the function declares, so `.name` and `.size` stay in the fingerprint, and they
// are what tell the two apart.
export function readName(entry: Entry): string {
  return entry.name
}

export function readSize(entry: Entry): number {
  return entry.size
}
