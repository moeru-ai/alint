export const noRawSqlBypassingEntInstructions = `
Review the target for Ent schema bypasses in Go code.

Use repository search tools and read relevant definitions before reporting. This is an Ent-specific and SQL-specific opt-in rule: only report when the repository visibly uses generated Ent schema/query APIs for the same storage area, and the target bypasses that owner with raw SQL access or a raw SQL escape hatch.

Evidence ladder:
1. Establish that the repository has generated Ent schema/query ownership for the storage area under review. Read the relevant generated package, schema package, model package, or Ent client wrapper far enough to identify the typed owner.
2. Inspect the target for raw SQL capability exposure or use: returning the underlying database handle, returning the configured SQL dialect for caller branching, calling raw query/exec APIs, embedding SQL statements, or constructing table/field SQL fragments that run outside Ent's generated query/mutation pipeline.
3. Compare the raw SQL path with the typed Ent path. Report only when the raw SQL path re-encodes table names, field names, predicates, joins, ordering, updates, locking, pagination, or status transitions that should be expressed through the generated schema owner or fixed by improving that schema/model layer.
4. For CTEs, subqueries, dialect branches, or lock-specific SQL, do not assume raw SQL is acceptable. Ask whether the schema/model layer should expose a deeper operation, predicate, edge, index, hook, mutation helper, transaction primitive, or repository method instead.

Every finding must:
- anchor its primary line in the target file
- include repository evidence for the Ent/generated schema owner or the escape hatch consumer
- format every related location as an exact repo-relative path:line citation with a one-based line number
- describe futureFailure as a concrete asymmetric edit -> schema/raw SQL divergence -> storage or behavior impact sequence
- provide concrete remediation direction, usually to remove the escape hatch or move the operation behind a schema/model/storage owner

Submit an empty review when Ent ownership is not established, the code is generated/test/fixture/migration-only, or the raw SQL is already contained inside a focused datastore primitive whose callers do not see SQL handles, dialect decisions, or table/field knowledge.

Ent custom predicates are not raw SQL bypasses by themselves. Do not report code that uses Ent's generated predicate hook, such as predicate.<Entity>(func(selector *sql.Selector) { ... }), when the selector only feeds a generated Query().Where(...), Mutation.Where(...), or generated order option and execution still goes through Ent. Report it only if the code also exposes SQL handles/fragments to callers or executes raw SQL outside Ent.
`.trim()

export const noRawSqlBypassingEntPrompt = `
Review the target for raw SQL bypasses generated Ent schema ownership.

Categories:
- escape-hatch: the target exposes low-level SQL capability, such as an underlying database handle or dialect selector, that enables callers to bypass Ent's generated schema/query boundary.
- schema-bypass: the target directly implements a storage operation with raw SQL even though the repository has an Ent schema/model owner that should express or own the operation.

Report warning-level design findings when raw SQL leaks table/field/query/update knowledge into a layer that should depend on Ent's generated schema or a focused model/storage abstraction.

Do not report:
- Ent-generated code
- schema declarations, migrations, bootstrap setup, health checks, or connection lifecycle inside the datastore owner
- tests, fixtures, or one-off migration scripts
- storage procedures that are deliberately database-owned APIs and are called through a narrow repository method
- raw SQL fully hidden behind a focused datastore primitive whose public interface does not expose SQL handles, dialect branching, table names, field names, or query fragments
- Ent custom predicate hooks such as predicate.<Entity>(func(selector *sql.Selector) { ... }) when they remain inside generated Ent Query().Where(...), Mutation.Where(...), or order options
- generic transaction helpers that keep callers on Ent transactions or typed repository operations

Return warnings only. If the proof is incomplete, submit an empty review.
`.trim()
