import test from 'node:test'
import assert from 'node:assert/strict'
import { PI_THINKING_LEVELS, sanitizeRuntimeOptions } from '../agents/computer/runtime-options.js'

test('runtime options keep only supported fields and trim scalar values', () => {
  assert.deepEqual(sanitizeRuntimeOptions({
    reasoningEffort: '  high  ',
    thinkingLevel: 'medium',
    provider: 'should-not-persist',
    arbitraryArgs: ['--dangerous'],
  }), {
    reasoningEffort: 'high',
    thinkingLevel: 'medium',
  })
})

test('runtime options reject unsafe reasoning strings and unknown Pi levels', () => {
  assert.deepEqual(sanitizeRuntimeOptions({
    reasoningEffort: 'high; rm -rf /',
    thinkingLevel: 'ultra-secret',
  }), {})
})

test('Pi thinking levels match the runtime contract', () => {
  assert.deepEqual([...PI_THINKING_LEVELS], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})
