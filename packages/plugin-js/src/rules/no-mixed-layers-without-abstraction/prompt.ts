export const mixedLayersWithoutAbstractionPrompt = `
You are reviewing one JavaScript or TypeScript source file.

Task:
Warn when a consuming feature owns several layers of an external integration without a stable abstraction.

This is a warning-level design smell, not a correctness error. Do not report a file because it is long, has many helpers, imports an SDK, or contains one external call.

Core standard:
An external integration should expose reusable operations in terms meaningful to callers. A stable abstraction hides lower-level request and response shapes, transport or protocol changes, provider failure semantics, and mechanical interpretation that callers should not reconstruct.

A wrapper does not earn an abstraction merely by forwarding arguments, renaming a method, or moving code to another file. It earns the boundary when another feature can call it without importing the current consumer or understanding lower-level integration details.

First determine whether all of these conditions are visible in the reviewed file:
- the file directly accesses an external capability through an SDK, API, service, connection, or low-level library
- at least two responsibilities in that integration can change or be reused independently
- those responsibilities are embedded in a consuming feature or service
- the consumer understands lower-level request, response, failure, or protocol details to complete its own work

Before reporting, identify the focused owner the suggestion would create:
- Suppress only if that owner already exists in the reviewed source as a stable boundary: a semantic interface callable from outside the current consuming feature without importing or understanding that consumer and whose callers do not need the lower-level knowledge.
- The presence of a container or construction helper is not sufficient evidence of that boundary.
- Multiple cohesive implementation steps inside that owner do not by themselves establish mixed ownership.
- Suppress the finding when the suggestion would only rename, re-extract, or recreate that existing boundary, or move cohesive internals behind materially the same interface.
- Still report when the existing boundary embeds a separate consuming workflow or policy, leaks lower-level details to callers, or owns responsibilities outside its promised boundary that can change or be reused independently.

Reason from data flow rather than identifiers:
external capability access -> low-level operations -> integration-level semantics -> interpretation or reshaping of external data -> consumer-specific selection, policy, or representation.

Do not require a fixed number of layers. Some external libraries already own transport and protocol details; others expose only a raw connection. Report only the responsibilities the reviewed file visibly owns.

Qualifying responsibilities include:
- constructing or adapting access to an external capability inside the consumer
- defining low-level requests or operations beside the consuming workflow
- repeatedly translating low-level calls into operations that would be meaningful to other callers
- interpreting loose external responses into stable data the consumer relies on
- mixing reusable integration behavior with selection, ranking, truncation, policy, or representation specific to the current feature

Finding granularity:
- Separate the boundary decision from finding granularity.
- If no stable abstraction is missing, return no findings.
- Once a missing boundary is established, keep each declaration as a primary finding when it independently owns external access, a reusable integration operation, response interpretation or adaptation, or consumer-specific policy.
- After qualification, report every primary declaration that meets that standard, even when several declarations should move into the same focused owner.
- Every primary finding must materially participate in the identified missing boundary or responsibility flow.
- Do not report a declaration merely because it coexists in a source that otherwise qualifies.
- Its suggestion or relatedDeclarations must show how it belongs to that cluster: move with another declaration, call through the boundary, or remove a direct dependency.
- A primary declaration may be a function, method, operation definition, or policy declaration.
- Put supporting types and constants in relatedDeclarations unless they independently own an operation or policy.
- relatedDeclarations may cue supporting declarations and cooperation, movement, or call relationships between primary findings, but must not replace a primary finding for an independently owned operation, adaptation, or policy.
- Do not replace declaration findings with one file-level summary.
- Each suggestion must name the declarations that belong together, the focused owner they should form, and the lower-level knowledge its interface should remove from the consumer.
- Use relatedDeclarations to cue declarations that should move together, call through the proposed boundary, or stop depending on each other directly.

Do not report:
- a focused integration module that wraps an external library and owns closely related adaptation
- a consumer that only calls stable semantic operations
- a simple one-off external call that has not formed a reusable responsibility cluster
- cohesive authentication, retry, pagination, decoding, or failure behavior inside the focused owner that promises those semantics
- adjacent implementation steps with one reason to change
- shallow wrappers that would add navigation without hiding knowledge
- a missing abstraction inferred only from repository context that is not present

Do not key findings on exact function names, vendor names, protocol names, or directory names. The same responsibility flow should produce the same decision after identifiers and technologies are replaced.

Return warnings only. Suppress a finding when the evidence does not establish a reusable missing boundary. Use medium or low confidence for a visible smell whose intended ownership remains uncertain.
`.trim()
