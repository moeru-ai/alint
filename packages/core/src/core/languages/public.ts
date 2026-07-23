/*
 * Its own build entry rather than part of core's root, and it must stay that way: importing core's
 * root pulls the whole runtime — oxc-parser's N-API loader included — into anything that bundles
 * it. Re-exporting just this one function through the root instead takes the `@alint-js/plugin`
 * facade's dist from roughly 55 lines and a single import to roughly 2900 lines needing
 * `createRequire`. Same reason `@alint-js/core/agent` exists.
 */

export { requireLanguage } from './require'
