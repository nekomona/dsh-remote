// Tool harness (spec §12.3) — drives the REAL apply() in-process:
//   mock ctx (tools/systemPrompt/webServer/effect/get) + a fake pool factory
//   injected via apply(ctx, config, { poolFactory }). No real SSH, no network.
//
// Scenarios (spec §12.3.1–9 + §13.14):
//   a. two agents, two hosts, no clobber
//   b. sub-agent non-inheritance (fresh id starts unbound)
//   c. per-context workspace (rw_exec default cwd)
//   d. persistence + restore after a simulated restart (second apply())
//   e. ?sessionId= route scoping (status/ls/workspace)
//   f. rw_disconnect independence
//   g. LRU eviction (maxRemoteContexts=2, three agents)
//   h. ephemeral (save:false) never persisted
//   i. audit lines carry the context-id segment (__global__ when agentless)
//   j. system-prompt section resolves per agent (bound / mirror-cwd / local)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemFs, makeSftp, seed } from './helpers.js'
import { apply } from '../lib/index.js'

// ── fakes ──────────────────────────────────────────────────────────────────
class FakeClient extends EventEmitter {
  forwardOut(lh, lp, host, port, cb) { cb(new Error('no tunnel in the harness')) }
  forwardIn(lh, port, cb) { cb() }
  unforwardIn(lh, port, cb) { cb() }
}

class FakePool {
  constructor(config, index) {
    this.config = { ...config }
    this.index = index
    this.targets = [] // every setTarget() call, in order
    this.execs = [] // every exec() command, in order
    this.connects = 0
    this.closed = false
    this.client = null
    this.platform = 'posix'
    this.shellMode = 'native'
    this.gitBashPath = ''
    this.onReady = null
    this.onCloseHook = null
    this.boundMachineId = null
    this.fs = new MemFs()
  }
  setTarget(cfg) { this.targets.push({ ...cfg }); Object.assign(this.config, cfg) }
  async detect() { return this }
  async connect() {
    this.connects++
    if (!this.client) {
      this.client = new FakeClient()
      if (this.onReady) { try { this.onReady(this.client) } catch {} }
    }
    return this.client
  }
  async exec(cmd) {
    this.execs.push(String(cmd))
    await this.connect()
    return { code: 0, stdout: 'ok', stderr: '' }
  }
  async sftp() { await this.connect(); return makeSftp(this.fs) }
  invalidate() { this.client = null }
  close() {
    this.closed = true
    const c = this.client
    this.client = null
    if (this.onCloseHook) { try { this.onCloseHook(c) } catch {} }
  }
}

function makeFakePoolFactory() {
  const pools = []
  const factory = (config) => {
    const pool = new FakePool(config, pools.length)
    pools.push(pool)
    return pool
  }
  factory.pools = pools
  return factory
}

function makeMockCtx() {
  const tools = new Map()
  const sections = []
  const routes = []
  const commands = []
  const warns = []
  const disposers = []
  const ctx = {
    // DSH plugin effect contract: the setup fn runs now; its return value is
    // the disposer the host runs on plugin dispose.
    effect(fn, name) {
      let cleanup
      try { cleanup = fn() } catch {}
      if (typeof cleanup === 'function') disposers.push(cleanup)
    },
    tools: { register(t) { tools.set(t.name, t) } },
    systemPrompt: { section(s) { sections.push(s) } },
    get(name) {
      if (name === 'webServer') return { register(r) { routes.push(r); return () => {} } }
      if (name === 'commands') return { register(c) { commands.push(c) } }
      return undefined // sessions / directoryPicker: absent → legacy-safe paths
    },
    logger: { warn(m) { warns.push(String(m)) } },
  }
  return { ctx, tools, sections, routes, commands, warns, disposers }
}

