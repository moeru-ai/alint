export const redundantCatchInstructions = `
Review the target only for catch blocks that are removable because the protected expression already guarantees the same normalized error contract.

Inspect every target try/catch. When a try returns or awaits an imported or local helper, use repository search and read_file to inspect that helper and the domain-error definition. Build an explicit exit table covering successful return, domain errors, other callback errors, and errors from retry delay, cleanup, or helper internals. Cite the exact repo-relative path:line that proves the callee's error postcondition.

A high-signal shape is \`try { return await retryOrNormalizationHelper(callback, descriptor) } catch (error) { ... }\` when the helper rethrows the domain error and wraps every remaining callback error with the same descriptor, while the outer catch preserves domain-error identity and wraps its non-domain branch with the same descriptor. Compare every descriptor field. When they match and the helper exposes no other real error exit, the outer non-domain branch is unreachable and the whole catch is removable.

Use the declared runtime contract. Do not invent Proxy getters, constructor failures, or Promise rejection when the inspected implementation contains no such reject path. Do suppress a catch that performs cleanup, telemetry, retry, rollback, resource lifecycle work, cause conversion, metadata conversion, or any observably different error mapping. Also suppress when any callee exit remains unknown or can produce a non-domain error.

Removing the catch must preserve return values; thrown error type, message, metadata, cause, and identity; evaluation count and timing; ordering; side effects; async behavior; and cancellation. A standalone await is not a suppression: compare actual error exits. Anchor one finding at the line where the removable try/catch begins.
`.trim()

export const redundantCatchPrompt = `
Report only redundant-catch: an outer catch adds no behavior because the protected callee already normalizes every real error exit to the same domain-error contract.

Do not report merely because a catch rethrows. Prove the imported or local callee's full error postcondition, compare all error metadata, and submit an empty review if the proof is incomplete.
`.trim()

export const redundantCatchVerificationPrompt = `
An earlier independent pass submitted a clean review for a target that contains catch candidates. Challenge that conclusion rather than trusting it.

For every supplied candidate line, trace the protected call into its implementation and try to prove that the catch's non-domain branch is unreachable. Submit a redundant-catch finding when the callee already preserves domain-error identity and normalizes every other real exit with the same metadata. Submit an empty review only after identifying a concrete reachable behavior the outer catch adds, or a concrete proof gap that repository reads cannot resolve.
`.trim()
