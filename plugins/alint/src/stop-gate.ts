#!/usr/bin/env node

import type { HookDecision, HookInput, SessionState, StopGateEnvelope } from './types'

import process from 'node:process'

import { readFileSync } from 'node:fs'

import { errorMessageFrom } from '@moeru/std'

import { applyResult, hasReachedLintLimit, lintLimitDecision, runtimeFailureMessage } from './policy'
import { findGitRoot, hasProjectConfig, resolveAlintStopGate } from './runner'
import { createStateStore } from './state'

function emergencyDecision(input: HookInput | undefined, error: unknown): HookDecision {
  const message = runtimeFailureMessage(errorMessageFrom(error) ?? 'unknown error')

  return input?.stop_hook_active
    ? { systemMessage: message }
    : { decision: 'block', reason: message }
}

function emit(decision: HookDecision): void {
  if (Object.keys(decision).length > 0) {
    process.stdout.write(`${JSON.stringify(decision)}\n`)
  }
}

function emptyEnvelope(status: 'inactive' | 'runtime-error'): StopGateEnvelope {
  return {
    errorCount: 0,
    schemaVersion: 2,
    status,
    warningCount: 0,
  }
}

function readHookInput(): HookInput {
  const input = readFileSync(0, 'utf8').trim()
  return input.length === 0 ? {} : JSON.parse(input) as HookInput
}

function requiredString(value: string | undefined, message: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(message)
  }

  return value
}

let parsedInput: HookInput | undefined

Promise.resolve(readHookInput())
  .then((input) => {
    parsedInput = input
    return run(input)
  })
  .catch(error => emit(emergencyDecision(parsedInput, error)))

async function run(input: HookInput): Promise<void> {
  const sessionId = requiredString(input.session_id, 'Stop hook input did not include session_id.')
  const pluginData = requiredString(process.env.CLAUDE_PLUGIN_DATA, 'Codex did not provide CLAUDE_PLUGIN_DATA to the alint plugin.')
  const store = createStateStore(pluginData)
  const state = await store.load(sessionId)
  let result: Awaited<ReturnType<typeof runForInput>>

  try {
    result = await runForInput(input, sessionId, state)
  }
  catch (error) {
    result = {
      envelope: {
        ...emptyEnvelope('runtime-error'),
        message: errorMessageFrom(error) ?? '未知错误',
      },
    }
  }

  if (result.decision !== undefined) {
    emit(result.decision)
    return
  }

  const envelope = result.envelope ?? emptyEnvelope('runtime-error')
  const applied = applyResult(state, envelope)
  await store.save(sessionId, applied.state)
  emit(applied.decision)
}

async function runForInput(
  input: HookInput,
  sessionId: string,
  state: SessionState,
): Promise<{ decision?: HookDecision, envelope?: StopGateEnvelope }> {
  const gitRoot = await findGitRoot(input.cwd ?? process.cwd())

  if (gitRoot === undefined || !await hasProjectConfig(gitRoot)) {
    return { envelope: emptyEnvelope('inactive') }
  }

  const stopGate = await resolveAlintStopGate(gitRoot)

  if (!stopGate.enabled) {
    return { envelope: emptyEnvelope('inactive') }
  }

  if (hasReachedLintLimit(state)) {
    return { decision: lintLimitDecision(state) }
  }

  return { envelope: await stopGate.run(sessionId) }
}