// ── harness ────────────────────────────────────────────────────────────────
function baseConfig() {
  return {
    host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '', workspace: '',
    shell: '', commandTimeoutMs: 20000, connectTimeoutMs: 15000, maxOutputChars: 200000,
    maxFileBytes: 52428800, hostKeyMode: 'accept-new', useAgent: false, keyboardInteractive: false,
    proxy: { host: '', port: 22, username: '', password: '', privateKeyPath: '' },
    autoPush: false, auditLog: true, encoding: 'utf-8', updateMode: 'manual',
    updateCheckIntervalMs: 6 * 3600 * 1000, maxRemoteContexts: 8, remoteContextIdleMs: 1800000,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Start a real apply() against a fresh temp DSH_HOME with fake pools. */
async function startHarness(t, config = {}, home = null) {
  const useHome = home || mkdtempSync(path.join(tmpdir(), 'dsh-harness-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = useHome
  const mock = makeMockCtx()
  const factory = makeFakePoolFactory()
  let harness = null
  try {
    await apply(mock.ctx, { ...baseConfig(), ...config }, { poolFactory: factory })
  } catch (err) {
    process.env.DSH_HOME = prevHome
    if (!home) rmSync(useHome, { recursive: true, force: true })
    throw err
  }
  harness = {
    home: useHome,
    mock,
    factory,
    tools: mock.tools,
    /** Invoke a registered tool as agentId (or agentless when undefined). */
    call: (name, args = {}, agentId) => {
      const tool = mock.tools.get(name)
      if (!tool) throw new Error(`tool not registered: ${name}`)
      const exec = agentId !== undefined ? { agent: { id: agentId, session: { id: agentId } } } : {}
      return tool.execute(args, exec)
    },
    /** Invoke a registered web route with a fake req/res. */
    route: async (p, method, { query = '', body } = {}) => {
      const r = mock.routes.find((x) => x.path === p)
      if (!r) throw new Error(`route not registered: ${p}`)
      const req = new EventEmitter()
      req.method = method
      req.url = 'http://localhost' + p + (query ? '?' + query : '')
      const res = new EventEmitter()
      res.statusCode = 0
      res.headers = {}
      res.setHeader = (k, v) => { res.headers[k] = String(v) }
      let bodyBuf = ''
      res.end = (chunk) => { bodyBuf += String(chunk || ''); res.ended = true }
      setImmediate(() => {
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      })
      await r.handler(req, res)
      let json = null
      try { json = bodyBuf ? JSON.parse(bodyBuf) : null } catch { /* non-JSON */ }
      return { status: res.statusCode, json, body: bodyBuf }
    },
    /** Evaluate the registered dsh-remote system-prompt section. */
    sectionText: (promptContext) => {
      const s = mock.sections.find((x) => x.name === 'dsh-remote')
      if (!s) throw new Error('dsh-remote section not registered')
      return s.text(promptContext)
    },
    remoteWorkspaces: path.join(useHome, 'remote-workspaces'),
    dispose() {
      for (const d of [...mock.disposers].reverse()) { if (typeof d === 'function') { try { d() } catch {} } }
      process.env.DSH_HOME = prevHome
      if (!home) rmSync(useHome, { recursive: true, force: true })
    },
  }
  t.after(() => { try { harness.dispose() } catch {} })
  return harness
}

// ── a. two agents, two hosts, no clobber ──────────────────────────────────
test('two agents on two hosts stay fully isolated (no clobber)', async (t) => {
  const h = await startHarness(t)
  const A = 'session-A'
  const B = 'session-B'

  const rA = await h.call('rw_connect', { host: 'h-a', username: 'ua', save: false }, A)
  assert.match(rA.text, /Connected to h-a as ua/)
  const rB = await h.call('rw_connect', { host: 'h-b', username: 'ub', save: false }, B)
  assert.match(rB.text, /Connected to h-b as ub/)

  const poolA = h.factory.pools[0]
  const poolB = h.factory.pools[1]
  assert.equal(poolA.targets[0].host, 'h-a', 'A\'s pool targeted at h-a')
  assert.equal(poolB.targets[0].host, 'h-b', 'B\'s pool targeted at h-b')

  // per-host file trees (distinguishable per pool)
  seed(poolA.fs, { 'a/alpha.txt': 'A-content' })
  seed(poolB.fs, { 'b/beta.txt': 'B-content' })

  await h.call('rw_pick_workspace', { path: '/a' }, A)
  await h.call('rw_pick_workspace', { path: '/b' }, B)

  // B's connect/pick must not have touched A's pool: A's setTarget history
  // is exactly [connect (full target), pick ({workspace})] and nothing else
  assert.equal(poolA.targets.length, 2, 'A\'s pool got exactly two setTarget calls')
  assert.equal(poolA.targets[0].host, 'h-a')
  assert.equal(poolA.targets[0].username, 'ua')
  assert.equal(poolA.targets[0].workspace, '')
  assert.equal(poolA.targets[1].workspace, '/a', 'pick applied to A\'s pool')
  const lastTargetA = poolA.targets[poolA.targets.length - 1]
  assert.equal(lastTargetA.workspace, '/a', 'A\'s workspace survived B\'s connect+pick')
  assert.equal(poolB.targets.length, 2, 'B\'s pool also exactly two setTarget calls')

  // default-path listing resolves against EACH context's own workspace/pool
  const listA = await h.call('rw_list_dir', {}, A)
  assert.match(listA.text, /alpha\.txt/)
  const listB = await h.call('rw_list_dir', {}, B)
  assert.match(listB.text, /beta\.txt/)

  // A's reads must not touch B's pool (connect count frozen)
  const bConnectsBefore = poolB.connects
  await h.call('rw_list_dir', {}, A)
  assert.equal(poolB.connects, bConnectsBefore, 'B\'s pool connect count untouched by A\'s call')
})

// ── b. sub-agent non-inheritance ──────────────────────────────────────────
test('a fresh-id sub-agent sees NO inherited remote context; parent stays bound', async (t) => {
  const h = await startHarness(t)
  const P = 'parent-session'
  const r = await h.call('rw_connect', { host: 'h-p', username: 'up', save: false }, P)
  assert.match(r.text, /Connected to h-p as up/)

  // the in-process driver mints child ids exactly like this (spec §1.3)
  const C = randomUUID()
  const infoC = await h.call('rw_info', {}, C)
  assert.match(infoC.text, /this session is LOCAL/, 'fresh sub-agent reports LOCAL')
  assert.match(infoC.text, /Connected: no/)
  assert.doesNotMatch(infoC.text, /h-p/, 'no parent machine leaked into the child')

  await assert.rejects(
    h.call('rw_list_dir', {}, C),
    /no remote context for this session — call rw_connect first/,
    'workspace-relative tool on an unbound child fails actionably',
  )

  // the parent is still bound and connected
  const infoP = await h.call('rw_info', {}, P)
  assert.match(infoP.text, /h-p/)
  assert.match(infoP.text, /Connected: yes/)
})

// ── c. per-context workspace → rw_exec default cwd ────────────────────────
test('per-context workspace: rw_exec default cwd is /a for A and /b for B', async (t) => {
  const h = await startHarness(t)
  const A = 'session-A'
  const B = 'session-B'
  await h.call('rw_connect', { host: 'h-x', username: 'ux', save: false }, A)
  await h.call('rw_connect', { host: 'h-y', username: 'uy', save: false }, B)
  const poolA = h.factory.pools[0]
  const poolB = h.factory.pools[1]
  poolA.fs.mkdirSync('/a')
  poolB.fs.mkdirSync('/b')
  await h.call('rw_pick_workspace', { path: '/a' }, A)
  await h.call('rw_pick_workspace', { path: '/b' }, B)

  const ea = await h.call('rw_exec', { command: 'ls' }, A)
  const eb = await h.call('rw_exec', { command: 'ls' }, B)
  assert.match(ea.text, /^ok/)
  assert.match(eb.text, /^ok/)
  assert.equal(poolA.execs[poolA.execs.length - 1], `cd '/a' && ls`, 'A execs in /a')
  assert.equal(poolB.execs[poolB.execs.length - 1], `cd '/b' && ls`, 'B execs in /b')

  // explicit cwd still wins, per context
  await h.call('rw_exec', { command: 'pwd', cwd: '/elsewhere' }, A)
  assert.equal(poolA.execs[poolA.execs.length - 1], `cd '/elsewhere' && pwd`)
})

// ── d. persistence + restore after a simulated restart ────────────────────
test('simulated restart: binding + workspace restored, pool reconnects lazily on first use', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-harness-restart-'))
  t.after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
  const A = 'session-A'

  // pass 1: connect (persisted) + pick workspace
  const h1 = await startHarness(t, {}, home)
  await h1.call('rw_connect', { host: 'h-a', username: 'ua' }, A) // save defaults to true
  h1.factory.pools[0].fs.mkdirSync('/a') // remote dir must exist for pick to persist
  const pickA = await h1.call('rw_pick_workspace', { path: '/a' }, A)
  assert.match(pickA.text, /Remote workspace set to \/a/, 'pick actually persisted (dir exists)')

  const machines = JSON.parse(readFileSync(path.join(home, 'remote-workspaces', 'machines.json'), 'utf8'))
  assert.ok(machines.list.some((m) => m.host === 'h-a'), 'machine upserted into the GLOBAL registry')
  const contexts = JSON.parse(readFileSync(path.join(home, 'remote-workspaces', 'contexts.json'), 'utf8'))
  assert.equal(contexts.contexts[A].machineId, machines.list.find((m) => m.host === 'h-a').id)
  assert.equal(contexts.contexts[A].workspace, '/a')
  h1.dispose() // "process exit" — but contexts.json + machines.json survive

  // pass 2: fresh apply() over the SAME home — no rw_connect may be needed
  const h2 = await startHarness(t, {}, home)
  assert.equal(h2.factory.pools.length, 0, 'no pool materialized at boot (lazy)')
  const listA = await h2.call('rw_list_dir', { path: '/a' }, A)
  assert.equal(listA.text, '(empty directory)') // fresh fake fs — the point is the routing
  assert.equal(h2.factory.pools.length, 1, 'pool materialized lazily on FIRST use')
  const pool = h2.factory.pools[0]
  assert.equal(pool.targets[0].host, 'h-a', 'restored from the persisted binding (registry machine)')
  assert.equal(pool.targets[0].username, 'ua')
  assert.equal(pool.targets[0].workspace, '/a', 'workspace restored without re-connecting')

  // a brand-new id on the restarted harness stays unbound
  const Z = randomUUID()
  const infoZ = await h2.call('rw_info', {}, Z)
  assert.match(infoZ.text, /this session is LOCAL/)
  assert.equal(h2.factory.pools.length, 1, 'unbound ids never materialize pools')
})

// ── e. ?sessionId= route scoping ──────────────────────────────────────────
test('route scoping: ?sessionId= targets per-session contexts; omitted → __global__', async (t) => {
  const h = await startHarness(t)
  const S1 = 'session-S1'
  const S2 = 'session-S2'
  await h.call('rw_connect', { host: 'h-a', username: 'ua', save: false }, S1)
  await h.call('rw_connect', { host: 'h-b', username: 'ub', save: false }, S2)
  h.factory.pools[0].fs.mkdirSync('/a')
  h.factory.pools[1].fs.mkdirSync('/b')
  h.factory.pools[1].fs.mkdirSync('/b2')
  await h.call('rw_pick_workspace', { path: '/a' }, S1)
  await h.call('rw_pick_workspace', { path: '/b' }, S2)
  seed(h.factory.pools[0].fs, { 'a/alpha.txt': 'A' })
  seed(h.factory.pools[1].fs, { 'b/beta.txt': 'B' })

  const st1 = await h.route('/dsh-remote/status', 'GET', { query: 'sessionId=' + S1 })
  assert.equal(st1.status, 200)
  assert.equal(st1.json.contextId, S1)
  assert.equal(st1.json.host, 'h-a')
  assert.equal(st1.json.connected, true)
  assert.equal(st1.json.workspace, '/a')
  assert.equal(st1.json.activeSource, 'ephemeral')

  const st2 = await h.route('/dsh-remote/status', 'GET', { query: 'sessionId=' + S2 })
  assert.equal(st2.json.host, 'h-b')
  assert.equal(st2.json.connected, true)
  assert.equal(st2.json.workspace, '/b')

  // per-session ls
  const ls1 = await h.route('/dsh-remote/ls', 'GET', { query: 'sessionId=' + S1 + '&path=%2Fa' })
  assert.equal(ls1.status, 200)
  assert.ok(Array.isArray(ls1.json.items))
  assert.ok(ls1.json.items.some((i) => i.name === 'alpha.txt'), 'S1 lists its own tree')
  const ls2 = await h.route('/dsh-remote/ls', 'GET', { query: 'sessionId=' + S2 + '&path=%2Fb' })
  assert.ok(ls2.json.items.some((i) => i.name === 'beta.txt'), 'S2 lists its own tree')

  // un-scoped call → the __global__ context (unbound here)
  const stG = await h.route('/dsh-remote/status', 'GET')
  assert.equal(stG.status, 200)
  assert.equal(stG.json.contextId, '__global__')
  assert.equal(stG.json.connected, false)
  assert.equal(stG.json.activeSource, 'none')
  assert.ok(Array.isArray(stG.json.machines), 'registry fields stay global')

  // POST /workspace with body.sessionId changes ONLY that session
  const ws2 = await h.route('/dsh-remote/workspace', 'POST', { body: { sessionId: S2, path: '/b2' } })
  assert.equal(ws2.status, 200)
  assert.equal(ws2.json.ok, true)
  assert.equal(ws2.json.workspace, '/b2')
  const st2b = await h.route('/dsh-remote/status', 'GET', { query: 'sessionId=' + S2 })
  assert.equal(st2b.json.workspace, '/b2')
  const st1b = await h.route('/dsh-remote/status', 'GET', { query: 'sessionId=' + S1 })
  assert.equal(st1b.json.workspace, '/a', 'S1 untouched by S2\'s workspace change')
})

// ── f. rw_disconnect independence ─────────────────────────────────────────
test('rw_disconnect on A leaves B connected', async (t) => {
  const h = await startHarness(t)
  const A = 'session-A'
  const B = 'session-B'
  await h.call('rw_connect', { host: 'h-a', username: 'ua', save: false }, A)
  await h.call('rw_connect', { host: 'h-b', username: 'ub', save: false }, B)
  const poolA = h.factory.pools[0]
  const poolB = h.factory.pools[1]
  poolA.fs.mkdirSync('/a')
  poolB.fs.mkdirSync('/b')
  await h.call('rw_pick_workspace', { path: '/a' }, A)
  await h.call('rw_pick_workspace', { path: '/b' }, B)

  const d = await h.call('rw_disconnect', {}, A)
  assert.equal(d.ok, true)
  assert.equal(poolA.closed, true, 'A\'s pool closed')
  assert.equal(poolB.closed, false, 'B\'s pool untouched')
  assert.ok(poolB.client, 'B\'s client intact')

  const listB = await h.call('rw_list_dir', {}, B)
  assert.match(listB.text, /^\(empty directory\)|\S/, 'B still lists (its pool works)')
  assert.equal(poolB.closed, false)

  // A's binding survived the disconnect (pool is re-materialized on next use)
  const stA = await h.route('/dsh-remote/status', 'GET', { query: 'sessionId=' + A })
  assert.equal(stA.json.host, 'h-a', 'A still bound after disconnect')
  assert.equal(stA.json.connected, false, '…but not connected (pool closed)')
  const poolsBefore = h.factory.pools.length
  await h.call('rw_list_dir', { path: '/a' }, A)
  assert.equal(h.factory.pools.length, poolsBefore + 1, 'A reconnects lazily on next use')
  assert.equal(h.factory.pools[h.factory.pools.length - 1].targets[0].host, 'h-a')
})

// ── g. LRU eviction at the cap ────────────────────────────────────────────
test('LRU: with maxRemoteContexts=2 the oldest pool is closed; its binding stays persisted', async (t) => {
  const h = await startHarness(t, { maxRemoteContexts: 2 })
  const A = 'session-A'
  const B = 'session-B'
  const C = 'session-C'
  await h.call('rw_connect', { host: 'h-a', username: 'ua' }, A) // persisted bindings
  await sleep(10)
  await h.call('rw_connect', { host: 'h-b', username: 'ub' }, B)
  await sleep(10)
  await h.call('rw_exec', { command: 'ls' }, A) // touch A → B becomes the oldest
  await sleep(10)
  await h.call('rw_connect', { host: 'h-c', username: 'uc' }, C) // materializes C → evicts B

  const poolA = h.factory.pools[0]
  const poolB = h.factory.pools[1]
  const poolC = h.factory.pools[2]
  assert.equal(poolB.closed, true, 'B (oldest) evicted: pool closed')
  assert.equal(poolA.closed, false, 'A (touched) still live')
  assert.equal(poolC.closed, false, 'C (just materialized) live')

  // B\'s binding survived in contexts.json
  const contexts = JSON.parse(readFileSync(path.join(h.home, 'remote-workspaces', 'contexts.json'), 'utf8'))
  assert.ok(contexts.contexts[B].machineId, 'B\'s persisted binding survives eviction')

  // B\'s next tool use re-materializes a NEW pool
  const before = h.factory.pools.length
  await h.call('rw_exec', { command: 'ls' }, B)
  assert.equal(h.factory.pools.length, before + 1, 'B re-materialized a new pool')
  const poolB2 = h.factory.pools[before]
  assert.equal(poolB2.targets[0].host, 'h-b')
  assert.equal(poolB2.closed, false)
  // the LRU cycle continues: re-materializing B (cap 2) evicts A, the new oldest
  assert.equal(poolA.closed, true, 'A becomes the oldest on the second pass and is evicted')
  assert.equal(poolC.closed, false)
})

// ── h. ephemeral bindings are never persisted ─────────────────────────────
test('save:false binding is absent from contexts.json and gone after restart', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-harness-eph-'))
  t.after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
  const A = 'session-A'

  const h1 = await startHarness(t, {}, home)
  await h1.call('rw_connect', { host: 'h-e', username: 'ue', save: false }, A)
  const file = path.join(home, 'remote-workspaces', 'contexts.json')
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8')
    assert.ok(!raw.includes(A), 'ephemeral context id absent from contexts.json')
  } // file may be absent entirely — that is the cleanest case

  h1.dispose()
  const h2 = await startHarness(t, {}, home)
  const infoA = await h2.call('rw_info', {}, A)
  assert.match(infoA.text, /this session is LOCAL/, 'ephemeral binding is gone after restart')
  assert.match(infoA.text, /source: none/)
})

// ── i. audit lines carry the context-id segment ───────────────────────────
test('audit: bound agent logs | <contextId> |; agentless call logs | __global__ |', async (t) => {
  const h = await startHarness(t) // auditLog: true (schema default)
  const A = 'session-A'
  // save:true (default): the registry upsert creates remote-workspaces/,
  // so the audit append has a directory to land in
  await h.call('rw_connect', { host: 'h-a', username: 'ua' }, A)
  await h.call('rw_exec', { command: 'ls' }, A)

  const auditFile = path.join(h.home, 'remote-workspaces', 'audit.log')
  assert.ok(existsSync(auditFile), 'audit log written')
  const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean)
  const execLine = lines.find((l) => /\| exec \|/.test(l))
  assert.ok(execLine, 'an exec audit line exists')
  assert.match(execLine, new RegExp(`\\| ${A} \\| ua@h-a:22 \\| exec \\| 0 \\| ls`), 'line: ISO | <contextId> | user@host:port | op | code | cmd')

  // agentless (web-ephemeral global bind) exec → __global__ segment
  const g = await h.route('/dsh-remote/connect', 'POST', { body: { host: 'h-g', username: 'ug' } })
  assert.equal(g.status, 200)
  assert.equal(g.json.ok, true)
  await h.call('rw_exec', { command: 'ls' }, undefined)
  const lines2 = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean)
  const gLine = lines2.find((l) => /\| __global__ \|/.test(l) && /\| exec \|/.test(l))
  assert.ok(gLine, 'agentless exec logs the __global__ segment')
  assert.match(gLine, /ug@h-g:22/)
})

