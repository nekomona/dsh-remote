// Per-context id resolution (spec §2.1 / §2.3): agentContextId(exec) and
// sanitizeContextId(). Pure logic — no fs, no SSH, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentContextId, sanitizeContextId, GLOBAL_CONTEXT_ID } from '../lib/contexts.js'

test('agentContextId: exec.agent.id wins (=== session.id in the live runtime)', () => {
  const exec = { agent: { id: 'sess-1', session: { id: 'sess-1' } } }
  assert.equal(agentContextId(exec), 'sess-1')
})

test('agentContextId: falls back to exec.agent.session.id when agent.id is missing', () => {
  const exec = { agent: { session: { id: 'sess-2' } } }
  assert.equal(agentContextId(exec), 'sess-2')
})

test('agentContextId: no exec → __global__', () => {
  assert.equal(agentContextId(undefined), GLOBAL_CONTEXT_ID)
  assert.equal(agentContextId(null), GLOBAL_CONTEXT_ID)
  assert.equal(agentContextId({}), GLOBAL_CONTEXT_ID)
})

test('agentContextId: agentless exec (no agent) → __global__', () => {
  assert.equal(agentContextId({ callId: 'x', name: 'rw_info' }), GLOBAL_CONTEXT_ID)
})

test('agentContextId: undefined agent never throws', () => {
  assert.doesNotThrow(() => agentContextId({ agent: undefined }))
  assert.equal(agentContextId({ agent: undefined }), GLOBAL_CONTEXT_ID)
})

test('agentContextId: empty/whitespace ids are rejected → __global__', () => {
  assert.equal(agentContextId({ agent: { id: '' } }), GLOBAL_CONTEXT_ID)
  assert.equal(agentContextId({ agent: { id: '   ' } }), GLOBAL_CONTEXT_ID)
  assert.equal(agentContextId({ agent: { session: { id: '' } } }), GLOBAL_CONTEXT_ID)
})

test('agentContextId: exotic ids are sanitized (no path separators survive)', () => {
  assert.equal(agentContextId({ agent: { id: 'a/b\\c:d' } }), 'a_b_c_d')
  assert.equal(agentContextId({ agent: { id: 'a/b\\c:d', session: { id: 'a/b\\c:d' } } }), 'a_b_c_d')
})

test('agentContextId: real UUID session ids pass through untouched', () => {
  const id = '6f9c1a2e-0b3d-4e5f-9a8b-1c2d3e4f5a6b'
  assert.equal(agentContextId({ agent: { id, session: { id } } }), id)
})

test('sanitizeContextId: the encodeSegmentSafe rule', () => {
  // alnum + _ . - survive; everything else becomes _
  assert.equal(sanitizeContextId('a/b\\c:d'), 'a_b_c_d')
  assert.equal(sanitizeContextId('a_b-c.d'), 'a_b-c.d')
  assert.equal(sanitizeContextId('x y z'), 'x_y_z')
  assert.equal(sanitizeContextId('üñî©öðé'), '_______') // 7 chars → 7 underscores
})

test('sanitizeContextId: empty / nullish ids become "session"', () => {
  assert.equal(sanitizeContextId(''), 'session')
  assert.equal(sanitizeContextId(null), 'session')
  assert.equal(sanitizeContextId(undefined), 'session')
})

test('sanitizeContextId: the reserved global key round-trips untouched', () => {
  assert.equal(sanitizeContextId('__global__'), '__global__')
})
