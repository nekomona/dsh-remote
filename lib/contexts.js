// dsh-remote — per-agent-thread remote context store.
//
// The active remote context (machine binding + workspace + SSH pool + forwards)
// is per AGENT THREAD, keyed by the caller agent's id (which is always equal to
// its session id — enforced by dsh-agent's AgentRegistry). A new agent thread
// starts UNBOUND (issue #13 philosophy extended from the machine registry to
// contexts): it never inherits store.currentId, the config-default host, or any
// parent's binding. Binding is explicit (rw_connect / web /connect).
//
// The reserved key '__global__' is the legacy machine-global context for
// agentless callers (web routes without sessionId, slash commands, the settings
// UI): it keeps the config-default bootstrap, the registry currentId as its
// binding source, and the startup auto-restore probe.
//
// Persistence — <rootDir>/contexts.json:
//   { "version": 1, "contexts": { "<id>": { "machineId": "m-…", "workspace": "/abs", "updatedAt": "…" } } }
// Only REGISTRY machine references + workspace are persisted (atomic
// tmp+rename write). Ephemeral (save:false) bindings are in-memory only and are
// NEVER written. A corrupt/unreadable file falls back to an empty store; the
// next save atomically replaces it (mirrors loadMachines / loadKnownHosts).
//
// Pool lifecycle — one SshPool per live context, created lazily on first use
// through the injectable poolFactory (test hook). Pools are LRU-capped
// (maxLive) and idle-evicted (idleMs); eviction closes the pool (which stops
// that pool's forwards via the onCloseHook → ForwardManager.detach wiring) and
// clears the context's auto-push watchers, but KEEPS the persisted binding —
// it re-materializes on next use. An ephemeral binding is lost on eviction.
//
// This module is pure-ish (no ssh2, no plugin imports) so it is unit-testable
// with fake pools.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

/** Reserved context id for agentless callers (web routes without sessionId,
 *  slash commands, settings UI). Already satisfies the sanitize rule. */
export const GLOBAL_CONTEXT_ID = '__global__'

/** Sanitize a raw context id into a safe store key / audit segment.
 *  The encodeSegmentSafe rule: alnum + `_` `-` `.` survive, everything else
 *  becomes `_`; an empty id becomes 'session'. Real session ids are UUIDs
 *  (unchanged by the rule); the rule exists so exotic ids can never inject
 *  path separators into contexts.json keys or audit lines. */
export function sanitizeContextId(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9._-]/g, '_')
  return s || 'session'
}

/** Resolve the context id from a tool execution object (§2.3, normative):
 *  exec?.agent?.id → exec?.agent?.session?.id → '__global__'.
 *  Empty/missing ids are rejected (agentless call paths fall back to the
 *  reserved global context). */
export function agentContextId(exec) {
  const agent = exec && exec.agent
  const raw = (agent && (agent.id || (agent.session && agent.session.id)))
  if (typeof raw === 'string' && raw.trim()) return sanitizeContextId(raw)
  return GLOBAL_CONTEXT_ID
}

export class ContextStore {
  /**
   * @param {object} options
   * @param {string} options.rootDir  remoteWorkspacesRoot() — contexts.json lives here.
   * @param {() => {list: object[], currentId: string|null, explicitNone: boolean}} [options.registry]
   *        Live view of the (global) machine registry.
   * @param {() => object} [options.configDefaults]  () => plugin config (global bootstrap source).
   * @param {(machineConfig: object) => object} [options.poolFactory]
   *        Builds a pool for a machine config. Default is identity (apply() always
   *        injects the real factory, e.g. (cfg) => new SshPool(cfg)).
   * @param {(machine: object) => Promise<string>} [options.machinePassword]
   *        Resolves a machine's effective password (plain or keychain).
   * @param {number} [options.maxLive]  Max simultaneously live pools (default 8).
   * @param {number} [options.idleMs]   Idle eviction threshold; 0 disables (default 1800000).
   * @param {() => number} [options.now]  Clock (injectable for tests).
   * @param {{warn?: (msg: string) => void}} [options.logger]  Warns on corrupt-file fallback.
   * @param {(contextId: string, entry: object) => void} [options.onEvict]
   *        Called when a context's pool is released (eviction / closePool) so the
   *        owner can clear that context's auto-push watchers.
   */
  constructor(options = {}) {
    this.rootDir = options.rootDir || ''
    this.registry = options.registry || (() => ({ list: [], currentId: null, explicitNone: false }))
    this.configDefaults = options.configDefaults || (() => ({}))
    this.poolFactory = options.poolFactory || ((cfg) => cfg)
    this.machinePassword = options.machinePassword || (async () => '')
    const maxLive = Number(options.maxLive)
    this.maxLive = Number.isFinite(maxLive) && maxLive > 0 ? Math.floor(maxLive) : 8
    const idleMs = Number(options.idleMs)
    this.idleMs = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : 1800000
    this.now = options.now || (() => Date.now())
    this.logger = options.logger || null
    this.onEvict = options.onEvict || null
    /** Live in-memory context records, keyed by sanitized id. */
    this.entries = new Map()
    /** Persisted disk state (the single source of truth for contexts.json). */
    this.persisted = new Map()
    this._loaded = false
  }

