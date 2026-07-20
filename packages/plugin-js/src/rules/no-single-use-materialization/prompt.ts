export const singleUseMaterializationInstructions = `
Review the target only for a collection that is produced once, consumed once immediately, and can be fused into its sole consumer without changing observable behavior.

Prove the maximal fusible region. Cover order, exception behavior, evaluation count and timing, mutation and identity, side effects, async or concurrency boundaries, validation ordering, and early exit. Reject the finding when later producer evaluations can throw, mutate, or perform side effects that the consumer's early exit would skip, unless the declared input contract and inspected implementation prove those evaluations observably irrelevant.

A high-signal shape is a producer loop that fills an intermediate array followed immediately by one consumer loop with an early exit. Continue past a one-expression temporary inside the consumer and inspect the preceding producer loop. When normalization is pure for declared inputs, fusion may intentionally skip later normalization after the same consumer early exit; this is valid and avoids unnecessary work. Do not invent Proxy getters or malformed runtime values outside the declared contract.

Suppress snapshots, sorting, grouping, dedupe, multiple consumers, named domain phases, validate-all-before-effects behavior, batching, fusion across async or concurrency boundaries, and readability staging that captures a real concept. Anchor the finding at the intermediate array declaration or producer loop, and report the maximal region once.
`.trim()

export const singleUseMaterializationPrompt = `
Report only single-use-materialization: a collection is produced once, consumed once immediately, and can be fused while preserving observable behavior.

Do not report merely because the target contains two loops. Trace the producer expression under the declared input contract, inspect a local helper when purity depends on it, and submit an empty review if the elimination proof is incomplete.
`.trim()

export const singleUseMaterializationVerificationPrompt = `
An earlier independent pass submitted a clean review for a target with mechanically extracted collection-flow candidates. Challenge that conclusion.

Trace each supplied declaration, producer, and consumer line as one possible maximal region. Try to prove single production, single immediate consumption, preserved order and exceptions, and whether an early-exiting consumer makes later pure production unnecessary. Submit a finding when the intermediate collection and extra pass are removable. Submit an empty review only after identifying a concrete observable behavior or intentional domain phase that requires materialization.
`.trim()
