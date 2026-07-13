import type { ExtractLanguage } from './types'

/*
 * Captures `extract.ts` dispatches on:
 *
 * - `@function`: the node holding a function's name and its body; the name is read from its `name` field.
 * - `@comment`, `@call`
 * - `@identifier`: names that MAY be renamed away.
 * - `@binder`: names the function DECLARES.
 * - `@anchor`: never-renameable names a grammar spells like renameable ones. Subtracted from `@identifier`.
 * - `@export`: a local name an export list makes reachable. TypeScript only.
 *
 * A copy can rename what a helper declares, not what it refers to, so callees, globals, types and
 * properties stay verbatim and anchor the fingerprint. Blind them and `return this.name` and
 * `return this.size` hash alike.
 */

/** Go spells a struct field and a method name alike, so `field_identifier` is never renameable. */
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
 * Python spells an attribute and a keyword argument as bare identifiers, so both are anchored: rename
 * them and `entry.name` collides with `entry.size`.
 *
 * A docstring is captured as a comment, so it is neither counted as a statement nor hashed. The `.`
 * anchor pins it to the body's first statement, which is what makes it a docstring (PEP 257).
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

/*
 * TypeScript, reused by TSX and JavaScript. An arrow or function expression is captured on its
 * `variable_declarator`, the one node holding both the name and the function; `name: (identifier)`
 * turns away `const { parse } = handlers` and `value:` turns away `const total = 5`. The `!source`
 * negation drops re-exports like `export { foo } from './other'`.
 *
 * PITFALL: `shorthand_property_identifier_pattern` is deliberately neither an identifier nor a binder.
 * In `const { title } = entry` that token is both the property read and the local declared, so blinding
 * it as a binder makes `{ title }` and `{ author }` accessors fingerprint alike.
 */
const TYPESCRIPT = `
(function_declaration) @function
(method_definition) @function
(variable_declarator name: (identifier) value: (arrow_function)) @function
(variable_declarator name: (identifier) value: (function_expression)) @function
(comment) @comment
(call_expression function: (identifier) @call)
(call_expression function: (member_expression property: (property_identifier) @call))
(identifier) @identifier

(export_statement !source (export_clause (export_specifier name: (identifier) @export)))
(export_statement value: (identifier) @export)

(function_declaration name: (identifier) @binder)
(function_expression name: (identifier) @binder)
(required_parameter pattern: (identifier) @binder)
(optional_parameter pattern: (identifier) @binder)
(arrow_function parameter: (identifier) @binder)
(variable_declarator name: (identifier) @binder)
(catch_clause parameter: (identifier) @binder)
(pair_pattern value: (identifier) @binder)
(array_pattern (identifier) @binder)
(rest_pattern (identifier) @binder)
`

const QUERY: Record<ExtractLanguage, string> = {
  go: GO,
  javascript: TYPESCRIPT,
  python: PYTHON,
  rust: RUST,
  tsx: TYPESCRIPT,
  typescript: TYPESCRIPT,
}

export function querySource(language: ExtractLanguage): string {
  return QUERY[language]
}
