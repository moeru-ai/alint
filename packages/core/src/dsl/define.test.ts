import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from './define'

describe('define helpers', () => {
  it('exposes all target lifecycle handlers from a rule', () => {
    const onTargetClass = () => {}
    const onTargetDirectory = () => {}
    const onTargetFile = () => {}
    const onTargetFunction = () => {}
    const onTargetProject = () => {}
    const rule = defineRule({
      create: () => ({
        onTargetClass,
        onTargetDirectory,
        onTargetFile,
        onTargetFunction,
        onTargetProject,
      }),
    })

    expect(rule.create({} as never)).toEqual({
      onTargetClass,
      onTargetDirectory,
      onTargetFile,
      onTargetFunction,
      onTargetProject,
    })
  })

  it('keeps flat config arrays unchanged', () => {
    const rule = defineRule({
      create: () => ({
        onTargetWith: () => {},
      }),
    })
    const plugin = definePlugin({
      rules: {
        review: rule,
      },
    })
    const config = defineConfig([
      {
        files: ['**/*.go'],
        plugins: { demo: plugin },
        rules: { 'demo/review': 'warn' },
      },
    ])

    expect(config).toEqual([
      {
        files: ['**/*.go'],
        plugins: { demo: plugin },
        rules: { 'demo/review': 'warn' },
      },
    ])
  })

  it('does not allow a catch-all handler alongside specialized handlers', () => {
    const create = () => ({
      onTargetFile: () => {},
      onTargetWith: () => {},
    })

    // @ts-expect-error catch-all and specialized handlers would execute the same target twice.
    const rule = defineRule({ create })

    expect(rule.create).toBe(create)
  })

  it('does not imply rule enablement from plugin registration', () => {
    const plugin = definePlugin({
      rules: {
        review: defineRule({ create: () => ({ onTargetWith: () => {} }) }),
      },
    })
    const [item] = defineConfig([{ plugins: { demo: plugin } }])

    expect(item).not.toHaveProperty('rules')
  })
})
