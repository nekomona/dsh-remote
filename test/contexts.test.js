// ContextStore (lib/contexts.js) — per-agent-thread remote context store
// (spec §2 / §3 / §4.3). Uses a temp rootDir per test (isolated contexts.json)
// and fake pools (no network). Covers: isolation, binding round-trip,
// persistence round-trip (ephemeral absent), corrupt-file fallback, LRU cap
// eviction, idle eviction (fake clock), __global__ bootstrap, sanitized ids,
// closeAll, and stale-reference drop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ContextStore, sanitizeContextId, GLOBAL_CONTEXT_ID } from '../lib/contexts.js'

// ── fakes ──────────────────────────────────────────────────────────────────
class FakePool {
  constructor() {
    this.targets = []
    this.closed = false
    this.onReady = null
    this.onCloseHook = null
    this.boundMachineId = null
  }
  setTarget(cfg) { this.targets.push({ ...cfg }) }
  close() { this.closed = true }
}

function makeRegistry({ list = [], currentId = null, explicitNone = false } = {}) {
  return () => ({ list, currentId, explicitNone })
}

function makeMachine(id, host) {
  return { id, name: host, host, port: 2222, username: 'u', password: 'pw-' + id, credentialBackend: 'plain' }
}

/** Store factory with an injectable fake clock. */
function makeStore({ rootDir, registry, config = {}, maxLive = 8, idleMs = 1800000, now0 = 1_000_000 } = {}) {
  let t = now0
  const store = new ContextStore({
    rootDir,
    registry: registry || makeRegistry(),
    configDefaults: () => config,
    poolFactory: () => new FakePool(),
    machinePassword: async (m) => m.password || '',
    maxLive,
    idleMs,
    now: () => t,
  })
  store.advance = (ms) => { t += ms }
  store.poolFactoryPools = []
  // wrap the factory so tests can track created pools
  const orig = store.poolFactory
  store.poolFactory = (cfg) => { const p = orig(cfg); store.poolFactoryPools.push(p); return p }
  return store
}

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-ctx-test-'))
}