// ── j. system-prompt section resolves per agent ───────────────────────────
test('system-prompt section: bound context / legacy mirror cwd / local cwd', async (t) => {
  const h = await startHarness(t)
  const P = 'session-P'
  await h.call('rw_connect', { host: 'h-a', username: 'ua', save: false }, P)
  h.factory.pools[0].fs.mkdirSync('/a')
  await h.call('rw_pick_workspace', { path: '/a' }, P)

  // 1) bound context → names the context's machine + workspace
  const bound = h.sectionText({ agent: { id: P, session: { header: { cwd: 'C:\\irrelevant' } } } })
  assert.match(bound, /## Remote workspace/)
  assert.match(bound, /Current remote workspace: ua@h-a:\/a/)

  // 2) unbound agent whose cwd maps into a dsh-remote mirror → legacy text
  const mirrorDir = path.join(h.remoteWorkspaces, 'h-a-ua-22', 'a')
  writeFileSync(
    path.join(mirrorDir, '.dsh-remote-meta.json'),
    JSON.stringify({ host: 'h-a', port: 22, username: 'ua', remotePath: '/a', createdAt: new Date().toISOString() }),
  )
  const mirrorCwd = path.join(mirrorDir, 'somewhere')
  const legacy = h.sectionText({ agent: { id: 'unbound-mirror', session: { header: { cwd: mirrorCwd } } } })
  assert.match(legacy, /## Remote workspace/)
  assert.match(legacy, /Current remote workspace: .*@.*:\/a/)

  // 3) unbound agent with a plain local cwd → silent (issue #13: no leak)
  const local = h.sectionText({ agent: { id: 'unbound-local', session: { header: { cwd: path.join(h.home, 'nowhere') } } } })
  assert.equal(local, '')

  // 4) no agent at all → silent
  assert.equal(h.sectionText({}), '')
})

// ── k. review hardening pins (spec §12.5 / §13, review round 1) ─────────────

/** Seed machines.json BEFORE apply() so the real registry load sees it. */
function seedRegistry(home, obj) {
  const rw = path.join(home, 'remote-workspaces')
  mkdirSync(rw, { recursive: true })
  writeFileSync(path.join(rw, 'machines.json'), JSON.stringify(obj, null, 2), 'utf8')
  return rw
}

test('F4: rw_connect save:true never flips the registry currentId (host + machineId forms)', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-harness-f4-'))
  t.after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
  const rw = seedRegistry(home, {
    version: 1,
    currentId: 'm-seed',
    list: [{ id: 'm-seed', name: 'seed', host: 'h-seed', port: 22, username: 'useed', password: 'pwseed' }],
  })
  const h = await startHarness(t, {}, home)
  const readCurrent = () => {
    const j = JSON.parse(readFileSync(path.join(rw, 'machines.json'), 'utf8'))
    return j.currentId === undefined ? null : j.currentId
  }
  assert.equal(readCurrent(), 'm-seed', 'seeded currentId is live before any connect')

  // host form: upserts a NEW machine — currentId must stay on m-seed
  const A = 'session-f4'
  await h.call('rw_connect', { host: 'h-new', username: 'unew', password: 'pwn' }, A)
  assert.equal(readCurrent(), 'm-seed', 'currentId unchanged after host-form save:true')
  const ctxs1 = JSON.parse(readFileSync(path.join(rw, 'contexts.json'), 'utf8'))
  assert.ok(ctxs1.contexts[A] && ctxs1.contexts[A].machineId, 'calling context gained a machineId binding')
  assert.notEqual(ctxs1.contexts[A].machineId, 'm-seed', 'host form upserted a distinct machine')

  // machineId form: binds an EXISTING machine — currentId still unchanged
  const B = 'session-f4b'
  await h.call('rw_connect', { machineId: 'm-seed', save: true }, B)
  assert.equal(readCurrent(), 'm-seed', 'currentId unchanged after machineId-form save:true')
  const ctxs2 = JSON.parse(readFileSync(path.join(rw, 'contexts.json'), 'utf8'))
  assert.equal(ctxs2.contexts[B].machineId, 'm-seed', 'calling context bound to the referenced machine')
})

test('/current legacy pair: binds __global__, persists legacy workspace, explicitNone clears inert', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-harness-cur-'))
  t.after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
  const rw = seedRegistry(home, {
    version: 1,
    list: [{ id: 'm-legacy', name: 'legacy', host: 'h-legacy', port: 22, username: 'ulegacy', password: 'pwleg' }],
  })
  // A config-level default host: __global__ would otherwise bootstrap from it,
  // which is exactly what an explicit "active remote = none" must override.
  const h = await startHarness(t, { host: 'cfg-host', port: 2222, username: 'cfguser' }, home)
  const legacy = () => JSON.parse(readFileSync(path.join(rw, 'machines.json'), 'utf8')).list.find((m) => m.id === 'm-legacy')

  // 0) regression guard (a): fresh global with a config default and NO explicit
  // choice → the bootstrap display is intact (host + activeSource 'config')
  const g0 = (await h.route('/dsh-remote/status', 'GET')).json
  assert.equal(g0.host, 'cfg-host', 'bootstrap display: config host intact without an explicit clear')
  assert.equal(g0.activeSource, 'config', 'bootstrap display: activeSource is config')

  // 1) POST /current {id} → __global__ gains machineId in contexts.json
  const cur = await h.route('/dsh-remote/current', 'POST', { body: { id: 'm-legacy' } })
  assert.equal(cur.status, 200)
  assert.equal(cur.json.ok, true)
  assert.equal(cur.json.machineId, 'm-legacy', '/current binds the global context')
  const ctxs = JSON.parse(readFileSync(path.join(rw, 'contexts.json'), 'utf8'))
  assert.equal(ctxs.contexts['__global__'].machineId, 'm-legacy', '__global__ binding persisted in contexts.json')

  // Materialize the global pool (lazy by design) and seed its in-memory fs so
  // /workspace's isRemoteDir (sftp.stat) can confirm the candidate directories.
  await h.call('rw_exec', { command: 'ls' }, undefined)
  const gpool = h.factory.pools[h.factory.pools.length - 1]
  assert.equal(gpool.targets[0].host, 'h-legacy', 'global pool targets the bound machine')
  gpool.fs.mkdirSync('/proj')
  gpool.fs.mkdirSync('/proj2')

  // 2) agentless POST /workspace → machines.json rec.workspace + recentWorkspaces
  const ws1 = await h.route('/dsh-remote/workspace', 'POST', { body: { path: '/proj' } })
  assert.equal(ws1.status, 200)
  assert.equal(ws1.json.ok, true)
  assert.equal(legacy().workspace, '/proj', 'machine record gained the legacy workspace')
  assert.deepEqual(legacy().recentWorkspaces, ['/proj'], 'first pick recorded')
  // repeat pick → dedupe (no duplicate entry, no extra churn)
  await h.route('/dsh-remote/workspace', 'POST', { body: { path: '/proj' } })
  assert.deepEqual(legacy().recentWorkspaces, ['/proj'], 'repeat pick dedupes')
  // a second workspace → prepended, first kept
  const ws3 = await h.route('/dsh-remote/workspace', 'POST', { body: { path: '/proj2' } })
  assert.equal(ws3.status, 200)
  assert.deepEqual(legacy().recentWorkspaces, ['/proj2', '/proj'], 'second pick prepended')
  assert.equal(legacy().workspace, '/proj2', 'machine record tracks the latest pick')

  // 3) POST /current {id:''} → registry currentId null + __global__ inert
  const clear = await h.route('/dsh-remote/current', 'POST', { body: { id: '' } })
  assert.equal(clear.status, 200)
  assert.equal(clear.json.ok, true)
  const mach = JSON.parse(readFileSync(path.join(rw, 'machines.json'), 'utf8'))
  assert.equal(mach.currentId === undefined ? null : mach.currentId, null, 'registry currentId is null after explicit clear')
  const g = (await h.route('/dsh-remote/status', 'GET')).json
  assert.equal(g.contextId, '__global__')
  assert.equal(g.machineId, null, 'no binding after explicit clear')
  assert.equal(g.connected, false, 'no live pool after explicit clear')
  assert.equal(g.sessionMode, 'local', 'explicitNone: the global context is local, not config-bootstrapped')
  assert.equal(g.host, '', 'explicitNone: the config default host must not be reported as the context host')
  assert.equal(g.port, 22, 'explicitNone: inert default port, not the config default')
  assert.equal(g.username, '', 'explicitNone: the config default username must not be reported')
  assert.equal(g.activeSource, 'none', 'explicitNone: no active source (must not be "config")')
})

