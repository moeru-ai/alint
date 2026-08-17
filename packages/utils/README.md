# `@alint-js/utils`

Small shared utilities with explicit runtime boundaries for alint packages.

## Usage

```ts
import { isNodeErrorCode } from '@alint-js/utils/node'

if (isNodeErrorCode(error, 'ENOENT')) {
  // Handle a missing path.
}
```

## When to use

- Use the Node entrypoint when several packages need the same Node-specific utility.

## When not to use

- Do not add package-local helpers or browser-specific code here.
- Do not use it as a general-purpose collection of unrelated utilities.
