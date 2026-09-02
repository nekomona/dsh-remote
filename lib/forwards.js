// dsh-remote — SSH port forwarding manager (local & reverse tunnels).
//
// Local forward: listen on 127.0.0.1:<listenPort> → every connection is
// piped through the SSH channel to <targetHost>:<targetPort> on the remote.
// Reverse forward: ask the remote to listen on 127.0.0.1:<listenPort> and pipe
// incoming connections back to <targetHost>:<targetPort> on the LOCAL side
// (ssh2 `forwardIn` + the client `tcpip` event; requires AllowTcpForwarding on
// the remote sshd).
//
// Definitions persist in the GLOBAL forwards.json (one file, shared by every
// context). The manager is MULTI-POOL: each server entry remembers the pool
// (and that pool's live client) it runs on, so several agent-thread contexts
// can hold concurrent tunnels to their own remotes. autoStart local defs are
// re-created on connect, but ONLY on pools whose bound machineId matches the
// def's machineId (a null def machineId matches any pool). Every tunnel of a
// pool is torn down when THAT pool's client closes (detach) — reverse tunnels
// are never auto-restarted (they would re-expose a local port without asking).
import net from 'node:net'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export class ForwardManager {
  /** @param {{ file?: string }} opts defs persisted in the global forwards.json. */
  constructor({ file } = {}) {
    this.file = file || null
    this.defs = this._load()
    /** id → { kind, server?, sockets:Set, client, pool, def } */
    this.servers = new Map()
    /** live client → { pool, onTcpip, onClose } (per-pool listeners). */
    this.clients = new Map()
    /** def ids with a start in flight — re-entrant start/attach must not
     *  double-start (the listen callback registers the server late). */
    this._starting = new Set()
  }

  _load() {
    if (!this.file) return []
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(j.defs)) return j.defs
    } catch {}
    return []
  }

  _save() {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ defs: this.defs }, null, 2))
    } catch {}
  }

  /** Called from pool.onReady(client): register this client's listeners and
   *  auto-start the autoStart local defs that match THIS pool's bound machine
   *  (def.machineId null matches any pool; a def bound to another machine is
   *  not started here). The auto-start pass runs only when the client is NEW
   *  (a fresh SSH connection / reconnect), never on re-entrant attach calls
   *  from start() — otherwise a starting def re-triggers itself forever. */
  attach(client, pool) {
    if (!client) return
    let isNew = false
    if (!this.clients.has(client)) {
      const onTcpip = (info, accept, reject) => this._handleTcpip(client, info, accept, reject)
      const onClose = () => this.detach(client)
      client.on('tcpip', onTcpip)
      client.on('close', onClose)
      this.clients.set(client, { pool, onTcpip, onClose })
      isNew = true
    }
    if (!isNew) return
    for (const d of this.defs) {
      if (d.autoStart && d.direction === 'local' && !this.servers.has(d.id) && !this._starting.has(d.id)) {
        if (d.machineId == null || d.machineId === ((pool && pool.boundMachineId) || null)) {
          this.start(d, pool) // start() guards concurrent starts via _starting
        }
      }
    }
  }

  /** Called from pool.onCloseHook(client): stop ONLY this client's servers
   *  and remove its listeners. Other pools' forwards keep running. */
  detach(client) {
    if (!client) return
    const st = this.clients.get(client)
    if (st) {
      if (st.onTcpip) { try { client.removeListener('tcpip', st.onTcpip) } catch {} }
      if (st.onClose) { try { client.removeListener('close', st.onClose) } catch {} }
      this.clients.delete(client)
    }
    for (const [id, entry] of [...this.servers]) {
      if (entry.client === client) this.stop(id)
    }
  }

  list() {
    return this.defs.map((d) => ({
      id: d.id,
      direction: d.direction,
      listenPort: d.listenPort,
      targetHost: d.targetHost,
      targetPort: d.targetPort,
      machineId: d.machineId || null,
      autoStart: !!d.autoStart,
      active: this.servers.has(d.id),
    }))
  }

  /** Defs whose tunnel is currently running on this exact pool. */
  activeFor(pool) {
    if (!pool) return []
    return this.defs.filter((d) => {
      const e = this.servers.get(d.id)
      return e && e.pool === pool
    })
  }

  _defId() {
    return 'fwd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  }

  /** Create a forward definition (persisted globally). Does NOT start it. */
  define({ direction = 'local', listenPort, targetHost, targetPort, autoStart = false, machineId } = {}) {
    const d = {
      id: this._defId(),
      direction: direction === 'reverse' ? 'reverse' : 'local',
      listenPort: Number(listenPort),
      targetHost: String(targetHost || '127.0.0.1'),
      targetPort: Number(targetPort),
      autoStart: !!autoStart,
      machineId: machineId || null,
    }
    this.defs.push(d)
    this._save()
    return d
  }

  remove(id) {
    this.stop(id)
    const i = this.defs.findIndex((d) => d.id === id)
    if (i >= 0) { this.defs.splice(i, 1); this._save(); return true }
    return false
  }

  /** Start a def on an EXPLICIT pool (multi-pool). The server entry
   *  remembers pool + client so detach/stop target the right tunnel.
   *  Concurrent starts of the same def coalesce (never rejects). */
  async start(def, pool) {
    const d = this.defs.find((x) => x.id === def.id) || def
    if (this.servers.has(d.id) || this._starting.has(d.id)) return { ok: true, active: true }
    this._starting.add(d.id)
    try {
      const client = await pool.connect()
      this.attach(client, pool)
      if (this.servers.has(d.id)) return { ok: true, active: true } // auto pass beat us
      if (d.direction === 'reverse') {
        await this._startReverse(d, client, pool)
      } else {
        await this._startLocal(d, client, pool)
      }
      return { ok: true, active: true }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    } finally {
      this._starting.delete(d.id)
    }
  }

  _startLocal(d, client, pool) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        client.forwardOut('127.0.0.1', 0, d.targetHost, d.targetPort, (err, channel) => {
          if (err) { socket.destroy(); return }
          socket.pipe(channel)
          channel.pipe(socket)
          const kill = () => { try { socket.destroy() } catch {}; try { channel.close() } catch {} }
          socket.on('error', kill)
          channel.on('error', kill)
          socket.on('close', kill)
          channel.on('close', kill)
        })
      })
      server.on('error', (e) => reject(new Error(`本地转发 ${d.listenPort} 启动失败: ${e.message}`)))
      server.listen(d.listenPort, '127.0.0.1', () => {
        this.servers.set(d.id, { kind: 'local', server, sockets: new Set(), client, pool, def: d })
        resolve()
      })
    })
  }

  _startReverse(d, client, pool) {
    return new Promise((resolve, reject) => {
      // ssh2 calls the remote TCP listen API `forwardIn` (NOT openssh_forwardIn,
      // which in ssh2 >= 1.16 is stream-local only).
      if (typeof client.forwardIn !== 'function') {
        return reject(new Error('此 ssh2 版本不支持反向转发 (forwardIn)'))
      }
      client.forwardIn('127.0.0.1', d.listenPort, (err) => {
        if (err) return reject(new Error(`远端监听 ${d.listenPort} 失败: ${(err && err.message) || err}`))
        this.servers.set(d.id, { kind: 'reverse', sockets: new Set(), client, pool, def: d })
        resolve()
      })
    })
  }

  /** Per-client reverse-tunnel handler: route the incoming channel to the
   *  local target of the matching REVERSE entry of THIS client (the entry's
   *  own def — never globals from another pool). */
  _handleTcpip(client, info, accept, reject) {
    for (const entry of this.servers.values()) {
      if (entry.client === client && entry.kind === 'reverse' && entry.def && Number(info.destPort) === Number(entry.def.listenPort)) {
        const channel = accept()
        const socket = net.connect({ host: entry.def.targetHost, port: entry.def.targetPort })
        socket.pipe(channel)
        channel.pipe(socket)
        entry.sockets.add(socket)
        const kill = () => {
          try { socket.destroy() } catch {}
          try { channel.close() } catch {}
          entry.sockets.delete(socket)
        }
        socket.on('error', kill)
        channel.on('error', kill)
        socket.on('close', kill)
        return
      }
    }
    reject()
  }

  stop(id) {
    const entry = this.servers.get(id)
    if (!entry) return
    try {
      if (entry.kind === 'local') {
        entry.server.close()
        for (const s of entry.sockets) { try { s.destroy() } catch {} }
      } else if (entry.client && typeof entry.client.unforwardIn === 'function' && entry.def) {
        entry.client.unforwardIn('127.0.0.1', entry.def.listenPort, () => {})
      }
    } catch {}
    this.servers.delete(id)
  }

  stopAll() {
    for (const id of [...this.servers.keys()]) this.stop(id)
    for (const client of [...this.clients.keys()]) this.detach(client)
  }
}