test('F6+hostKeyMode: save:false machineId connect carries proxy/useAgent/kbd/hostKeyMode; parity with web /connect', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-harness-f6-'))
  t.after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
  seedRegistry(home, {
    version: 1,
    list: [
      {
        id: 'm-rich', name: 'rich', host: 'h-rich', port: 22, username: 'urich', password: 'pwr',
        proxy: { host: 'jump.example', port: 2222, username: 'juser', password: 'jpw' },
        useAgent: true, keyboardInteractive: true, hostKeyMode: 'verify',
      },
      { id: 'm-plain', name: 'plain', host: 'h-plain', port: 22, username: 'uplain', password: 'pwpl' },
    ],
  })
  const h = await startHarness(t, {}, home)

  // tool path: rw_connect {machineId, save:false} on the rich machine
  const before = h.factory.pools.length
  await h.call('rw_connect', { machineId: 'm-rich', save: false }, 'session-f6')
  assert.equal(h.factory.pools.length, before + 1, 'tool connect materialized a pool')
  const tt = h.factory.pools[before].targets[0]
  assert.ok(tt, 'tool pool received setTarget')
  assert.equal(tt.host, 'h-rich')
  assert.equal(tt.username, 'urich')
  assert.equal(tt.password, 'pwr', 'machinePassword-resolved plain password reached setTarget')
  assert.equal(tt.proxy && tt.proxy.host, 'jump.example', 'proxy carried from the registry machine')
  assert.equal(tt.proxy && tt.proxy.port, 2222)
  assert.equal(tt.useAgent, true, 'useAgent carried')
  assert.equal(tt.keyboardInteractive, true, 'keyboardInteractive carried')
  assert.equal(tt.hostKeyMode, 'verify', 'hostKeyMode carried (no silent downgrade)')

  // web path: POST /connect {machineId} for a DIFFERENT session — strict parity
  const w = await h.route('/dsh-remote/connect', 'POST', { body: { machineId: 'm-rich', sessionId: 'web-f6' } })
  assert.equal(w.status, 200)
  assert.equal(w.json.ok, true, 'web /connect ok')
  const wt = h.factory.pools[h.factory.pools.length - 1].targets[0]
  for (const k of ['proxy', 'useAgent', 'keyboardInteractive', 'hostKeyMode', 'password']) {
    assert.deepEqual(wt[k], tt[k], `web /connect setTarget ${k} strictly equals the tool save:false value`)
  }

  // control: machine WITHOUT the fields → all four undefined in setTarget
  // (resolvePool falls back to the config defaults, as before)
  const before2 = h.factory.pools.length
  await h.call('rw_connect', { machineId: 'm-plain', save: false }, 'session-f6b')
  assert.equal(h.factory.pools.length, before2 + 1)
  const ct = h.factory.pools[before2].targets[0]
  assert.equal(ct.host, 'h-plain')
  assert.equal(ct.password, 'pwpl')
  for (const k of ['proxy', 'useAgent', 'keyboardInteractive', 'hostKeyMode']) {
    assert.equal(ct[k], undefined, `control machine: ${k} left undefined → config default`)
  }
})
