// ForwardManager multi-pool refactor (spec §5 + §12.2): one global
// forwards.json, per-pool attach/detach isolation, machineId-matched autoStart
// (null matches any pool). Local forwards bind real net servers on ephemeral
// 127.0.0.1 ports (no external network); reverse forwards use a net-free fake
// client (forwardIn/unforwardIn).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { ForwardManager } from '../lib/forwards.js'

// ── fakes ──────────────────────────────────────────────────────────────────
class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.forwardOutCalls = []
    this.forwardInCalls = []
    this.unforwardInCalls = []
  }
  forwardOut(lh, lp, host, port, cb) { this.forwardOutCalls.push({ host, port }); cb(new Error('no real tunnel in unit tests')) }
  forwardIn(lh, port, cb) { this.forwardInCalls.push(port); cb() }
  unforwardIn(lh, port, cb) { this.unforwardInCalls.push(port); cb() }
}

class FakePool {
  constructor(boundMachineId) {
    this.boundMachineId = boundMachineId
    this.client = null
    this.clients = [] // every client this pool has ever connected with
    this.closed = false
    this.onReady = null
    this.onCloseHook = null
  }
  async connect() {
    if (!this.client) {
      this.client = new FakeClient()
      this.clients.push(this.client)
    }
    return this.client
  }
  close() {
    this.closed = true
    const c = this.client
    this.client = null
    if (this.onCloseHook) { try { this.onCloseHook(c) } catch {} }
  }
}

/** Simulate a real pool connect: connect() → onReady(client) → attach. */
async function connectAndAttach(manager, pool) {
  const client = await pool.connect()
  if (pool.onReady) pool.onReady(client)
  else manager.attach(client, pool)
  return client
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

/** Poll until cond() is truthy (the net listen callback registers server
 *  entries a tick or two after start()); reject after the timeout. */
async function waitFor(cond, what = 'condition', ms = 3000) {
  const t0 = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what)
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function makeManager(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-fwd-test-'))
  const file = path.join(root, 'forwards.json')
  const manager = new ForwardManager({ file })
  t.after(async () => {
    // Give in-flight starts a few ticks to register, then tear everything
    // down (idempotent) so no net server is left holding the process open.
    for (let i = 0; i < 10; i++) {
      try { manager.stopAll() } catch {}
      await new Promise((r) => setTimeout(r, 10))
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, file, manager }
}

function mkLocalDef(manager, port, machineId, { autoStart = true, id } = {}) {
  const d = manager.define({ direction: 'local', listenPort: port, targetHost: '127.0.0.1', targetPort: port + 1000, autoStart, machineId })
  if (id) d.id = id
  return d
}

// ── 1. autoStart on attach: machineId-matched ─────────────────────────────
test('attach auto-starts only matching autoStart local defs (null = any pool)', async (t) => {
  const { manager } = await makeManager(t)
  const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()])
  const dNull = mkLocalDef(manager, p1, null, { id: 'fwd-null' })
  const dMA = mkLocalDef(manager, p2, 'mA', { id: 'fwd-ma' })
  const dMB = mkLocalDef(manager, p3, 'mB', { id: 'fwd-mb' })

  const poolA = new FakePool('mA')
  const clientA = await connectAndAttach(manager, poolA)
  await waitFor(() => manager.servers.has(dNull.id) && manager.servers.has(dMA.id), 'auto-start of dNull + dMA on pool A')

  assert.ok(manager.servers.has(dNull.id), 'null-machineId def auto-starts on pool A')
  assert.equal(manager.servers.get(dNull.id).pool, poolA)
  assert.equal(manager.servers.get(dNull.id).client, clientA)
  assert.ok(manager.servers.has(dMA.id), 'def bound to mA auto-starts on pool A')
  assert.ok(!manager.servers.has(dMB.id), 'def bound to mB must NOT start on pool A')
})

// ── 2. second pool picks up its own defs; first-wins for shared defs ──────
test('attach on pool B starts mB defs; list() marks each active; shared def stays on first pool', async (t) => {
  const { manager } = await makeManager(t)
  const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()])
  const dNull = mkLocalDef(manager, p1, null)
  const dMA = mkLocalDef(manager, p2, 'mA')
  const dMB = mkLocalDef(manager, p3, 'mB')

  const poolA = new FakePool('mA')
  await connectAndAttach(manager, poolA)
  await waitFor(() => manager.servers.has(dNull.id) && manager.servers.has(dMA.id), 'auto-start on pool A (first-wins ordering)')
  const poolB = new FakePool('mB')
  const clientB = await connectAndAttach(manager, poolB)
  await waitFor(() => manager.servers.has(dMB.id), 'auto-start of dMB on pool B')

  assert.ok(manager.servers.has(dMB.id), 'def bound to mB starts on pool B')
  assert.equal(manager.servers.get(dMB.id).pool, poolB)
  assert.equal(manager.servers.get(dMB.id).client, clientB)
  // the shared (null-machineId) def was already started by pool A → not restarted
  assert.equal(manager.servers.get(dNull.id).pool, poolA, 'first-wins: shared def stays on pool A')
  assert.equal(manager.servers.has(dMA.id), true)
  assert.equal(manager.servers.get(dMA.id).pool, poolA)

  const active = new Set(manager.list().filter((f) => f.active).map((f) => f.id))
  for (const d of [dNull, dMA, dMB]) assert.ok(active.has(d.id), `def ${d.id} reported active`)
})

