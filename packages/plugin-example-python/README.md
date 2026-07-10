# @alint-js/plugin-example-python

Example `alint` plugin for semantic Python boundary review.

## What It Does

This package demonstrates how to review Python files before `alint` has a Python AST extractor. The example config targets `**/*.py` as `text/plain`, sends the whole file to a model-backed rule, and asks the model to report semantic-boundary smells that are hard to express with syntax-only checks.

The example rule focuses on Python design issues where raw external data, parsing, typed boundaries, orchestration, persistence, and format ownership are mixed in a way that makes code harder to test and evolve.

## How To Use

```ts
import pythonPlugin from '@alint-js/plugin-example-python'

export default [
  {
    plugins: {
      python: pythonPlugin,
    },
  },
  ...pythonPlugin.configs.example,
]
```

```ts
import { createPythonPlugin } from '@alint-js/plugin-example-python'

const pythonPlugin = createPythonPlugin()

export default [
  {
    plugins: {
      python: pythonPlugin,
    },
  },
  ...pythonPlugin.configs.example,
]
```

## When To Use It

Use this example when you want to inspect Python source with a natural-language architectural rule:

- flag raw external response shapes leaking beyond the adapter edge
- suggest typed boundary objects for stable downstream contracts
- suggest moving parsing and output formatting into cohesive domain objects
- surface orchestration methods that also own source compatibility and presentation formats

## When Not To Use It

Do not use this as a substitute for a future Python language extractor when you need symbol-accurate navigation, interpreter diagnostics, or AST-level transformations. This plugin intentionally relies on prompt-based judgment and structured model output.