// ── 1. isolation ───────────────────────────────────────────────────────────
test('per-id isolation: bindings never bleed across context ids', () => {
  const root = tmpRoot()
  try {
    const ma = makeMachine('mA', 'host-a')
    const mb = makeMachine('mB', 'host-b')
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: [ma, mb] }) })

    store.bind('a', 'mA')
    store.setWorkspace('a', '/a')
    store.bind('b', 'mB')
    store.setWorkspace('b', '/b')

    const ea = store.getOrCreate('a')
    const eb = store.getOrCreate('b')
    assert.equal(ea.machineId, 'mA')
    assert.equal(ea.workspace, '/a')
    assert.equal(eb.machineId, 'mB')
    assert.equal(eb.workspace, '/b')

    // an unbound third context stays unbound — no inheritance from a/b
    const ec = store.getOrCreate('c')
    assert.equal(ec.machineId, null)
    assert.equal(ec.workspace, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2. binding round-trip ──────────────────────────────────────────────────
test('binding: set/get round-trips { machineId, workspace }; update keeps machineId; updatedAt advances', () => {
  const root = tmpRoot()
  try {
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: [makeMachine('mA', 'host-a')] }) })

    store.bind('a', 'mA')
    let e = store.getOrCreate('a')
    assert.equal(e.machineId, 'mA')
    const t1 = e.updatedAt
    store.advance(1000)
    store.setWorkspace('a', '/a')
    e = store.getOrCreate('a')
    assert.equal(e.machineId, 'mA', 'workspace update must keep the machineId')
    assert.equal(e.workspace, '/a')
    assert.ok(e.updatedAt > t1, 'updatedAt must advance on workspace update')

    const b = store.bindingOf('a')
    assert.deepEqual({ machineId: b.machineId, workspace: b.workspace }, { machineId: 'mA', workspace: '/a' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 3. persistence round-trip ──────────────────────────────────────────────
test('persistence: contexts.json shape + fresh store sees identical entries; ephemeral absent from the file', () => {
  const root = tmpRoot()
  try {
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: [makeMachine('mA', 'host-a'), makeMachine('mB', 'host-b')] }) })
    store.bind('a', 'mA')
    store.setWorkspace('a', '/a')
    store.bind('b', 'mB')
    store.setWorkspace('b', '/b')
    store.bindEphemeral('e', { id: 'mE', name: 'host-e', host: 'host-e', port: 22, username: 'u', password: 'secret-pw' })

    const raw = readFileSync(path.join(root, 'contexts.json'), 'utf8')
    const j = JSON.parse(raw)
    assert.equal(j.version, 1)
    assert.ok(j.contexts && typeof j.contexts === 'object')
    assert.ok(j.contexts.a, 'persisted context a present')
    assert.ok(j.contexts.b, 'persisted context b present')
    assert.ok(!j.contexts.e, 'ephemeral context e must NOT be in the file')
    assert.ok(!raw.includes('secret-pw'), 'raw file must not contain credential material')
    // exact field set: machineId + workspace (+ updatedAt only)
    const fields = Object.keys(j.contexts.a).sort()
    assert.deepEqual(fields, ['machineId', 'updatedAt', 'workspace'])
    assert.equal(j.contexts.a.machineId, 'mA')
    assert.equal(j.contexts.a.workspace, '/a')

    // Simulated restart: a FRESH store over the same rootDir.
    const store2 = makeStore({ rootDir: root, registry: makeRegistry({ list: [makeMachine('mA', 'host-a'), makeMachine('mB', 'host-b')] }) })
    const pa = store2.bindingOf('a')
    assert.equal(pa.machineId, 'mA')
    assert.equal(pa.workspace, '/a')
    const pb = store2.bindingOf('b')
    assert.equal(pb.machineId, 'mB')
    assert.equal(pb.workspace, '/b')
    // the ephemeral binding is gone after "restart"
    assert.equal(store2.bindingOf('e').machineId, null)
    assert.equal(store2.activeMachineOf('e'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 4. corrupt-file fallback ───────────────────────────────────────────────
test('corrupt contexts.json: loads empty (no throw); next bind atomically rewrites a valid file', () => {
  const root = tmpRoot()
  try {
    writeFileSync(path.join(root, 'contexts.json'), '{not json', 'utf8')
    const warns = []
    const store = makeStore({ rootDir: root })
    const warnsStore = new ContextStore({
      rootDir: root,
      registry: makeRegistry(),
      configDefaults: () => ({}),
      poolFactory: () => new FakePool(),
      machinePassword: async () => '',
      logger: { warn: (m) => warns.push(m) },
    })
    void store
    const b = warnsStore.bindingOf('a')
    assert.equal(b.machineId, null, 'corrupt file → empty store, no throw')
    assert.ok(warns.length >= 1, 'corrupt fallback should warn via ctx.logger')

    // subsequent bind rewrites a valid file
    warnsStore.bind('a', 'mA')
    const j = JSON.parse(readFileSync(path.join(root, 'contexts.json'), 'utf8'))
    assert.equal(j.version, 1)
    assert.equal(j.contexts.a.machineId, 'mA')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 5. LRU eviction ────────────────────────────────────────────────────────
test('LRU cap: materializing a third context closes the oldest pool; its persisted binding survives', async () => {
  const root = tmpRoot()
  try {
    const ms = ['mA', 'mB', 'mC'].map((id) => makeMachine(id, 'host-' + id))
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: ms }), maxLive: 2 })

    store.bind('a', 'mA'); store.setWorkspace('a', '/a')
    store.bind('b', 'mB'); store.setWorkspace('b', '/b')
    const pa = await store.resolvePool('a')
    store.advance(100)
    const pb = await store.resolvePool('b')
    assert.ok(pa instanceof FakePool)
    assert.ok(pb instanceof FakePool)

    // touch a so b is the oldest; then materialize c → b must be evicted
    store.advance(100)
    store.touch('a')
    store.advance(100)
    store.bind('c', 'mC')
    const pc = await store.resolvePool('c')
    assert.ok(pc instanceof FakePool)

    assert.equal(pb.closed, true, 'b (oldest lastUsed) must be evicted: pool closed')
    assert.equal(pa.closed, false, 'a (touched) stays live')
    assert.equal(pc.closed, false, 'c (just materialized) stays live')

    // b's persisted entry survives eviction and re-materializes on next use
    const raw = JSON.parse(readFileSync(path.join(root, 'contexts.json'), 'utf8'))
    assert.equal(raw.contexts.b.machineId, 'mB')
    assert.equal(raw.contexts.b.workspace, '/b')
    store.advance(100)
    const pb2 = await store.resolvePool('b')
    assert.notEqual(pb2, pb, 're-materialization builds a NEW pool')
    assert.equal(pb2.targets.length, 1)
    assert.equal(pb2.targets[0].host, 'host-mB')
    assert.equal(pb2.targets[0].workspace, '/b')
    // the LRU cycle continues: re-materializing b (cap 2) evicts a, the new oldest
    assert.equal(pa.closed, true, 'a becomes the oldest on the second pass and is evicted')
    assert.equal(pc.closed, false)
    assert.equal(pb2.closed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 6. idle eviction ───────────────────────────────────────────────────────
test('idle sweep: pool closed after threshold, persisted binding kept; idleMs=0 disables', async () => {
  const root = tmpRoot()
  try {
    const m = makeMachine('mA', 'host-a')
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: [m] }), idleMs: 50 })
    store.bind('a', 'mA')
    store.setWorkspace('a', '/a')
    const pa = await store.resolvePool('a')

    store.advance(10)
    store.sweepIdle()
    assert.equal(pa.closed, false, 'within threshold: not evicted')

    store.advance(100)
    store.sweepIdle()
    assert.equal(pa.closed, true, 'past threshold: pool closed')
    const raw = JSON.parse(readFileSync(path.join(root, 'contexts.json'), 'utf8'))
    assert.equal(raw.contexts.a.machineId, 'mA', 'idle eviction must keep the persisted binding')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const root2 = tmpRoot()
  try {
    const m = makeMachine('mA', 'host-a')
    const store = makeStore({ rootDir: root2, registry: makeRegistry({ list: [m] }), idleMs: 0 })
    store.bind('a', 'mA')
    const pa = await store.resolvePool('a')
    store.advance(1e9)
    store.sweepIdle()
    assert.equal(pa.closed, false, 'idleMs=0 disables idle eviction')
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
})

// ── 7. __global__ bootstrap ────────────────────────────────────────────────
test('__global__ bootstrap: config default / explicitNone / registry currentId', () => {
  // (a) registry empty + config host set → config-default machine
  let store = makeStore({
    rootDir: tmpRoot(),
    registry: makeRegistry({ list: [], currentId: null, explicitNone: false }),
    config: { host: 'cfg-host', port: 2223, username: 'cfguser' },
  })
  let m = store.activeMachineOf(GLOBAL_CONTEXT_ID)
  assert.ok(m, '(a) unbound global adopts the config default')
  assert.equal(m.host, 'cfg-host')
  assert.equal(m.port, 2223)

  // (b) explicit "none" in the registry → config default NOT adopted
  store = makeStore({
    rootDir: tmpRoot(),
    registry: makeRegistry({ list: [makeMachine('mA', 'host-a')], currentId: null, explicitNone: true }),
    config: { host: 'cfg-host' },
  })
  m = store.activeMachineOf(GLOBAL_CONTEXT_ID)
  assert.equal(m, null, '(b) explicitNone must suppress the config-default bootstrap')

  // (c) registry currentId set → global binds that machine (not config)
  store = makeStore({
    rootDir: tmpRoot(),
    registry: makeRegistry({ list: [makeMachine('mA', 'host-a')], currentId: 'mA', explicitNone: false }),
    config: { host: 'cfg-host' },
  })
  m = store.activeMachineOf(GLOBAL_CONTEXT_ID)
  assert.ok(m)
  assert.equal(m.id, 'mA', '(c) registry currentId wins for the global context')
})

// ── 8. sanitized ids ───────────────────────────────────────────────────────
test('sanitized ids: exotic raw id stores under the sanitized key; "" → "session"; __global__ untouched', () => {
  const root = tmpRoot()
  try {
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: [makeMachine('mA', 'host-a')] }) })
    store.bind('a/b\\c:d', 'mA')
    const raw = JSON.parse(readFileSync(path.join(root, 'contexts.json'), 'utf8'))
    assert.ok(raw.contexts['a_b_c_d'], 'stored under the sanitized key a_b_c_d')
    assert.equal(Object.keys(raw.contexts).length, 1, 'no unsanitized key leaked into the file')
    // served back for the same raw id
    const e = store.getOrCreate('a/b\\c:d')
    assert.equal(e.id, 'a_b_c_d')
    assert.equal(e.machineId, 'mA')
    assert.equal(store.bindingOf('a/b\\c:d').machineId, 'mA')

    assert.equal(sanitizeContextId(''), 'session')
    assert.equal(sanitizeContextId('__global__'), '__global__')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── extra: closeAll ────────────────────────────────────────────────────────
test('closeAll: closes every live pool; bindings + persisted state survive', async () => {
  const root = tmpRoot()
  try {
    const ms = ['mA', 'mB'].map((id) => makeMachine(id, 'host-' + id))
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: ms }) })
    store.bind('a', 'mA'); store.bind('b', 'mB')
    const pa = await store.resolvePool('a')
    const pb = await store.resolvePool('b')
    store.closeAll()
    assert.equal(pa.closed, true)
    assert.equal(pb.closed, true)
    assert.equal(store.getOrCreate('a').pool, null)
    assert.equal(store.bindingOf('a').machineId, 'mA', 'closeAll keeps the binding')
    const raw = JSON.parse(readFileSync(path.join(root, 'contexts.json'), 'utf8'))
    assert.equal(raw.contexts.b.machineId, 'mB')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── extra: stale reference drop ────────────────────────────────────────────
test('stale machineId (deleted registry machine): resolvePool drops the entry and reports unbound', async () => {
  const root = tmpRoot()
  try {
    const store = makeStore({ rootDir: root, registry: makeRegistry({ list: [makeMachine('mA', 'host-a')] }) })
    store.bind('a', 'mA') // persisted while the machine still existed
    // the registry now lost the machine (e.g. user deleted it)
    const store2 = makeStore({ rootDir: root, registry: makeRegistry({ list: [] }) })
    const pool = await store2.resolvePool('a')
    assert.equal(pool, null, 'stale binding cannot materialize a pool')
    const e = store2.getOrCreate('a')
    assert.equal(e.machineId, null, 'stale entry dropped from memory')
    assert.match(String(e.staleError), /no longer exists in registry/)
    const raw = JSON.parse(readFileSync(path.join(root, 'contexts.json'), 'utf8'))
    assert.ok(!raw.contexts.a, 'stale persisted entry removed (atomic save)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
