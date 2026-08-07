import type { SourceRange, SourceTarget, SourceTargetKind } from './types'

/** A target's identity from its position. */
export function targetIdentity(kind: SourceTargetKind, name: string | undefined, range: SourceRange): string {
  return `${kind}:${name ?? 'anonymous'}:${range.start}:${range.end}`
}

/**
 * Swaps a target's positional identity for its name, where that name is unique among these targets.
 *
 * Caches are keyed by identity, so a function that only moved should keep the identity it had. Two
 * targets sharing a name cannot be told apart by name, so those keep the positional form.
 *
 * Run every function and class target through this. Miss it in one language and the same function
 * gets a different identity depending on which language read it.
 */
export function withStableIdentities(targets: readonly SourceTarget[]): SourceTarget[] {
  const nameCounts = new Map<string, number>()

  for (const target of targets) {
    const identity = nameIdentity(target)

    if (identity) {
      nameCounts.set(identity, (nameCounts.get(identity) ?? 0) + 1)
    }
  }

  return targets.map((target) => {
    const identity = nameIdentity(target)

    if (!identity || nameCounts.get(identity) !== 1) {
      return target
    }

    return {
      ...target,
      identity,
    }
  })
}

function nameIdentity(target: SourceTarget): string | undefined {
  if ((target.kind !== 'class' && target.kind !== 'function') || !target.name) {
    return undefined
  }

  return `${target.kind}:${target.name}`
}