// ── 3. detach stops ONLY that pool's servers; re-attach works ─────────────
test('detach stops only that pool\u2019s tunnels; re-attach after reconnect re-creates them', async (t) => {
  const { manager } = await makeManager(t)
  const [p1, p2] = await Promise.all([freePort(), freePort()])
  const dNull = mkLocalDef(manager, p1, null)
  const dMB = mkLocalDef(manager, p2, 'mB')

  const poolA = new FakePool('mA')
  const clientA = await connectAndAttach(manager, poolA)
  const poolB = new FakePool('mB')
  const clientB = await connectAndAttach(manager, poolB)
  await waitFor(() => manager.servers.has(dNull.id) && manager.servers.has(dMB.id), 'auto-start of dNull (A) + dMB (B)')

  manager.detach(clientA)
  assert.ok(!manager.servers.has(dNull.id), 'pool A\u2019s server stopped on detach')
  assert.ok(manager.servers.has(dMB.id), 'pool B\u2019s server survives pool A detach')
  assert.equal(manager.servers.get(dMB.id).client, clientB)

  // listeners for the detached client are gone
  assert.equal(clientA.listenerCount('tcpip'), 0)
  assert.equal(clientA.listenerCount('close'), 0)

  // "reconnect": a fresh client, re-attached → autoStart pass runs again
  poolA.client = null
  const clientA2 = await connectAndAttach(manager, poolA)
  await waitFor(() => manager.servers.has(dNull.id), 'shared def re-created after reconnect')
  assert.ok(manager.servers.has(dNull.id), 'shared def re-created after reconnect')
  assert.equal(manager.servers.get(dNull.id).client, clientA2)
  assert.equal(manager.servers.get(dNull.id).pool, poolA)
  // the poolB def is NOT re-created on pool A (machineId mismatch)
  assert.equal(manager.servers.get(dMB.id).client, clientB, 'mB def untouched by pool A reconnect')
})

// ── 4. start no-op when active; stop targets the right pool; remove persists ─
test('start on an active def is a no-op success; stop removes the right entry; remove() persists in the single global file', async (t) => {
  const { file, manager } = await makeManager(t)
  const [p1, p2] = await Promise.all([freePort(), freePort()])
  const dA = mkLocalDef(manager, p1, 'mA')
  const dB = mkLocalDef(manager, p2, 'mB')

  const poolA = new FakePool('mA')
  await connectAndAttach(manager, poolA)
  const poolB = new FakePool('mB')
  await connectAndAttach(manager, poolB)
  await waitFor(() => manager.servers.has(dA.id) && manager.servers.has(dB.id), 'auto-start of dA + dB')

  // start() on an already-active def: success no-op, entry unchanged
  const entryBefore = manager.servers.get(dA.id)
  const r = await manager.start(dA, poolA)
  assert.deepEqual(r, { ok: true, active: true })
  assert.equal(manager.servers.get(dA.id), entryBefore, 'no new server entry')

  // stop(dA) removes ONLY pool A\u2019s entry
  manager.stop(dA.id)
  assert.ok(!manager.servers.has(dA.id))
  assert.ok(manager.servers.has(dB.id), 'pool B\u2019s def unaffected')

  // the single global forwards.json holds both defs, shape { defs: [...] }
  const j = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(j.defs), 'shape { defs: [...] }')
  assert.ok(j.defs.some((d) => d.id === dA.id))
  assert.ok(j.defs.some((d) => d.id === dB.id))

  // remove() deletes the def and persists
  assert.equal(manager.remove(dA.id), true)
  const j2 = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(!j2.defs.some((d) => d.id === dA.id), 'def removed from the file')
  assert.ok(j2.defs.some((d) => d.id === dB.id), 'other def kept')
  assert.equal(manager.remove('nope'), false)
})

// ── 5. reverse forward on a net-free fake client ───────────────────────────
test('reverse def: start() uses forwardIn; stop() calls unforwardIn', async (t) => {
  const { manager } = await makeManager(t)
  const d = manager.define({ direction: 'reverse', listenPort: 22001, targetHost: '127.0.0.1', targetPort: 33001, autoStart: false, machineId: null })
  const pool = new FakePool('mA')
  const client = await pool.connect()
  const r = await manager.start(d, pool)
  assert.deepEqual(r, { ok: true, active: true })
  assert.deepEqual(client.forwardInCalls, [22001])
  const entry = manager.servers.get(d.id)
  assert.equal(entry.kind, 'reverse')
  assert.equal(entry.pool, pool)
  assert.equal(entry.client, client)
  manager.stop(d.id)
  assert.ok(!manager.servers.has(d.id))
  assert.deepEqual(client.unforwardInCalls, [22001])
})

// ── 6. activeFor / stopAll ─────────────────────────────────────────────────
test('activeFor(pool) lists only that pool\u2019s defs; stopAll tears everything down', async (t) => {
  const { manager } = await makeManager(t)
  const [p1, p2] = await Promise.all([freePort(), freePort()])
  const dA = mkLocalDef(manager, p1, 'mA')
  const dB = mkLocalDef(manager, p2, 'mB')
  const poolA = new FakePool('mA')
  await connectAndAttach(manager, poolA)
  const poolB = new FakePool('mB')
  await connectAndAttach(manager, poolB)
  await waitFor(() => manager.servers.has(dA.id) && manager.servers.has(dB.id), 'auto-start of dA + dB')

  const a = manager.activeFor(poolA).map((d) => d.id)
  assert.deepEqual(a, [dA.id])
  const b = manager.activeFor(poolB).map((d) => d.id)
  assert.deepEqual(b, [dB.id])

  manager.stopAll()
  assert.equal(manager.servers.size, 0)
  assert.equal(manager.clients.size, 0)
})