  _file() {
    return path.join(this.rootDir, 'contexts.json')
  }

  /** Load contexts.json once (corrupt/unreadable/wrong-shape → empty store). */
  _ensureLoaded() {
    if (this._loaded || !this.rootDir) {
      this._loaded = true
      return
    }
    this._loaded = true
    try {
      const j = JSON.parse(readFileSync(this._file(), 'utf8'))
      const ctxs = j && typeof j === 'object' ? j.contexts : null
      if (ctxs && typeof ctxs === 'object' && !Array.isArray(ctxs)) {
        for (const [k, v] of Object.entries(ctxs)) {
          if (v && typeof v === 'object' && typeof v.machineId === 'string' && v.machineId) {
            this.persisted.set(sanitizeContextId(k), {
              machineId: String(v.machineId),
              workspace: String(v.workspace || ''),
              updatedAt: String(v.updatedAt || ''),
            })
          }
        }
        return
      }
      // Wrong shape → empty store (the next save replaces the file).
      this.persisted = new Map()
    } catch (err) {
      this.persisted = new Map()
      if (this.logger && typeof this.logger.warn === 'function') {
        try {
          this.logger.warn('contexts.json unreadable or corrupt — starting with an empty context store: ' + String((err && err.message) || err))
        } catch { /* logging must never break the store */ }
      }
    }
  }

