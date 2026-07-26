import type { LanguageId } from './grammar'

/*
 * The captures `extract.ts` reads, and what each one becomes:
 *
 * - `@function` — the node holding a function's name and body, both read from its fields.
 * - `@comment` — `commentRanges`, and kept out of the body's statement count.
 * - `@call` — the `CallSite`s on the file target.
 * - `@binder` — `declaredNames`: the names the function itself declares.
 * - `@identifier` — `identifierRanges`: names that may be renamed away.
 * - `@anchor` — names a grammar spells like a renameable identifier but which are not. Subtracted
 *   from `@identifier`.
 *
 * Splitting `@identifier` from `@anchor` is the delicate part, and the reason each language below
 * needs its own rules rather than one generic query. Core's `FunctionInfo.identifierRanges` doc
 * explains what goes wrong when a property or field read ends up in the renameable set.
 */

/** Go spells a struct field and a method name the same way, so `field_identifier` never joins `@identifier`. */
const GO = `
(function_declaration) @function
(method_declaration) @function
(comment) @comment
(call_expression function: (identifier) @call)
(call_expression function: (selector_expression field: (field_identifier) @call))
(identifier) @identifier

(function_declaration name: (identifier) @binder)
(parameter_declaration name: (identifier) @binder)
(variadic_parameter_declaration name: (identifier) @binder)
(short_var_declaration left: (expression_list (identifier) @binder))
(var_spec name: (identifier) @binder)
(const_spec name: (identifier) @binder)
(range_clause left: (expression_list (identifier) @binder))
`

/*
 * Python writes an attribute and a keyword argument as bare identifiers, so both are anchored.
 * Without that, `entry.name` and `entry.size` become the same function once names are renamed away.
 *
 * A docstring is captured as a comment, which keeps it out of both the statement count and
 * `identifierRanges`. The `.` pins the pattern to the body's first statement, which is what makes a
 * string a docstring (PEP 257).
 */
const PYTHON = `
(function_definition) @function
(comment) @comment
(function_definition body: (block . (expression_statement (string) @comment)))
(call function: (identifier) @call)
(call function: (attribute attribute: (identifier) @call))
(identifier) @identifier
(attribute attribute: (identifier) @anchor)
(keyword_argument name: (identifier) @anchor)

(function_definition name: (identifier) @binder)
(parameters (identifier) @binder)
(default_parameter name: (identifier) @binder)
(typed_parameter (identifier) @binder)
(typed_default_parameter name: (identifier) @binder)
(assignment left: (identifier) @binder)
(for_statement left: (identifier) @binder)
(lambda_parameters (identifier) @binder)
`

/** `macro_invocation` (`println!`, `vec!`) is not a `call_expression`, so macros are not counted as calls. */
const RUST = `
(function_item) @function
(line_comment) @comment
(block_comment) @comment
(call_expression function: (identifier) @call)
(call_expression function: (field_expression field: (field_identifier) @call))
(call_expression function: (scoped_identifier name: (identifier) @call))
(identifier) @identifier

(function_item name: (identifier) @binder)
(parameter pattern: (identifier) @binder)
(let_declaration pattern: (identifier) @binder)
(closure_parameters (identifier) @binder)
`

export const QUERIES: Record<LanguageId, string> = {
  go: GO,
  python: PYTHON,
  rust: RUST,
}