  /** Atomic write: tmp file in the same dir + rename (a crashed write can
   *  never leave a torn contexts.json). Ephemeral entries are never written. */
  _save() {
    if (!this.rootDir) return
    const contexts = {}
    for (const [k, rec] of this.persisted) {
      contexts[k] = {
        machineId: rec.machineId,
        workspace: rec.workspace || '',
        updatedAt: rec.updatedAt || new Date(this.now()).toISOString(),
      }
    }
    try {
      mkdirSync(this.rootDir, { recursive: true })
      const file = this._file()
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify({ version: 1, contexts }, null, 2))
      renameSync(tmp, file)
    } catch { /* best-effort: the in-memory state stays authoritative */ }
  }

  _touch(entry) {
    entry.lastUsed = this.now()
  }

  /** Get the live entry for a context id, materializing it from
   *  contexts.json when absent in memory. The pool is NOT created here —
   *  pools are lazy (resolvePool). */
  getOrCreate(id) {
    const key = sanitizeContextId(id)
    let e = this.entries.get(key)
    if (e) return e
    this._ensureLoaded()
    const p = this.persisted.get(key)
    e = {
      id: key,
      machineId: p ? p.machineId : null,
      workspace: p ? p.workspace : '',
      updatedAt: p ? p.updatedAt : null,
      ephemeralMachine: null,
      pool: null,
      lastUsed: this.now(),
      staleError: null,
    }
    this.entries.set(key, e)
    return e
  }

  /** Non-creating lookup (used by the system-prompt section, which must not
   *  trigger any side effects). */
  peek(id) {
    const key = sanitizeContextId(id)
    return this.entries.get(key) || null
  }

  /** Bump LRU/idle bookkeeping for a context use. */
  touch(id) {
    const e = this.entries.get(sanitizeContextId(id))
    if (e) this._touch(e)
  }

  /** The entry's binding as { machineId, workspace } without creating the
   *  live entry (live entry first, then contexts.json). */
  bindingOf(id) {
    const key = sanitizeContextId(id)
    this._ensureLoaded()
    const e = this.entries.get(key)
    const p = this.persisted.get(key)
    return {
      machineId: (e && e.machineId) || (p && p.machineId) || null,
      workspace: (e && e.workspace) || (p && p.workspace) || '',
    }
  }

  /** Bind the context to a REGISTRY machine (persistent). Persists
   *  { machineId, workspace } to contexts.json. Clears any ephemeral binding. */
  bind(id, machineId) {
    const entry = this.getOrCreate(id)
    this._ensureLoaded()
    entry.machineId = String(machineId)
    entry.ephemeralMachine = null
    entry.staleError = null
    const rec = {
      machineId: entry.machineId,
      workspace: entry.workspace || '',
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.persisted.set(entry.id, rec)
    entry.updatedAt = rec.updatedAt
    this._save()
    return entry
  }

  /** Bind the context to a full in-memory machine record (save:false /
   *  explicit-host binds). NEVER persisted — gone on restart or eviction. */
  bindEphemeral(id, machine) {
    const entry = this.getOrCreate(id)
    entry.machineId = null
    entry.ephemeralMachine = machine || null
    entry.staleError = null
    return entry
  }

  /** Unbind (persistent + ephemeral); drops the persisted record if any.
   *  The workspace and pool are left alone (use clear() for a full reset). */
  clearBinding(id) {
    const key = sanitizeContextId(id)
    this._ensureLoaded()
    const entry = this.entries.get(key)
    if (entry) {
      entry.machineId = null
      entry.ephemeralMachine = null
      entry.staleError = null
    }
    if (this.persisted.delete(key)) this._save()
    return entry || null
  }

  /** Full reset: unbind + clear workspace + close the pool. */
  clear(id) {
    const entry = this.getOrCreate(id)
    this.clearBinding(entry.id)
    entry.workspace = ''
    this.closePool(entry.id)
    return entry
  }

  /** Set the context workspace. Persists it when the binding is persistent,
   *  and re-targets the live pool's config (workspace is pool-visible state
   *  the tools and harnesses read off setTarget). */
  setWorkspace(id, p) {
    const entry = this.getOrCreate(id)
    entry.workspace = String(p || '')
    if (entry.machineId) {
      this._ensureLoaded()
      const rec = this.persisted.get(entry.id) || {
        machineId: entry.machineId,
        updatedAt: new Date(this.now()).toISOString(),
      }
      rec.workspace = entry.workspace
      rec.updatedAt = new Date(this.now()).toISOString()
      this.persisted.set(entry.id, rec)
      entry.updatedAt = rec.updatedAt
      this._save()
    }
    if (entry.pool && typeof entry.pool.setTarget === 'function') {
      try { entry.pool.setTarget({ workspace: entry.workspace }) } catch { /* pool state is best-effort */ }
    }
    this._touch(entry)
    return entry
  }

  /** Effective workspace: the context's own, else the bound machine's stored
   *  workspace (a registry machine remembers its last-used workspace). */
  workspaceOf(id) {
    const entry = this.getOrCreate(id)
    if (entry.workspace) return entry.workspace
    const m = this.activeMachineOf(entry.id)
    return (m && m.workspace) || ''
  }

  _registryMachine(id) {
    if (!id) return null
    let reg = null
    try { reg = this.registry() } catch { reg = null }
    const list = (reg && reg.list) || []
    return list.find((m) => m && m.id === id) || null
  }

  _configDefaultMachine() {
    let c = null
    try { c = this.configDefaults() } catch { c = null }
    if (!c || !c.host) return null
    return {
      id: '__config__',
      name: c.host,
      host: c.host,
      port: Number(c.port) || 22,
      username: c.username || '',
      password: c.password || '',
      privateKeyPath: c.privateKeyPath || '',
      passphrase: c.passphrase || '',
      useAgent: !!c.useAgent,
      keyboardInteractive: !!c.keyboardInteractive,
      proxy: c.proxy && c.proxy.host ? c.proxy : undefined,
      hostKeyMode: c.hostKeyMode || '',
      workspace: c.workspace || '',
    }
  }

  /** The machine record this context is bound to, or null when unbound.
   *  Resolution order: ephemeral record → persisted machineId → (global only)
   *  registry currentId → (global only, unless the registry explicitly chose
   *  "none") config-default machine. A persisted machineId that no longer
   *  exists in the registry sets entry.staleError and resolves to null. */
  activeMachineOf(id) {
    const entry = this.getOrCreate(id)
    if (entry.ephemeralMachine) return entry.ephemeralMachine
    if (entry.machineId) {
      const m = this._registryMachine(entry.machineId)
      if (!m) {
        entry.staleError = `binding machine ${entry.machineId} no longer exists in registry — call rw_connect again`
        return null
      }
      return m
    }
    if (entry.id === GLOBAL_CONTEXT_ID) {
      let reg = null
      try { reg = this.registry() || {} } catch { reg = {} }
      if (reg.currentId) {
        const m = this._registryMachine(reg.currentId)
        if (m) return m
      }
      if (!reg.explicitNone) {
        const d = this._configDefaultMachine()
        if (d) return d
      }
    }
    return null
  }

  _machineConfig(machine, pw, entry) {
    let c = null
    try { c = this.configDefaults() || {} } catch { c = {} }
    return {
      ...c,
      host: machine.host,
      port: Number(machine.port) || 22,
      username: machine.username || '',
      password: pw !== undefined && pw !== null ? String(pw) : (machine.password || ''),
      privateKeyPath: machine.privateKeyPath || '',
      passphrase: machine.passphrase || '',
      workspace: entry.workspace || machine.workspace || (c.workspace || ''),
      useAgent: typeof machine.useAgent === 'boolean' ? machine.useAgent : !!c.useAgent,
      keyboardInteractive: typeof machine.keyboardInteractive === 'boolean' ? machine.keyboardInteractive : !!c.keyboardInteractive,
      proxy: machine.proxy && machine.proxy.host ? machine.proxy : (c.proxy || undefined),
      hostKeyMode: machine.hostKeyMode || c.hostKeyMode || 'accept-new',
    }
  }

  /** Close a context's pool, keeping its binding (rw_disconnect semantics). */
  closePool(id) {
    this._releasePool(sanitizeContextId(id), { keepBinding: true })
  }

  _releasePool(key, { keepBinding = true } = {}) {
    const entry = this.entries.get(key)
    if (!entry || !entry.pool) return
    const pool = entry.pool
    entry.pool = null
    try { pool.close() } catch { /* pool close is best-effort */ }
    // An ephemeral (in-memory-only) binding is lost when its pool goes away.
    if (!keepBinding) entry.ephemeralMachine = null
    if (this.onEvict) {
      try { this.onEvict(key, entry) } catch { /* owner hook is best-effort */ }
    }
  }

  /** LRU: evict oldest-lastUsed live pools until we are under the cap
   *  (the context being materialized is exempt). Eviction keeps the
   *  persisted binding; it re-materializes on next use. */
  _enforceLRU(key) {
    for (;;) {
      const live = []
      for (const e of this.entries.values()) {
        if (e.pool && e.id !== key) live.push(e)
      }
      if (live.length < this.maxLive) break
      let oldest = null
      for (const e of live) if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e
      if (!oldest) break
      this._releasePool(oldest.id, { keepBinding: !oldest.ephemeralMachine })
    }
  }

  /** Idle sweep: close pools of live contexts idle for longer than idleMs.
   *  idleMs = 0 disables idle eviction. Called by the (unref'd) interval in
   *  apply(); also invokable directly by tests. */
  sweepIdle() {
    if (!(this.idleMs > 0)) return
    const now = this.now()
    for (const entry of [...this.entries.values()]) {
      if (entry.pool && now - entry.lastUsed > this.idleMs) {
        this._releasePool(entry.id, { keepBinding: !entry.ephemeralMachine })
      }
    }
  }

  /** Dispose: close every live pool (bindings + persisted state survive). */
  closeAll() {
    for (const key of [...this.entries.keys()]) {
      this._releasePool(key, { keepBinding: true })
    }
  }

  _dropStale(entry) {
    entry.staleError = `binding machine ${entry.machineId} no longer exists in registry — call rw_connect again`
    entry.machineId = null
    this._ensureLoaded()
    if (this.persisted.delete(entry.id)) this._save()
    if (entry.pool) {
      this._releasePool(entry.id, { keepBinding: true })
    }
  }

  /** Lazily materialize the context's pool (or null when the context is
   *  unbound). Rebuilds from the persisted/ephemeral binding when no pool is
   *  live (after restart or eviction): registry lookup → machinePassword()
   *  (plain or keychain) → poolFactory(...) → setTarget(machine + password).
   *  No write-back to contexts.json on read. */
  async resolvePool(id) {
    const entry = this.getOrCreate(id)
    // Stale reference: the persisted machine vanished from the registry.
    // Drop the persisted entry (atomic save) and report unbound (§3).
    if (entry.machineId && !this._registryMachine(entry.machineId)) {
      this._dropStale(entry)
      return null
    }
    const machine = this.activeMachineOf(entry.id)
    if (!machine) return null
    // Already live on the same machine → reuse.
    if (entry.pool && entry.pool.boundMachineId === (machine.id || null)) {
      this._touch(entry)
      return entry.pool
    }
    // Machine changed (or first use): close the old pool first.
    if (entry.pool) {
      this._releasePool(entry.id, { keepBinding: true })
    }
    this._enforceLRU(entry.id)
    let pw = ''
    try { pw = (await this.machinePassword(machine)) || '' } catch { pw = '' }
    const pool = this.poolFactory(this._machineConfig(machine, pw, entry))
    pool.boundMachineId = machine.id || null
    if (typeof pool.setTarget === 'function') {
      try {
        pool.setTarget({
          host: machine.host,
          port: Number(machine.port) || 22,
          username: machine.username || '',
          password: pw,
          privateKeyPath: machine.privateKeyPath || '',
          passphrase: machine.passphrase || '',
          workspace: entry.workspace || '',
          useAgent: typeof machine.useAgent === 'boolean' ? machine.useAgent : undefined,
          keyboardInteractive: typeof machine.keyboardInteractive === 'boolean' ? machine.keyboardInteractive : undefined,
          proxy: machine.proxy && machine.proxy.host ? machine.proxy : undefined,
          hostKeyMode: machine.hostKeyMode || undefined,
        })
      } catch { /* factories without setTarget are allowed (pure fakes) */ }
    }
    entry.pool = pool
    entry.staleError = null
    this._touch(entry)
    return pool
  }
}
