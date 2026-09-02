// dsh-remote — remote-work assistant for DeepSeek Harness.
//
// Host half. Turns "give me a remote host + login" into a usable REMOTE WORKSPACE:
//   • one persistent SSH/SFTP pool per configured remote (password OR private key,
//     SSH agent, keyboard-interactive, proxy jump),
//   • a "current remote workspace" — a remote directory the agent treats as the
//     active project root (user@host:/path) — injected into every system prompt,
//   • model tools `rw_*` (info/connect/workspace/list/read/write/edit/append/mkdir/
//     remove/move/stat/exec/search/download/upload/sync/push/forward/disconnect),
//   • JSON endpoints the client settings page + sidebar use over the harness
//     `webServer` (machines / ls / read / write / fs / forwards / task / audit /
//     ssh-config / local-pick / …),
//   • local mirror of the remote workspace (three-way conflict-aware SFTP sync),
//   • optional OS-keychain password storage, command audit log, TOFU host keys.
//
// The engine (path guard + shell quoting + ssh pool + exec) keeps the proven
// foundation; `ctx.fs` / the local workspace registry stay untouched — this is a
// REMOTE workspace presented as such to the model and UI.
//
// Plugin Config MUST be a schemastery schema (zod rejects the undefined row config).
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ssh2 from 'ssh2'
import { execFile } from 'node:child_process'
import zlib from 'node:zlib'
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, utimesSync, appendFileSync, unlinkSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'

import {
  shq, normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs,
  toSftpPath, toShellPath, toDisplayPath, remotePathBase, truncate, shortHash, relPathUnder,
} from './paths.js'
import { blobAlgorithm, keyFingerprint } from './hostkey.js'
import { compileIgnore, DEFAULT_IGNORE } from './ignore.js'
import { friendlyMessage } from './errors.js'
import { importableEntries, sshConfigPath, readSshConfigText } from './sshconfig.js'
import { saveSecret, getSecret, deleteSecret, platformBackend } from './credential.js'
import { syncTree, pushTree, loadSyncState, saveSyncState, pushOneFile } from './sync.js'
import { searchTree } from './search.js'
import { TaskManager } from './tasks.js'
import { ForwardManager } from './forwards.js'
import { ContextStore, agentContextId, sanitizeContextId, GLOBAL_CONTEXT_ID } from './contexts.js'
import { selfDir, readVersion, gtVersion, fetchLatestVersion, applyUpdate, persistUpdateMode, readUpdateMode } from './update.js'
import { loadMachines as _loadMachines, saveMachines as _saveMachines, sanitizeMachine as _sanitizeMachine, applyMachine as _applyMachine, machineId as _machineId } from './registry.js'

const { Client } = ssh2

export const name = 'dsh-remote'

// tools + systemPrompt + webServer are required. webServer is INJECTED (not just
// lazily read) so this plugin activates only after the web server is up — otherwise
// apply() runs ahead of webServer and the /dsh-remote/* JSON routes never register.
export const inject = ['tools', 'systemPrompt', 'webServer']

export const Config = z.object({
  /** Remote SSH host (empty → the plugin starts disconnected). */
  host: z.string().default(''),
  /** Remote SSH port (22 unless the machine uses a custom port). */
  port: z.number().step(1).min(1).max(65535).default(22),
  /** SSH login user. */
  username: z.string().default(''),
  /** Password login (only when the remote has no key. Override the fallback below). */
  password: z.string().default(''),
  /** Explicit SSH private-key path (optional; only used when supplied). Never auto-reads ~/.ssh. */
  privateKeyPath: z.string().default(''),
  /** Key passphrase when the key is encrypted. */
  passphrase: z.string().default(''),
  /** Initial remote workspace path (absolute dir the agent should treat as root). */
  workspace: z.string().default(''),
  /** Remote command terminal strategy. '' = auto-detect (Windows remotes look
   * for Git Bash and pipe every command through `bash -s`); 'git-bash' = prefer
   * Git Bash on Windows; 'native' = never wrap; any other value = explicit
   * bash.exe path (e.g. 'C:\\Program Files\\Git\\bin\\bash.exe'). Git Bash makes
   * a Windows remote behave like a POSIX host (/c/Users/... paths). */
  shell: z.string().default(''),
  /** Per-command timeout. */
  commandTimeoutMs: z.number().step(1).min(1000).default(20000),
  /** SSH connection establishment timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** Hard ceiling on collected remote output per call. */
  maxOutputChars: z.number().step(1).min(1024).default(200000),
  /** Skip mirroring files larger than this many bytes (0 = no cap). */
  maxFileBytes: z.number().step(1).min(0).default(52428800),
  /** Host-key policy: `accept-new` (default) records a host's key on first
   * connect and verifies it afterwards (mirrors ssh's StrictHostKeyChecking
   * accept-new); `verify` also rejects hosts never seen before; `off` skips
   * verification entirely (MITM-unsafe, not recommended). */
  hostKeyMode: z.string().default('accept-new'),
  /** Use the OpenSSH agent (SSH_AUTH_SOCK) when no password/key is configured. */
  useAgent: z.boolean().default(false),
  /** Allow keyboard-interactive auth (OTP/MFA chains) using the configured password. */
  keyboardInteractive: z.boolean().default(false),
  /** Jump host / bastion: connect through this machine first. All fields have
   * defaults so this works on schemastery versions without `.optional()`; an
   * empty `host` means "no jump host". */
  proxy: z.object({
    host: z.string().default(''),
    port: z.number().step(1).min(1).max(65535).default(22),
    username: z.string().default(''),
    password: z.string().default(''),
    privateKeyPath: z.string().default(''),
  }),
  /** Auto-push edited mirror files back to the remote (watcher, debounced). Default off. */
  autoPush: z.boolean().default(false),
  /** Append executed commands to the audit log under the harness home. */
  auditLog: z.boolean().default(true),
  /** Text encoding for remote file reads/writes (utf-8 default; gbk etc.). */
  encoding: z.string().default('utf-8'),
  /** Update mode: `manual` (default) only checks when asked; `auto` checks on
   * load and periodically, applying a newer npm release automatically;
   * `off` disables version checks entirely. (schemastery 3.18 has no .enum —
   * keep string and validate in code.) */
  updateMode: z.string().default('manual'),
  /** How often (ms) auto mode checks the npm registry for a newer release. */
  updateCheckIntervalMs: z.number().step(1).min(60000).default(6 * 3600 * 1000),
  /** Max simultaneously live per-context SSH pools (including __global__);
   * the least-recently-used pool beyond the cap is evicted (its binding on
   * disk is kept and re-materializes on next use). */
  maxRemoteContexts: z.number().step(1).min(1).default(8),
  /** Idle threshold (ms) after which an unused context's pool is closed;
   * 0 disables idle eviction. */
  remoteContextIdleMs: z.number().step(1).min(0).default(1800000),
})

// ── shell / path helpers (pure implementations in lib/paths.js) ───────────

/** Harness home: respect `DSH_HOME` when set (the desktop app sets it to its
 * own `userData/harness`), otherwise fall back to `~/.dsh`. */
function dshBase() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(homedir(), '.dsh')
}

/** Root holding every remote host's mirrors + the machine registry. */
function remoteWorkspacesRoot() {
  return path.join(dshBase(), 'remote-workspaces')
}

/** Safe path segment for a session id (mirrors DSH's encodeSegment: alnum + _- .).
 *  Session dirs keep the id mostly verbatim; sanitize anything exotic.
 *  Single rule shared with the per-context ids (lib/contexts.js). */
function encodeSegmentSafe(id) {
  return sanitizeContextId(id)
}

/** Read the cwd from a session log header. Handles plain JSONL, .gz, and
 *  multi-frame zstd (decompress only the first frame, which holds the header).
 *  Returns the header cwd string, or '' when unreadable/absent. */
function readSessionHeaderCwd(file) {
  try {
    let buf = readFileSync(file)
    if (/\.zstd$/.test(file)) {
      buf = zlib.zstdDecompressSync(buf)
    } else if (/\.gz$/.test(file)) {
      buf = zlib.gunzipSync(buf)
    }
    const nl = buf.indexOf(10)
    if (nl < 0) return ''
    const head = JSON.parse(buf.subarray(0, nl).toString('utf8'))
    return typeof head.cwd === 'string' ? head.cwd : ''
  } catch {
    return ''
  }
}

/** Local mirrors of one remote host. */
function mirrorRootFor(host, user, port) {
  const tag = [host, user, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(remoteWorkspacesRoot(), tag)
}

/** Local mirror dir for a specific remote path (idempotent → returns same dir). */
function mirrorDirFor(remotePath, host, user, port) {
  const base = remotePathBase(remotePath)
  const root = mirrorRootFor(host, user, port)
  const plain = path.join(root, base)
  const norm = normalizeRemotePath(remotePath)
  // A pre-existing mirror for this exact remote origin → reuse it (idempotent).
  try {
    const meta = JSON.parse(readFileSync(path.join(plain, '.dsh-remote-meta.json'), 'utf8'))
    if (meta.remotePath === norm) return plain
  } catch {
    /* no mirror yet → fall through */
  }
  if (!existsSync(plain)) return plain
  return path.join(root, base + '-' + shortHash(norm))
}

/** Create the local mirror dir + a meta file describing its remote origin. */
function ensureMirror(remotePath, host, user, port) {
  const dir = mirrorDirFor(remotePath, host, user, port)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, '.dsh-remote-meta.json'),
    JSON.stringify({ host, port, username: user, remotePath: normalizeRemotePath(remotePath), createdAt: new Date().toISOString() }, null, 2),
  )
  return dir
}

/** Recursive directory copy (EXDEV fallback for migrateLegacyData). */
function copyDirSync(from, to) {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    if (e.isDirectory()) copyDirSync(s, d)
    else try { copyFileSync(s, d) } catch { /* skip unreadable */ }
  }
}

/** One-time migration of pre-0.6 data (~/.dsh/remote-workspaces) into DSH_HOME.
 * Only runs when the harness is on its DEFAULT home: an explicitly-set DSH_HOME
 * pointing elsewhere means ~/.dsh belongs to another installation — migrating
 * would RENAME that other installation's live data out from under it. */
function migrateLegacyData() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim() && path.resolve(String(env).trim()) !== path.join(homedir(), '.dsh')) return
  const legacy = path.join(homedir(), '.dsh', 'remote-workspaces')
  const target = remoteWorkspacesRoot()
  if (legacy === target || !existsSync(legacy) || existsSync(target)) return
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    try {
      renameSync(legacy, target)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      copyDirSync(legacy, target)
    }
  } catch {
    // Migration is best-effort: a fresh registry is created on next save.
  }
}

// ── persistent multi-machine registry ─────────────────────────────────────
// Pure registry logic lives in lib/registry.js (unit-tested): saved machines
// are STANDBY connections; only an explicit "set current" activates one.
// (issue #13 — Saved Connections != Active Remote Context)
const MACHINES_FILE = 'machines.json'
const machinesFile = () => path.join(remoteWorkspacesRoot(), MACHINES_FILE)
const secretsDir = () => path.join(remoteWorkspacesRoot(), '.secrets')
const forwardsFile = () => path.join(remoteWorkspacesRoot(), 'forwards.json')
const auditFile = () => path.join(remoteWorkspacesRoot(), 'audit.log')
const ignoreFile = () => path.join(remoteWorkspacesRoot(), '.dsh-remote-ignore')

const loadMachines = () => _loadMachines(machinesFile())
const saveMachines = (list, currentId, keepCurrentKey) => _saveMachines(machinesFile(), list, currentId, keepCurrentKey)
const sanitizeMachine = _sanitizeMachine
const applyMachine = _applyMachine
const machineId = _machineId

// ── host-key registry (TOFU) ──────────────────────────────────────────────
const KNOWN_HOSTS_FILE = 'known_hosts.json'
const knownHostsFile = () => path.join(remoteWorkspacesRoot(), KNOWN_HOSTS_FILE)

function loadKnownHosts() {
  try {
    const j = JSON.parse(readFileSync(knownHostsFile(), 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {}
  return {}
}

/** Build an ssh2 `hostVerifier` bound to the current config. */
function createHostKeyGuard(config) {
  const id = () => `${config.host}:${config.port}`
  const mode = config.hostKeyMode === 'verify' || config.hostKeyMode === 'off'
    ? config.hostKeyMode
    : 'accept-new'
  const guard = {
    mode,
    lastError: null,
    knownHosts: loadKnownHosts,
    forgetHost() {
      const kh = loadKnownHosts()
      delete kh[id()]
      try { mkdirSync(path.dirname(knownHostsFile()), { recursive: true }) } catch {}
      writeFileSync(knownHostsFile(), JSON.stringify(kh, null, 2))
    },
    verifier(key) {
      if (mode === 'off') return true
      const fp = keyFingerprint(key)
      const kh = loadKnownHosts()
      const stored = kh[id()]
      if (stored) {
        if (stored.fingerprint === fp) return true
        guard.lastError =
          `host key for ${id()} CHANGED (stored ${stored.fingerprint}, received ${fp}) — ` +
          'possible man-in-the-middle; run /remote-forget-key to re-trust if this is expected'
        return false
      }
      if (mode === 'verify') {
        guard.lastError = `unknown host key for ${id()} (hostKeyMode=verify) — trust it first with accept-new`
        return false
      }
      kh[id()] = { algo: blobAlgorithm(key) || (key && key.algo) || 'unknown', fingerprint: fp, firstSeen: new Date().toISOString() }
      try { mkdirSync(path.dirname(knownHostsFile()), { recursive: true }) } catch {}
      writeFileSync(knownHostsFile(), JSON.stringify(kh, null, 2))
      return true
    },
  }
  return guard
}

/** Whether the current target's key has been recorded/trusted before. */
function isHostKeyKnown(host, port) {
  return Object.prototype.hasOwnProperty.call(loadKnownHosts(), `${host}:${port}`)
}

// ── SSH pool (key / password / agent / keyboard-interactive / proxy) ──────

class SshPool {
  constructor(config) {
    this.config = config
    this.client = null
    this.connecting = null
    this.proxyPool = null
    // Generational token: bumped on every target change / close so a stale
    // in-flight connect can never hand this pool a connection to an old host.
    this.epoch = 0
    /** Auto-detected remote platform: unknown | windows | posix (per target). */
    this.platform = 'unknown'
    /** Resolved Git Bash bash.exe path on Windows remotes ('' when none). */
    this.gitBashPath = ''
    /** Resolved terminal strategy: native | git-bash. */
    this.shellMode = 'native'
    /** In-flight platform detection promise (cached). */
    this._detecting = null
    /** Optional async resolver for a machine-stored (keychain) password. */
    this.passwordResolver = null
    /** Optional hook called with the live client after a successful connect. */
    this.onReady = null
    /** Optional hook called when the pool closes. */
    this.onCloseHook = null
  }

  resolveKeyPath() {
    const p = this.config.privateKeyPath
    if (!p) return ''
    if (p.startsWith('~/') || p === '~') return path.join(homedir(), p.slice(1))
    return p
  }

  setTarget({ host, port, username, password, privateKeyPath, passphrase, workspace, useAgent, keyboardInteractive, proxy, hostKeyMode }) {
    if (host !== undefined) this.config.host = String(host)
    if (port !== undefined && Number(port)) this.config.port = Number(port)
    if (username !== undefined) this.config.username = String(username)
    if (password !== undefined && password !== null) this.config.password = String(password)
    if (privateKeyPath !== undefined) this.config.privateKeyPath = String(privateKeyPath)
    if (passphrase !== undefined) this.config.passphrase = String(passphrase)
    if (workspace !== undefined) this.config.workspace = String(workspace)
    if (useAgent !== undefined) this.config.useAgent = !!useAgent
    if (keyboardInteractive !== undefined) this.config.keyboardInteractive = !!keyboardInteractive
    if (proxy !== undefined) this.config.proxy = proxy
    if (hostKeyMode !== undefined) this.config.hostKeyMode = String(hostKeyMode)
    // the new target may be a different OS — re-detect on the next command
    this.platform = 'unknown'
    this.gitBashPath = ''
    this.shellMode = 'native'
    this._detecting = null
    this.close()
    return this
  }

  connect() {
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    const epoch = this.epoch
    const pending = this._doConnect(epoch)
    this.connecting = pending
    const clear = () => {
      if (this.epoch === epoch && this.connecting === pending) this.connecting = null
    }
    pending.then(clear, clear)
    return pending
  }

  async _doConnect(epoch) {
    const isCurrent = () => this.epoch === epoch
    const guard = createHostKeyGuard(this.config)
    const client = new Client()
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      if (isCurrent() && this.client === client) this.client = null
      throw guard.lastError ? new Error(guard.lastError) : err
    }

    // Proxy jump: SSH to the bastion first, then tunnel to the target through it.
    let sock = null
    const proxyCfg = this.config.proxy
    if (proxyCfg && proxyCfg.host) {
      try {
        this.proxyPool = new SshPool({
          ...this.config,
          host: proxyCfg.host,
          port: Number(proxyCfg.port) || 22,
          username: proxyCfg.username || this.config.username || 'root',
          password: proxyCfg.password || '',
          privateKeyPath: proxyCfg.privateKeyPath || '',
          passphrase: proxyCfg.passphrase || '',
          proxy: undefined,
        })
        const pclient = await this.proxyPool.connect()
        if (!isCurrent()) throw new Error('ssh target changed during proxy connect')
        sock = await new Promise((res, rej) => {
          pclient.forwardOut('127.0.0.1', 0, this.config.host, this.config.port, (e, ch) => (e ? rej(new Error('proxy forward to target failed: ' + ((e && e.message) || e))) : res(ch)))
        })
      } catch (err) {
        return fail(err)
      }
    }

    return new Promise((resolve, reject) => {
      const rejectOnce = (err) => {
        if (settled) return
        settled = true
        if (isCurrent() && this.client === client) this.client = null
        reject(guard.lastError ? new Error(guard.lastError) : err)
      }
      client.on('ready', () => {
        if (settled) return
        settled = true
        if (!isCurrent()) {
          try { client.end() } catch {}
          reject(new Error('ssh target changed during connect'))
          return
        }
        this.client = client
        resolve(client)
        if (this.onReady) { try { this.onReady(client) } catch {} }
      })
      client.on('error', (e) => rejectOnce(e))
      client.on('close', () => {
        if (isCurrent() && this.client === client) this.client = null
        rejectOnce(new Error('ssh connection closed'))
      })

      const buildOpts = async () => {
        const opts = {
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          readyTimeout: this.config.connectTimeoutMs,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key) => guard.verifier(key),
        }
        if (sock) opts.sock = sock
        if (this.config.useAgent) {
          const sockPath = process.env.SSH_AUTH_SOCK
          if (sockPath) opts.agent = sockPath
        }
        let password = this.config.password || ''
        if (!password && this.passwordResolver) {
          try { password = (await this.passwordResolver()) || '' } catch {}
        }
        if (password) {
          opts.password = password
          opts.tryKeyboard = true
        } else if (this.config.keyboardInteractive && !this.config.privateKeyPath) {
          opts.tryKeyboard = true
        }
        if (this.config.privateKeyPath) {
          const keyPath = this.resolveKeyPath()
          if (!keyPath) {
            throw new Error('no credentials: set a password or a privateKeyPath to connect')
          }
          let key
          try {
            key = readFileSync(keyPath)
          } catch (err) {
            throw new Error(`cannot read private key "${keyPath}": ${err && err.message}`)
          }
          opts.privateKey = key
          opts.passphrase = this.config.passphrase || undefined
        } else if (!password && !opts.agent) {
          throw new Error('no credentials: set a password, a privateKeyPath, or enable useAgent to connect')
        }
        return opts
      }

      buildOpts().then(
        (opts) => {
          if (opts.tryKeyboard) {
            client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
              finish(prompts.map(() => this.config.password || ''))
            })
          }
          client.connect(opts)
        },
        (err) => rejectOnce(err),
      )
    })
  }

  /** Detect the remote platform + locate Git Bash once; cached per target. */
  detect() {
    if (this.platform !== 'unknown') return Promise.resolve()
    if (this._detecting) return this._detecting
    this._detecting = this._detect().finally(() => {
      this._detecting = null
    })
    return this._detecting
  }

  async _detect() {
    let res
    try {
      // `cmd /c ver` works under cmd.exe, PowerShell AND Git Bash (all print
      // "Microsoft Windows …"); on POSIX hosts `cmd` simply doesn't exist.
      res = await this._execRaw('cmd /c ver', { timeoutMs: Math.min(this.config.commandTimeoutMs, 8000) })
    } catch (err) {
      this.platform = 'unknown'
      this.shellMode = 'native'
      return
    }
    const out = String(res.stdout || '') + '\n' + String(res.stderr || '')
    if (res.code === 0 && /microsoft windows/i.test(out)) {
      this.platform = 'windows'
      await this._resolveGitBash()
      return
    }
    // inconclusive — probe for a Git-Bash/MSYS remote (uname prints MINGW64_NT…)
    try {
      const u = await this._execRaw('uname -s', { timeoutMs: Math.min(this.config.commandTimeoutMs, 8000) })
      if (/mingw|msys|cygwin/i.test(String(u.stdout || ''))) {
        this.platform = 'windows'
        await this._resolveGitBash()
        return
      }
    } catch {}
    this.platform = 'posix'
    this.shellMode = 'native'
    this.gitBashPath = ''
  }

  /** On a Windows remote, locate Git Bash (config path → PATH → common installs). */
  async _resolveGitBash() {
    const cfg = String(this.config.shell || '').trim()
    if (cfg && cfg !== 'git-bash' && cfg !== 'native') {
      if (await this._cmdExists(cfg)) {
        this.gitBashPath = cfg
        this.shellMode = 'git-bash'
        return
      }
    }
    if (cfg === 'native') {
      this.shellMode = 'native'
      this.gitBashPath = ''
      return
    }
    try {
      const r = await this._execRaw('cmd /c where bash', { timeoutMs: 8000 })
      const first = String(r.stdout || '').trim().split(/\r?\n/)[0].trim()
      if (first) {
        this.gitBashPath = first
        this.shellMode = 'git-bash'
        return
      }
    } catch {}
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      ...(process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA + '\\Programs\\Git\\bin\\bash.exe'] : []),
      '%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe',
    ]
    for (const c of candidates) {
      if (await this._cmdExists(c)) {
        this.gitBashPath = c
        this.shellMode = 'git-bash'
        return
      }
    }
    this.shellMode = 'git-bash' // wanted but not found — commands fall back to raw
    this.gitBashPath = ''
  }

  async _cmdExists(p) {
    try {
      const r = await this._execRaw(`cmd /c if exist "${p}" (echo Y) else (echo N)`, { timeoutMs: 8000 })
      return /Y/.test(String(r.stdout || ''))
    } catch {
      return false
    }
  }

  /** Run one remote command; resolves { code, signal, stdout, stderr }.
   * On Windows remotes with Git Bash the script is piped to `bash -s` over the
   * exec-channel stdin — no shell quoting round-trip, so any content (quotes,
   * backslashes, newlines) survives verbatim. */
  exec(command, timeoutMsOrOpts) {
    const opts = timeoutMsOrOpts && typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : { timeoutMs: timeoutMsOrOpts }
    return this.detect().then(() => {
      if (this.platform === 'windows' && this.gitBashPath) {
        const script = String(command)
        return this._execRaw(`"${this.gitBashPath}" -s`, { ...opts, timeoutMs: opts.timeoutMs || this.config.commandTimeoutMs }, (stream) => {
          try { stream.end(script) } catch {}
        })
      }
      return this._execRaw(command, opts)
    })
  }

  /** Raw exec (no detection / no wrapper). Optional stdinWriter(stream) feeds
   * the remote process stdin (used by the Git Bash `-s` mode). */
  _execRaw(command, opts, stdinWriter) {
    const timeoutMs = (opts && opts.timeoutMs) || this.config.commandTimeoutMs
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          const runOn = (c) => {
            const execOpts = {}
            if (opts && opts.pty) execOpts.pty = true
            if (opts && opts.env && typeof opts.env === 'object') execOpts.env = opts.env
            c.exec(command, execOpts, (err, stream) => {
              if (err) {
                // Channel-open failure — or a session termination — usually
                // means the pooled connection died server-side (idle timeout /
                // network reset) while keepalive hadn't noticed. Drop it and
                // retry ONCE on a fresh connection.
                if (!retried && /channel open failure|open failed|unexpected .* session termination|session termination|disconnect/i.test(String((err && err.message) || err))) {
                  retried = true
                  this.invalidate()
                  return this.connect().then(
                    (fresh) => runOn(fresh),
                    (e2) => reject(new Error('ssh exec failed (reconnect): ' + ((e2 && e2.message) || e2))),
                  )
                }
                return reject(new Error('ssh exec failed: ' + ((err && err.message) || err)))
              }
              let stdout = ''
              let stderr = ''
              let settled = false
              let exitCode = null
              let exitSignal = null
              const hardCap = Math.max(this.config.maxOutputChars * 4, 1024 * 1024)
              const settle = () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve({
                  code: exitCode,
                  signal: exitSignal,
                  stdout: truncate(stdout, this.config.maxOutputChars),
                  stderr: truncate(stderr, this.config.maxOutputChars),
                })
              }
              const timer = setTimeout(() => {
                if (settled) return
                exitCode = -1
                exitSignal = 'TIMEOUT'
                // Kill the remote command (SIGTERM) rather than just dropping the
                // channel, so a runaway process cannot keep running and holding
                // the SSH connection after we've given up on its output.
                try {
                  if (typeof stream.signal === 'function') stream.signal('SIGTERM')
                } catch {}
                const hardClose = setTimeout(() => {
                  try { stream.close() } catch {}
                }, 800)
                if (typeof hardClose.unref === 'function') hardClose.unref()
                settle()
              }, timeoutMs)
              stream.on('close', (code, signal) => {
                if (settled) return
                exitCode = code
                exitSignal = signal
                settle()
              })
              stream.on('data', (d) => {
                if (stdout.length < hardCap) stdout += d
              })
              stream.stderr.on('data', (d) => {
                if (stderr.length < hardCap) stderr += d
              })
              stream.on('error', (e) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(new Error('ssh stream error: ' + ((e && e.message) || e)))
              })
              if (stdinWriter) {
                try { stdinWriter(stream) } catch {}
              }
            })
          }
          runOn(client)
        }),
    )
  }

  /** Resolve a promisified SFTP client. All paths normalized via toSftpPath(). */
  sftp() {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          const runOn = (c) => {
            c.sftp((err, sftp) => {
              if (err) {
                // Same dead-connection recovery as exec(): a channel open
                // failure — or a session termination (remote closed the
                // SFTP subchannel, e.g. transient network blip / sshd idle
                // drop) — means the pooled connection is stale: drop it and
                // retry ONCE on a fresh connection.
                if (!retried && /channel open failure|open failed|unexpected sftp session termination|session termination|disconnect/i.test(String((err && err.message) || err))) {
                  retried = true
                  this.invalidate()
                  return this.connect().then(
                    (fresh) => runOn(fresh),
                    (e2) => reject(new Error('ssh sftp failed (reconnect): ' + ((e2 && e2.message) || e2))),
                  )
                }
                return reject(new Error('ssh sftp failed: ' + ((err && err.message) || err)))
              }
              const withTimeout = (fn) => (...args) =>
                new Promise((r2, j2) => {
                  const timer = setTimeout(() => j2(new Error('sftp operation timed out')), this.config.commandTimeoutMs)
                  const done = (e, v) => {
                    clearTimeout(timer)
                    e ? j2(e) : r2(v)
                  }
                  try { fn(...args, done) } catch (e) { clearTimeout(timer); j2(e) }
                })
              const P = (p) => toSftpPath(p)
              resolve({
                readdir: (dir) => withTimeout((d, cb) => sftp.readdir(d, cb))(P(dir)),
                stat: (p) => withTimeout((d, cb) => sftp.stat(d, cb))(P(p)),
                lstat: (p) => withTimeout((d, cb) => sftp.lstat(d, cb))(P(p)),
                mkdir: (dir) => withTimeout((d, cb) => sftp.mkdir(d, cb))(P(dir)),
                rmdir: (dir) => withTimeout((d, cb) => sftp.rmdir(d, cb))(P(dir)),
                unlink: (p) => withTimeout((d, cb) => sftp.unlink(d, cb))(P(p)),
                rename: (p, d) => withTimeout((a, b, cb) => sftp.rename(a, b, cb))(P(p), P(d)),
                realpath: (p) => withTimeout((d, cb) => sftp.realpath(d, cb))(P(p)),
                readFile: (p) => withTimeout((d, cb) => sftp.readFile(d, cb))(P(p)),
                writeFile: (p, data) => withTimeout((d, data2, cb) => sftp.writeFile(d, data2, cb))(P(p), data),
                fastGet: (p, lp) => withTimeout((d, l, cb) => sftp.fastGet(d, l, cb))(P(p), lp),
                fastPut: (lp, p) => withTimeout((l, d, cb) => sftp.fastPut(l, d, cb))(lp, P(p)),
              })
            })
          }
          runOn(client)
        }),
    )
  }

  /**
   * Drop the cached client and force a fresh connection on the next call.
   * Called when a channel open fails (e.g. "Channel open failure: open
   * failed") — the pooled SSH connection is usually dead server-side while
   * keepalive has not yet noticed, and reusing it keeps failing. The epoch
   * bump orphans any in-flight connect; the client is ended so ssh2 frees
   * its sockets.
   */
  invalidate() {
    this.epoch++
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try { client.end() } catch {}
    }
  }

  close() {
    this.epoch++
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try {
        client.end()
      } catch {}
    }
    if (this.onCloseHook) {
      // The closed client is passed through so the multi-pool ForwardManager
      // can detach exactly THIS pool's tunnels (other pools keep running).
      try { this.onCloseHook(client) } catch {}
    }
  }
}

// ── encoding helpers ───────────────────────────────────────────────────────

function decodeBuf(buf, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.decode(buf, e) : buf.toString('utf8')
}
function encodeText(s, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.encode(String(s), e) : Buffer.from(String(s), 'utf8')
}

// ── apply ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config, options = {}) {
  // Test hook (§4.1): every context pool — including __global__ — is created
  // through this factory, so tests can substitute fake pools with no network.
  const poolFactory = typeof options.poolFactory === 'function' ? options.poolFactory : ((cfg) => new SshPool(cfg))

  migrateLegacyData()

  // ── machine registry (multi-host) ─────────────────────────────────────────
  // STAYS GLOBAL: one machines.json, one currentId (issue #13 semantics).
  // Contexts reference machines by id; they never store machine copies.
  const store = loadMachines()
  const machines = store.list
  const machineIndex = (id) => machines.findIndex((m) => m.id === id)

  /** Resolve a machine's effective password (keychain backend support). */
  const machinePassword = async (m) => {
    if (m && m.password) return m.password
    if (m && m.credentialBackend && m.credentialBackend !== 'plain') {
      const p = await getSecret(m.id, secretsDir())
      if (p) return p
    }
    return ''
  }

  // ── task + forward managers ───────────────────────────────────────────────
  const tasks = new TaskManager()
  // forwards.json STAYS GLOBAL (one file, shared defs) — the manager is
  // multi-pool: each server entry remembers the pool (and client) it runs on.
  const forwards = new ForwardManager({ file: forwardsFile() })

  /** Every context pool is built through the (test-injectable) factory and
   *  wired into the ForwardManager: autoStart tunnels are re-created on
   *  connect (attach) and torn down when THIS pool's client closes. */
  const makePool = (machineConfig) => {
    const p = poolFactory(machineConfig)
    p.onReady = (client) => forwards.attach(client, p)
    p.onCloseHook = (client) => { if (client) forwards.detach(client) }
    return p
  }

  // ── auto-push watcher refs ────────────────────────────────────────────────
  // Mirrors stay GLOBAL per remote path, but auto-push watchers are refcounted
  // per context: two sessions on the same machine + workspace share the mirror
  // (and its watcher); it closes only when the last referencing context's
  // pool goes away.
  const watcherRefs = new Map() // localDir → Set<contextId>

  // ── per-agent-thread remote contexts ──────────────────────────────────────
  // The active remote context (machine binding + workspace + SSH pool) is per
  // agent thread, keyed by exec.agent.id (=== session.id). New threads start
  // UNBOUND. '__global__' keeps the legacy machine-global behavior for
  // agentless callers (web routes without sessionId, slash commands, settings
  // UI): config-default bootstrap, registry currentId, auto-restore probe.
  const contexts = new ContextStore({
    rootDir: remoteWorkspacesRoot(),
    registry: () => ({ list: machines, currentId: store.currentId, explicitNone: store.explicitNone }),
    configDefaults: () => config,
    poolFactory: makePool,
    machinePassword,
    maxLive: Number(config.maxRemoteContexts) > 0 ? Number(config.maxRemoteContexts) : 8,
    idleMs: Number.isFinite(Number(config.remoteContextIdleMs)) ? Number(config.remoteContextIdleMs) : 1800000,
    logger: (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ? ctx.logger : null,
    onEvict: (id) => releaseContextWatchers(id),
  })

  ctx.effect(() => () => {
    try { contexts.closeAll() } catch {}
    try { forwards.stopAll() } catch {}
  }, 'dsh-remote.close')

  // Idle sweep: evict pools of contexts unused for remoteContextIdleMs
  // (0 disables). unref'd so it never holds the process open.
  const idleTimer = setInterval(() => {
    try { contexts.sweepIdle() } catch {}
  }, 60000)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
  ctx.effect(() => () => {
    try { clearInterval(idleTimer) } catch {}
  }, 'dsh-remote.context-idle')

  // ── context resolution helpers ────────────────────────────────────────────
  /** The calling tool's context (exec.agent.id → '__global__' when agentless). */
  const contextOf = (exec) => {
    const id = agentContextId(exec)
    const entry = contexts.getOrCreate(id)
    return { id, entry }
  }

  /** Context id from an optional sessionId (web routes) → '__global__'. */
  const contextIdOf = (value) => (value ? sanitizeContextId(String(value)) : GLOBAL_CONTEXT_ID)

  /** Require a BOUND context: { id, entry, machine, pool, workspace } or the
   *  actionable "no remote context" error. Unbound contexts NEVER fall back
   *  to the global pool (§2.2(5)). */
  const requireBound = async (id) => {
    contexts.touch(id)
    const entry = contexts.getOrCreate(id)
    const machine = contexts.activeMachineOf(entry.id)
    if (!machine) {
      throw new Error(entry.staleError || 'no remote context for this session — call rw_connect first')
    }
    const pool = await contexts.resolvePool(entry.id)
    if (!pool) throw new Error('no remote context for this session — call rw_connect first')
    return { id: entry.id, entry, machine, pool, workspace: entry.workspace || (machine.workspace || '') }
  }

  // The registry `currentId` is a machine-level default consumed by the GLOBAL
  // context (settings UI / agentless callers). Binding a SESSION never flips
  // it — rw_connect save:true upserts the registry but leaves currentId alone.
  const setCurrent = async (id) => {
    if (!id) {
      // Explicit "active remote = none": saved machines stay in the registry
      // (issue #13) but the global context is unbound.
      store.currentId = null
      store.explicitNone = true // persist AND mirror the explicit "none" in memory
      saveMachines(machines, null)
      contexts.clearBinding(GLOBAL_CONTEXT_ID)
      contexts.closePool(GLOBAL_CONTEXT_ID)
      releaseContextWatchers(GLOBAL_CONTEXT_ID)
      return true
    }
    const i = machineIndex(id)
    if (i < 0) return false
    store.currentId = id
    store.explicitNone = false
    saveMachines(machines, id)
    // The global context follows the registry choice: BIND it to the chosen
    // machine (persistent) so the global pool, status, and workspace
    // persistence (machines.json rec.workspace + recentWorkspaces via
    // persistWorkspaceFor) track currentId exactly as legacy setCurrent did.
    // (An explicit bind is required: persistWorkspaceFor only writes the
    // registry metadata when entry.machineId is set, spec §7 legacy behavior.)
    contexts.bind(GLOBAL_CONTEXT_ID, id)
    await contexts.resolvePool(GLOBAL_CONTEXT_ID)
    return true
  }

  // Legacy config-default bootstrap (global context only): when the registry
  // has no explicit choice (no currentId, and not an explicit "none"), the
  // config host serves as the __global__ binding default. This is now implicit
  // in ContextStore.activeMachineOf('__global__') — no config mutation needed.

  // ── auto-restore the last active machine (best-effort, global context) ────
  // When the harness (re)starts, bring back the machine that was "current"
  // last time: materialize the global context's pool on it and probe a real
  // SSH connection so the sidebar shows connected instead of a disconnected
  // 500-spamming state. Failures are swallowed — an unreachable host must
  // never break plugin boot (the sidebar will show「未连接」and the user can
  // reconnect or set current).
  if (store.currentId) {
    const i = machineIndex(store.currentId)
    if (i >= 0 && machines[i] && machines[i].host) {
      setImmediate(async () => {
        try {
          const gpool = await contexts.resolvePool(GLOBAL_CONTEXT_ID)
          if (gpool) await gpool.exec('echo dsh-remote-restore', { timeoutMs: Math.min(config.commandTimeoutMs || 20000, 15000) })
        } catch {
          // Offline / bad credentials: leave the pool unconnected; UI falls
          // back to the "未连接" state and the user can reconnect manually.
        }
      })
    }
  }

  /** Persist a CONTEXT's workspace: the context entry (contexts.json when the
   *  binding is persistent; in-memory only when ephemeral) + the bound
   *  machine's recentWorkspaces metadata. keepCurrentKey:false leaves the
   *  registry currentId byte-for-byte untouched. */
  const persistWorkspaceFor = (id, p) => {
    const entry = contexts.setWorkspace(id, p)
    if (entry.machineId) {
      const i = machineIndex(entry.machineId)
      if (i >= 0) {
        const rec = machines[i]
        rec.workspace = p
        rec.recentWorkspaces = [p, ...(rec.recentWorkspaces || []).filter((x) => x !== p)].slice(0, 8)
        saveMachines(machines, store.currentId, false)
      }
    }
    return entry
  }

  // ── audit log (context-scoped) ────────────────────────────────────────────
  // Line format: ISO | <contextId> | <user>@<host>:<port> | <op> | <code|-> | <cmd>
  // (the context id segment was inserted after the timestamp in this change;
  // the /audit reader tolerates both old and new formats). `target` carries
  // the attempt's user/host/port (unbound failed connects audit their attempt).
  const audit = (contextId, op, cmd, code, target) => {
    if (!config.auditLog) return
    try {
      const who = target || {}
      const line = [
        new Date().toISOString(),
        sanitizeContextId(contextId || GLOBAL_CONTEXT_ID),
        `${who.username || '?'}@${who.host || '?'}:${who.port || 22}`,
        op,
        code == null ? '-' : String(code),
        String(cmd || '').replace(/\s+/g, ' ').slice(0, 400),
      ].join(' | ') + '\n'
      appendFileSync(auditFile(), line, 'utf8')
    } catch {}
  }
  const readAudit = (limit) => {
    try {
      const text = readFileSync(auditFile(), 'utf8')
      const lines = text.split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, Math.min(Number(limit) || 50, 500)))
    } catch {
      return []
    }
  }

  // ── ignore rules (defaults + user file) ───────────────────────────────────
  const ignoreMatcher = () => {
    try {
      const fromFile = readFileSync(ignoreFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      return compileIgnore(DEFAULT_IGNORE.concat(fromFile))
    } catch {
      return compileIgnore(DEFAULT_IGNORE)
    }
  }

  // ── auto-push watcher (config.autoPush, default off) ──────────────────────
  // Watches the local mirror; local edits are pushed back to the remote after a
  // 3s debounce, honoring ignore rules + the three-way conflict guard (a remote
  // change is never clobbered — it is recorded as a conflict in the audit log).
  // Watchers are refcounted per context: a shared mirror (two sessions on the
  // same machine + workspace) closes only when the last ref goes away.
  const autoPushWatchers = new Map() // localDir → { watcher, pending:Set, timer }

  /** Release the auto-push watcher refs a context holds; the watcher itself
   *  closes only when this context was the last ref. */
  const releaseContextWatchers = (contextId) => {
    for (const [localDir, refs] of [...watcherRefs]) {
      if (!refs.has(contextId)) continue
      refs.delete(contextId)
      if (refs.size > 0) continue
      watcherRefs.delete(localDir)
      const w = autoPushWatchers.get(localDir)
      if (!w) continue
      if (w.timer) clearTimeout(w.timer)
      try { w.watcher && w.watcher.close() } catch {}
      autoPushWatchers.delete(localDir)
    }
  }

  /** A live context pool that references this mirror (for pushing local edits). */
  const poolForMirror = (localDir) => {
    const refs = watcherRefs.get(localDir)
    if (!refs) return null
    for (const cid of refs) {
      const e = contexts.peek(cid)
      if (e && e.pool) return { pool: e.pool, contextId: cid, entry: e }
    }
    return null
  }

  const flushAutoPush = async (localDir) => {
    const entry = autoPushWatchers.get(localDir)
    if (!entry || !entry.pending.size) return
    const target = poolForMirror(localDir)
    if (!target) return
    const { pool, contextId, entry: ctxEntry } = target
    const machine = contexts.activeMachineOf(contextId)
    const ws = ctxEntry.workspace
    if (!machine || !ws || mirrorDirFor(ws, machine.host, machine.username, machine.port) !== localDir) return
    const rels = [...entry.pending]
    entry.pending.clear()
    let sftp
    try { sftp = await pool.sftp() } catch { return }
    const matcher = ignoreMatcher()
    const state = loadSyncState(localDir)
    const next = { ...state }
    if (rels.includes('*')) {
      const r = await pushTree(sftp, localDir, ws, { maxFiles: 500, maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
      Object.assign(next, r.nextState)
      for (const c of r.stats.conflicts) audit(contextId, 'auto-push-conflict', `push ${c.path}`, 1, machine)
    } else {
      for (const rel of rels) {
        const r = await pushOneFile(sftp, localDir, ws, rel, { maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
        if (r.status === 'pushed' && r.state) Object.assign(next, r.state)
        else if (r.status === 'conflict') audit(contextId, 'auto-push-conflict', `push ${rel}`, 1, machine)
      }
    }
    saveSyncState(localDir, next)
  }
  const startAutoPush = (localDir, contextId) => {
    if (!config.autoPush || !localDir || !contextId) return
    if (!watcherRefs.has(localDir)) watcherRefs.set(localDir, new Set())
    watcherRefs.get(localDir).add(contextId)
    if (autoPushWatchers.has(localDir)) return
    const entry = { pending: new Set(), timer: null, watcher: null }
    const schedule = () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => flushAutoPush(localDir), 3000)
    }
    const onEvent = (eventType, filename) => {
      if (!filename) { entry.pending.add('*'); return schedule() }
      const rel = String(filename).replace(/\\/g, '/')
      if (rel === '.dsh-remote-meta.json' || rel === '.dsh-remote-sync-state.json' || rel.startsWith('.dsh-remote-sync-state.json.tmp')) return
      entry.pending.add(rel)
      schedule()
    }
    try {
      entry.watcher = watch(localDir, { recursive: true }, onEvent)
    } catch {
      try { entry.watcher = watch(localDir, onEvent) } catch { return }
    }
    autoPushWatchers.set(localDir, entry)
  }
  ctx.effect(() => () => {
    for (const e of autoPushWatchers.values()) {
      if (e.timer) clearTimeout(e.timer)
      try { e.watcher && e.watcher.close() } catch {}
    }
    autoPushWatchers.clear()
    for (const s of watcherRefs.values()) s.clear()
    watcherRefs.clear()
  }, 'dsh-remote.autopush')

  /** Structured listing: name + type + size + mtime + mode (SFTP protocol-level,
   * works on any remote: POSIX / cmd.exe / PowerShell). `pool` is the calling
   * context's pool (per-session scoping). */
  const listDirStructured = async (pool, p) => {
    const target = normalizeRemotePath(p || '/')
    let sftp
    try {
      sftp = await pool.sftp()
    } catch (err) {
      throw new Error('browse failed: ' + ((err && err.message) || err))
    }
    let list
    try {
      list = await sftp.readdir(target)
    } catch (err) {
      // Missing directory / deleted folder: not an internal error. Report it
      // distinctly so the UI can show「目录不存在」without treating it as a
      // hard failure (500) that collapses the whole tree.
      const msg = String((err && err.message) || err)
      if (/no such file|not found|does not exist|ENOENT/i.test(msg)) {
        return { path: target, items: [], missing: true }
      }
      throw new Error('browse failed: ' + msg)
    }
    const items = []
    const symIdx = []
    for (const e of list) {
      const name = String(e.filename)
      if (name === '.' || name === '..' || !name) continue
      const a = e.attrs || {}
      let type
      if (a.isSymbolicLink && a.isSymbolicLink()) {
        type = 'symlink'
        symIdx.push(items.length)
      } else if (a.isDirectory && a.isDirectory()) {
        type = 'dir'
      } else {
        type = 'file'
      }
      items.push({
        type,
        name,
        size: typeof a.size === 'number' ? a.size : 0,
        mtime: typeof a.mtime === 'number' ? a.mtime : 0,
        mode: typeof a.mode === 'number' ? a.mode.toString(8) : '',
      })
    }
    // Resolve symlink-to-dir vs symlink-to-file (bounded, failure-tolerant).
    if (symIdx.length) {
      await Promise.all(symIdx.map(async (i) => {
        const full = joinRemotePath(target, items[i].name)
        try {
          const st = await sftp.lstat(full)
          items[i].type = st && st.isDirectory && st.isDirectory() ? 'dir' : 'file'
        } catch { /* degrade to file */ }
      }))
    }
    return { path: target, items }
  }

  /** Windows drive letters as display-form dir entries (the "This PC" root view).
   * `cmd /c fsutil fsinfo drives` works under cmd/PowerShell/Git Bash and prints
   * e.g. "Drives: C:\\ D:\\ E:\\"; falls back to listing Git-Bash mount points
   * (/c /d …). Returns [] on POSIX hosts or when enumeration fails. */
  const listRemoteDrives = async (pool) => {
    let letters = []
    try {
      const res = await pool.exec('cmd /c fsutil fsinfo drives', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
      letters = [...String(res.stdout || '').matchAll(/([a-zA-Z]):\\?/g)].map((mm) => mm[1].toUpperCase())
    } catch {}
    if (!letters.length) {
      try {
        const res = await pool.exec('ls -d /[a-z] 2>/dev/null', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
        letters = String(res.stdout || '')
          .split(/\s+/)
          .map((s) => s.replace(/^\/+|\/+$/g, ''))
          .filter((s) => /^[a-zA-Z]$/.test(s))
          .map((s) => s.toUpperCase())
      } catch {}
    }
    return [...new Set(letters)].sort().map((l) => ({ name: l + ':\\', path: l + ':\\', type: 'dir', drive: true, size: 0, mtime: 0 }))
  }

  const isRemoteDir = async (pool, p) => {
    const target = normalizeRemotePath(p)
    try {
      const sftp = await pool.sftp()
      const st = await sftp.stat(target)
      return !!(st && st.isDirectory && st.isDirectory())
    } catch {
      return false
    }
  }

  /** Recursive remote delete (bounded): unlink files bottom-up, then rmdir. */
  const removeRemoteTree = async (sftp, p, maxFiles = 2000) => {
    let removed = 0
    const walk = async (dir) => {
      if (removed >= maxFiles) return
      let entries = []
      try { entries = (await sftp.readdir(dir)) || [] } catch { return }
      for (const e of entries) {
        if (removed >= maxFiles) return
        const name = String(e.filename)
        if (name === '.' || name === '..') continue
        const fp = joinRemotePath(dir, name)
        const isDir = !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory())
        if (isDir) await walk(fp)
        else {
          try { await sftp.unlink(fp); removed++ } catch {}
        }
      }
      try { await sftp.rmdir(dir); removed++ } catch { /* already gone or non-empty */ }
    }
    await walk(p)
    return removed
  }

  // ── remote workspace state ────────────────────────────────────────────────
  // NOTE: the workspace is now PER CONTEXT (ContextStore entry / machine
  // record) — tools read it via requireBound(id).workspace, not a global.
  /** Map a LOCAL path to the remote path its mirror represents ('' when the
   *  path is not inside any dsh-remote mirror). Shared by the resolve-mirror
   *  route, the session-aware system-prompt injection, and status(). */
  const resolveMirrorForLocal = (local) => {
    const root = remoteWorkspacesRoot()
    const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '') || ''
    let matched = ''
    let matchedRemote = ''
    if (local && existsSync(root)) {
      const base = norm(local)
      for (const hostDir of readdirSync(root)) {
        const hostPath = path.join(root, hostDir)
        if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
        for (const mirrorDir of readdirSync(hostPath)) {
          const metaPath = path.join(hostPath, mirrorDir, '.dsh-remote-meta.json')
          if (!existsSync(metaPath)) continue
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
            const mirrorAbs = norm(path.join(hostPath, mirrorDir))
            if (mirrorAbs === base || base.startsWith(mirrorAbs + path.sep) || base.startsWith(mirrorAbs + '/')) {
              if (mirrorAbs.length > matched.length) {
                matched = mirrorAbs
                matchedRemote = String(meta.remotePath || '')
              }
            }
          } catch { /* skip unparsable meta */ }
        }
      }
    }
    return { mirrorDir: matched || null, remotePath: matchedRemote || '' }
  }
  // Boot-time auto-push for the GLOBAL context's workspace (legacy behavior:
  // a bound global machine's workspace is watched for local edits).
  {
    const gm = contexts.activeMachineOf(GLOBAL_CONTEXT_ID)
    const gw = contexts.workspaceOf(GLOBAL_CONTEXT_ID)
    if (config.autoPush && gm && gm.host && gw) {
      startAutoPush(mirrorDirFor(gw, gm.host, gm.username, gm.port), GLOBAL_CONTEXT_ID)
    }
  }
  /** The remote path the CURRENT agent session is really bound to, or '' when
   *  the session is a plain local one. Walks the mirror registry (host side
   *  copy of the resolve-mirror logic) so status / prompt / sidebar agree.
   *  `sessionId` narrows to one session; without it the first live session's
   *  cwd is used (best effort — status is informational, the per-session
   *  resolve-mirror endpoint is authoritative). */
  const sessionRemotePath = (sessionId) => {
    let cwd = ''
    try {
      const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
      if (sessions && typeof sessions.get === 'function' && sessionId) {
        const s = sessions.get(sessionId)
        if (s && s.header && s.header.cwd) cwd = String(s.header.cwd)
      } else if (sessions && typeof sessions.list === 'function') {
        const s = sessions.list()[0]
        if (s && s.header && s.header.cwd) cwd = String(s.header.cwd)
      }
    } catch { /* sessions service unavailable */ }
    if (!cwd) return ''
    return resolveMirrorForLocal(cwd).remotePath
  }
  /** Per-context status (no connection is triggered — stored state only).
   *  Machine-bound fields describe the REQUESTED context; registry fields
   *  (machines/currentId) stay global. activeSource: 'context' (persisted or
   *  registry binding live), 'ephemeral' (in-memory binding live), 'config'
   *  (__global__ bootstrap from the config default), 'none' (unbound). */
  const status = (contextId) => {
    const id = contextIdOf(contextId)
    const entry = contexts.getOrCreate(id)
    const machine = contexts.activeMachineOf(entry.id)
    const pool = entry.pool || null
    const isGlobal = id === GLOBAL_CONTEXT_ID
    const host = machine ? String(machine.host || '') : (isGlobal ? String(config.host || '') : '')
    const port = machine ? (Number(machine.port) || 22) : (isGlobal ? (Number(config.port) || 22) : 22)
    const username = machine ? String(machine.username || '') : (isGlobal ? String(config.username || '') : '')
    const workspace = entry.workspace || (machine && machine.workspace) || ''
    const hkHost = machine ? String(machine.host || '') : (isGlobal ? String(config.host || '') : '')
    const hkPort = machine ? (Number(machine.port) || 22) : (isGlobal ? (Number(config.port) || 22) : 22)
    // Registry machine reference only: a persistent binding's id, or (for the
    // global context) the registry currentId. Ephemeral bindings have no
    // registry id — their state is reported via activeSource: 'ephemeral'.
    const machineId = entry.machineId
      || (isGlobal && store.currentId ? store.currentId : null)
    const activeSource = entry.ephemeralMachine ? 'ephemeral'
      : (entry.machineId ? 'context'
      : (isGlobal ? (store.currentId ? 'context' : (config.host ? 'config' : 'none')) : 'none'))
    // Issue #13: whether THIS session is in remote mode — bound to a machine,
    // or its cwd maps into a dsh-remote mirror (legacy mirror-cwd sessions).
    const srem = sessionRemotePath(isGlobal ? undefined : id)
    return {
      contextId: id,
      machineId: machineId || null,
      host,
      port,
      username,
      connected: !!(pool && pool.client),
      workspace: workspace ? toDisplayPath(workspace, pool ? pool.platform : 'unknown') : '',
      localMirror: workspace ? mirrorDirFor(workspace, host || (isGlobal ? config.host : ''), username || (isGlobal ? config.username : ''), port) : '',
      currentId: store.currentId || null,
      activeSource,
      sessionMode: (machine || srem) ? 'remote' : 'local',
      sessionRemotePath: srem,
      machines: machines.map(sanitizeMachine),
      hostKeyMode: (machine && machine.hostKeyMode) || (config.hostKeyMode === 'verify' || config.hostKeyMode === 'off' ? config.hostKeyMode : 'accept-new'),
      hostKeyKnown: hkHost ? isHostKeyKnown(hkHost, hkPort) : false,
      forwards: forwards.list(),
      auditEnabled: !!config.auditLog,
      backend: platformBackend(),
      platform: pool ? pool.platform : 'unknown',
      shell: pool ? pool.shellMode : 'native',
      gitBash: pool ? (pool.gitBashPath || '') : '',
    }
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  const textOut = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => [{ type: 'text', text: v.text }],
  }
  const okOut = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
    render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'ok' : 'failed') }],
  }

  const tools = [
    defineTool({
      name: 'rw_info',
      description:
        'Show the remote environment for THIS session: host/user/port, connection health, current remote workspace path, active port forwards. Call this first to orient, or when an rw_* call fails to check connectivity. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context. A saved machine only becomes active for a session when you explicitly rw_connect it (issue #13).',
      parameters: {},
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        contexts.touch(id)
        const s = status(id)
        const lines = [
          `Remote host: ${s.username || '<user>'}@${s.host || '<host>'}:${s.port} (context: ${id}, source: ${s.activeSource})`,
          `Current remote workspace: ${s.workspace || '(none — call rw_connect then rw_pick_workspace to set one)'}`,
          `Local mirror: ${s.localMirror || '(none)'}`,
          `Session remote context: ${s.sessionRemotePath ? s.sessionRemotePath : '(this session is LOCAL — no remote workspace bound)'}`,
          `Connected: ${s.connected ? 'yes' : 'no'}`,
          `Remote shell: ${s.platform === 'windows' ? (s.gitBash ? 'Git Bash (' + s.gitBash + ')' : 'Windows (Git Bash not found — set config.shell to a bash.exe path)') : (s.platform === 'posix' ? 'native POSIX' : 'detecting…')}`,
          `Active forwards: ${s.forwards.filter((f) => f.active).length} / ${s.forwards.length}`,
          `Host key: ${s.hostKeyKnown ? 'trusted' : 'not yet trusted'} (mode=${s.hostKeyMode})`,
          '',
        ]
        if (s.host && s.workspace) {
          const machine = contexts.activeMachineOf(id)
          const cpool = await contexts.resolvePool(id)
          if (cpool) {
            try {
              const res = await cpool.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
              if (res.signal === 'TIMEOUT') lines.push('Ping: timeout')
              else if (res.code === 0) lines.push('Ping: OK — ' + res.stdout.replace(/\s+/g, ' ').trim())
              else lines.push('Ping: FAILED — ' + (res.stderr || res.stdout || `exit ${res.code}`).trim())
            } catch (err) {
              lines.push('Ping: FAILED — ' + friendlyMessage(err, machine ? { host: machine.host, port: machine.port } : { host: s.host, port: s.port }))
            }
          }
        } else {
          lines.push('No host + workspace configured — call rw_connect with a host to get started.')
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_connect',
      description:
        'Connect SSH to a remote host for remote workspace work. Provide host (required unless machineId is given) or machineId (a saved registry machine), user, optional password or privateKeyPath/port. Defaults to saving the machine to the registry (save=false keeps it as a temporary connection). Once connected, call rw_pick_workspace to pick the workspace directory this session should work in. Binds the machine to this session. save: false keeps the binding ephemeral (this process only, never persisted). Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        host: { type: 'string', description: 'Remote host IP or hostname (not needed when machineId is given)' },
        machineId: { type: 'string', description: 'Id of a saved registry machine to connect to (resolves host/port/username + keychain password)' },
        username: { type: 'string', description: 'SSH user (default from config or root)' },
        port: { type: 'integer', description: 'SSH port (default 22)' },
        password: { type: 'string', description: 'SSH password (prefer SSH key when possible)' },
        privateKeyPath: { type: 'string', description: 'Absolute private-key path' },
        save: { type: 'boolean', description: 'Save this machine to the registry and bind it to this session (default true; does not change the registry currentId)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id, entry } = contextOf(exec)
        const machineIdArg = args.machineId ? String(args.machineId).trim() : ''
        let host = ''
        let user = ''
        let port = 22
        let password = ''
        let privateKeyPath = ''
        let passphrase = ''
        // Connection fields carried from a REGISTRY machine into the ephemeral
        // record (save:false) so the pool is configured exactly like the web
        // /connect machineId path (which binds the registry record and lets
        // resolvePool read these same fields). Jump host / agent / kbd-
        // interactive auth all break without them; hostKeyMode is
        // security-adjacent — a machine pinned to e.g. 'verify' must not
        // silently downgrade to the config default on the tool path. Raw
        // values — resolvePool applies the same guards it applies to a
        // registry machine.
        let proxy
        let useAgent
        let keyboardInteractive
        let hostKeyMode
        if (machineIdArg) {
          const i = machineIndex(machineIdArg)
          if (i < 0) throw new Error(`rw_connect: machine ${machineIdArg} not found in registry`)
          const m = machines[i]
          host = String(m.host || '')
          user = m.username || config.username || 'root'
          port = Number(m.port) || 22
          // Resolve credentials exactly like the web /connect machineId path:
          // a plain registry password OR the keychain secret (a keychain
          // machine stores password='' in the registry — the raw field alone
          // would fail auth), plus the encrypted-key passphrase.
          password = (await machinePassword(m)) || ''
          privateKeyPath = m.privateKeyPath || ''
          passphrase = m.passphrase || ''
          proxy = m.proxy
          useAgent = m.useAgent
          keyboardInteractive = m.keyboardInteractive
          hostKeyMode = m.hostKeyMode
        } else {
          host = String(args.host || '').trim()
          if (!host) throw new Error('rw_connect: host is required (or pass machineId of a saved machine)')
          user = args.username || config.username || 'root'
          port = Number(args.port) || 22
          password = args.password !== undefined ? String(args.password) : ''
          privateKeyPath = args.privateKeyPath || ''
        }
        const rec = {
          host,
          port,
          username: user,
          password,
          privateKeyPath,
        }
        if (args.save !== false) {
          // Upsert the registry (default true) and bind the CALLING context to
          // that machine — WITHOUT flipping the registry currentId: that is a
          // machine-level default for the global context / settings UI, and
          // binding one session must not change it (issue #13 extended).
          let mrec
          if (machineIdArg) {
            mrec = machines[machineIndex(machineIdArg)]
          } else {
            const i = machines.findIndex((m) => m.host === rec.host && m.username === rec.username && Number(m.port) === rec.port)
            if (i >= 0) {
              machines[i] = { ...machines[i], ...rec, id: machines[i].id, password: rec.password || machines[i].password || '' }
              mrec = machines[i]
            } else {
              mrec = { id: machineId(), name: host, ...rec }
              machines.push(mrec)
            }
          }
          saveMachines(machines, store.currentId, false)
          contexts.bind(id, mrec.id)
          // workspace = existing context workspace, else the machine's stored one.
          if (!entry.workspace && mrec.workspace) contexts.setWorkspace(id, mrec.workspace)
        } else {
          // Ephemeral: an in-memory-only binding on THIS context (never
          // persisted, invisible to other sessions, gone on restart/eviction).
          // For a registry machine the record carries the resolved secret +
          // passphrase + connection fields (in-memory only — ephemerals are
          // never written to disk). proxy/useAgent/keyboardInteractive/
          // hostKeyMode are undefined for an explicit host (no registry
          // machine to read them from) — resolvePool treats absent and
          // undefined identically (falls back to config default).
          contexts.bindEphemeral(id, { id: machineId(), name: host, ...rec, passphrase, proxy, useAgent, keyboardInteractive, hostKeyMode })
        }
        try {
          const b = await requireBound(id)
          const res = await b.pool.exec('echo ok', { timeoutMs: 8000 })
          if (res.code !== 0 && !res.stdout) {
            audit(id, 'connect', `connect ${user}@${host}:${port}`, res.code, { host, port, username: user })
            return { text: 'connect failed: ' + (res.stderr || 'exit ' + res.code) }
          }
          audit(id, 'connect', `connect ${user}@${host}:${port}`, 0, { host, port, username: user })
          return { text: `Connected to ${host} as ${user}.\n\npick a workspace with rw_pick_workspace (path=<abs>).` }
        } catch (err) {
          throw new Error(friendlyMessage(err, { host, port }))
        }
      },
    }),

    defineTool({
      name: 'rw_pick_workspace',
      description:
        'Set the remote workspace directory this session should treat as its working root on the connected remote. Verifies it exists (a directory). Use rw_list_dir to browse first if unsure. Accepts POSIX (/home/dev/project) or Windows (C:\\Users\\dev\\project) paths. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path, e.g. /home/dev/code/project or C:\\Users\\dev\\project' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_pick_workspace: path must be an absolute directory')
        const ok = await isRemoteDir(b.pool, p)
        const shown = toDisplayPath(p, b.pool.platform)
        if (!ok) return { text: `not a directory (or missing) on ${shown}` }
        persistWorkspaceFor(id, p)
        const local = ensureMirror(p, b.machine.host, b.machine.username, b.machine.port)
        startAutoPush(local, id)
        return {
          text: `Remote workspace set to ${shown} on ${b.machine.username}@${b.machine.host} (saved for this machine).\nLocal mirror (native workspace path): ${local}\n\nRun rw_sync to download its files into the local mirror.`,
        }
      },
    }),

    defineTool({
      name: 'rw_sync',
      description:
        'Download the current remote workspace into its local mirror directory over SFTP (bounded, three-way conflict-aware). Makes the remote files visible/editable locally so the DSH native workspace / fs tools can operate on them. Conflicts (both sides modified) are reported and never overwritten; use force=true to override. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        depth: { type: 'integer', description: 'Max directory depth to mirror (default 5)' },
        maxFiles: { type: 'integer', description: 'Max files to download (default 500)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without downloading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = b.workspace
        if (!p) throw new Error('rw_sync: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, b.machine.host, b.machine.username, b.machine.port)
        mkdirSync(local, { recursive: true })
        const depth = Math.min(Math.max(Number(args.depth) || 5, 1), 8)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        const isIgnored = ignoreMatcher()
        const body = { depth, maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runSync = async () => {
          let sftp
          try {
            sftp = await b.pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await syncTree(sftp, p, local, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD download' : 'Downloaded'} ${stats.files} file(s) from ${p} → ${local}${stats.files >= maxFiles ? ' (hit download cap)' : ''}.`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleRemote) text += ` ${stats.staleRemote} remote entries gone (kept locally; use rw_push to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('sync', `sync ${p}`, runSync)
          return { text: `sync started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runSync()
      },
    }),

    defineTool({
      name: 'rw_push',
      description:
        'Upload the local mirror of the current remote workspace back to the remote host over SFTP (bounded, three-way conflict-aware). Use after editing files in the local mirror so the remote reflects your changes. Conflicts (both sides modified) are reported and never overwritten; use force=true to override. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        maxFiles: { type: 'integer', description: 'Max files to upload (default 500)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without uploading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = b.workspace
        if (!p) throw new Error('rw_push: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, b.machine.host, b.machine.username, b.machine.port)
        if (!existsSync(local)) throw new Error(`rw_push: local mirror does not exist — run rw_sync first (${local})`)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        const isIgnored = ignoreMatcher()
        const body = { maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runPush = async () => {
          let sftp
          try {
            sftp = await b.pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await pushTree(sftp, local, p, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD upload' : 'Uploaded'} ${stats.files} file(s) from ${local} → ${p}.`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleLocal) text += ` ${stats.staleLocal} local entries gone remotely (kept remotely; use rw_remove to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('push', `push ${p}`, runPush)
          return { text: `push started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runPush()
      },
    }),

    defineTool({
      name: 'rw_list_dir',
      description:
        'List a remote directory (or a single file) via SSH. Path is absolute; accepts Windows paths like C:\\Users\\dev\\project on Git Bash remotes. If omitted, lists the current remote workspace. Shows type, size, mtime. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', description: 'Absolute remote path (default: current remote workspace)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = args.path ? normalizeRemotePath(String(args.path)) : b.workspace
        if (!p) throw new Error('rw_list_dir: no path and no remote workspace set')
        let list
        try {
          const sftp = await b.pool.sftp()
          list = await sftp.readdir(p)
        } catch (err) {
          throw new Error('rw_list_dir: ' + ((err && err.message) || err))
        }
        const fmtMtime = (t) => {
          if (!t) return '?'
          const d = new Date(t * 1000)
          const pad = (n) => String(n).padStart(2, '0')
          return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
        }
        const lines = list
          .filter((e) => String(e.filename) !== '.' && String(e.filename) !== '..')
          .map((e) => {
            const a = e.attrs || {}
            const type = a.isDirectory && a.isDirectory() ? 'd' : (a.isSymbolicLink && a.isSymbolicLink() ? 'l' : '-')
            const size = typeof a.size === 'number' ? String(a.size) : '?'
            return `${type} ${size.padStart(10)} ${fmtMtime(a.mtime).padEnd(17)} ${String(e.filename)}`
          })
        return { text: lines.length ? lines.join('\n') : '(empty directory)' }
      },
    }),

    defineTool({
      name: 'rw_stat',
      description:
        'Show detailed stat of a remote file or directory: type, size, mtime, mode (SFTP attrs). Use to verify a remote path exists or to compare files. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p) throw new Error('rw_stat: path is required')
        const sftp = await b.pool.sftp()
        let st
        try {
          st = await sftp.stat(p)
        } catch (err) {
          throw new Error('rw_stat: not found or unreadable: ' + ((err && err.message) || err))
        }
        const type = st.isDirectory && st.isDirectory() ? 'directory' : (st.isSymbolicLink && st.isSymbolicLink() ? 'symlink' : 'file')
        const lines = [
          `path: ${p}`,
          `type: ${type}`,
          `size: ${st.size} bytes`,
          `mtime: ${new Date(st.mtime * 1000).toISOString()}`,
          `mode: ${typeof st.mode === 'number' ? st.mode.toString(8) : '?'}`,
        ]
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_read_file',
      description:
        'Read a text file on the remote host with line numbers. Supports paging with startLine/endLine and an encoding param (utf-8 default, gbk etc). Path is absolute. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        startLine: { type: 'integer', description: '1-based first line (default 1)' },
        endLine: { type: 'integer', description: '1-based last line (inclusive)' },
        maxLines: { type: 'integer', description: 'Max lines (default 2000)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p) throw new Error('rw_read_file: path is required')
        const maxLines = Math.min(Math.max(Number(args.maxLines) || 2000, 1), 10000)
        let from = Math.max(Number(args.startLine) || 1, 1)
        let to = Number(args.endLine) || 0
        if (!to || to - from + 1 > maxLines) to = from + maxLines - 1
        const sftp = await b.pool.sftp()
        let st
        try { st = await sftp.stat(p) } catch (err) { throw new Error('rw_read_file: ' + ((err && err.message) || err)) }
        if (config.maxFileBytes > 0 && st.size > config.maxFileBytes) {
          throw new Error(`rw_read_file: file is ${st.size} bytes (over ${config.maxFileBytes} cap); use rw_download or rw_exec to read it`)
        }
        let buf
        try {
          buf = await sftp.readFile(p)
        } catch (err) {
          throw new Error('rw_read_file: ' + ((err && err.message) || err))
        }
        const content = decodeBuf(buf, args.encoding || config.encoding).replace(/\r\n/g, '\n')
        const allLines = content.split('\n')
        const page = allLines.slice(from - 1, to)
        const numbered = page.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n').replace(/\s+$/, '')
        let text = numbered === '' ? '(empty or out of range)' : numbered
        if (!args.endLine) text += '\n(shown up to ' + maxLines + ' lines; use startLine/endLine to page)'
        return { text }
      },
    }),

    defineTool({
      name: 'rw_write_file',
      description:
        'Write text to a file on the remote host (creating parent directories if needed). Path is absolute. Use this to create or overwrite a remote file directly, instead of round-tripping through a local mirror. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'File content to write (overwrites existing file)' },
        mkdir: { type: 'boolean', description: 'Create missing parent directories (default true)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_write_file: a file path is required')
        const content = String(args.content == null ? '' : args.content)
        const sftp = await b.pool.sftp()
        if (args.mkdir !== false) await mkdirRemoteDirs(sftp, remoteDirname(p))
        const buf = encodeText(content, args.encoding || config.encoding)
        await sftp.writeFile(p, buf)
        const bytes = buf.byteLength
        audit(id, 'write_file', `write ${p} (${bytes}B)`, 0, b.machine)
        return { ok: true, bytes, text: `wrote ${bytes} bytes to ${p}` }
      },
    }),

    defineTool({
      name: 'rw_edit',
      description:
        'Edit a remote text file by replacing literal text (read-modify-write with an mtime optimistic lock: aborts if the file changed on the remote between read and write). Path is absolute. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        old: { type: 'string', required: true, description: 'Literal text to replace (must appear exactly once unless count is given)' },
        new: { type: 'string', required: true, description: 'Replacement text' },
        count: { type: 'integer', description: 'How many occurrences to replace (default: error if the text appears more than once)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_edit: a file path is required')
        const oldS = String(args.old ?? '')
        const newS = String(args.new ?? '')
        if (oldS === '') throw new Error('rw_edit: old text must not be empty')
        const sftp = await b.pool.sftp()
        const st0 = await sftp.stat(p)
        const buf = await sftp.readFile(p)
        const content = decodeBuf(buf, args.encoding || config.encoding)
        const count = args.count == null ? 0 : Math.max(Number(args.count) || 1, 1)
        const idxs = []
        let from = 0
        let hit
        while ((hit = content.indexOf(oldS, from)) !== -1) { idxs.push(hit); from = hit + oldS.length }
        if (!idxs.length) throw new Error(`rw_edit: old text not found in ${p}`)
        if (count === 0 && idxs.length > 1) {
          throw new Error(`rw_edit: "old" appears ${idxs.length} times in ${p} — pass count=<n> to pick how many to replace`)
        }
        const n = count === 0 ? 1 : Math.min(count, idxs.length)
        let out = content
        for (let i = n - 1; i >= 0; i--) {
          out = out.slice(0, idxs[i]) + newS + out.slice(idxs[i] + oldS.length)
        }
        // Optimistic lock: the remote must not have changed since we read it.
        const st1 = await sftp.stat(p)
        if (st1.size !== st0.size || st1.mtime !== st0.mtime) {
          throw new Error(`rw_edit: ${p} changed on the remote while editing (conflict) — re-read and retry`)
        }
        await sftp.writeFile(p, encodeText(out, args.encoding || config.encoding))
        audit(id, 'edit', `edit ${p} (${n} occurrence(s))`, 0, b.machine)
        return { ok: true, bytes: Buffer.byteLength(out), text: `edited ${p}: replaced ${n} occurrence(s)` }
      },
    }),

    defineTool({
      name: 'rw_append',
      description:
        'Append text to a remote file (creates it when missing). Path is absolute. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'Text to append' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_append: a file path is required')
        const sftp = await b.pool.sftp()
        let existing = ''
        try { existing = decodeBuf(await sftp.readFile(p), args.encoding || config.encoding) } catch { /* new file */ }
        const content = existing + String(args.content ?? '')
        await sftp.writeFile(p, encodeText(content, args.encoding || config.encoding))
        const bytes = Buffer.byteLength(content)
        audit(id, 'append', `append ${p}`, 0, b.machine)
        return { ok: true, bytes, text: `appended to ${p} (now ${bytes} bytes)` }
      },
    }),

    defineTool({
      name: 'rw_mkdir',
      description:
        'Create a remote directory (mkdir -p semantics, all levels). Path is absolute. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_mkdir: a directory path is required')
        const sftp = await b.pool.sftp()
        await mkdirRemoteDirs(sftp, p)
        audit(id, 'mkdir', `mkdir ${p}`, 0, b.machine)
        return { text: `created ${p}` }
      },
    }),

    defineTool({
      name: 'rw_remove',
      description:
        'Delete a remote file (or an empty directory). recursive=true removes a directory tree (bounded). Path is absolute. This is destructive — the agent should confirm intent before calling. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path to delete' },
        recursive: { type: 'boolean', description: 'Recursively delete a directory (default false)' },
      },
      output: okOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_remove: a path is required')
        const sftp = await b.pool.sftp()
        const st = await sftp.stat(p).catch(() => null)
        if (!st) return { ok: false, text: `not found: ${p}` }
        if (st.isDirectory && st.isDirectory()) {
          if (!args.recursive) throw new Error(`rw_remove: ${p} is a directory — pass recursive=true to delete its tree`)
          const removed = await removeRemoteTree(sftp, p)
          audit(id, 'remove', `remove -r ${p}`, 0, b.machine)
          return { ok: true, text: `removed ${removed} entries under ${p}` }
        }
        await sftp.unlink(p)
        audit(id, 'remove', `remove ${p}`, 0, b.machine)
        return { ok: true, text: `removed ${p}` }
      },
    }),

    defineTool({
      name: 'rw_move',
      description:
        'Rename or move a remote file/directory (SFTP rename, same filesystem). Paths are absolute. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Current absolute remote path' },
        dest: { type: 'string', required: true, description: 'Destination absolute remote path' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        const d = normalizeRemotePath(String(args.dest || ''))
        if (!p || !d || p === '/') throw new Error('rw_move: both path and dest are required')
        const sftp = await b.pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(d))
        await sftp.rename(p, d)
        audit(id, 'move', `move ${p} → ${d}`, 0, b.machine)
        return { text: `moved ${p} → ${d}` }
      },
    }),

    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the remote host. Use for anything that is not reading a file (build, test, grep, etc). Output is capped. Runs in the current remote workspace by default; pass cwd to run elsewhere. pty=true helps interactive commands (sudo prompts, REPLs); env sets environment variables. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command (run on the remote host)' },
        cwd: { type: 'string', description: 'Working directory for the command (default: the current remote workspace)' },
        pty: { type: 'boolean', description: 'Allocate a pseudo-terminal (interactive commands, default false)' },
        env: { type: 'object', additionalProperties: true, description: 'Extra environment variables (string values)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const cmd = String(args.command || '')
        if (!cmd) throw new Error('rw_exec: command is required')
        const cwd = args.cwd ? normalizeRemotePath(String(args.cwd)) : (b.workspace || '')
        let full = cmd
        if (cwd) {
          if (b.pool.platform === 'windows' && b.pool.gitBashPath) {
            // Git Bash terminal: cd in the /c/Users/… mount form
            full = `cd ${shq(toShellPath(cwd))} && ${cmd}`
          } else if (!cwd.includes('\\')) {
            full = `cd ${shq(cwd)} && ${cmd}`
          }
        }
        try {
          const res = await b.pool.exec(full, { timeoutMs: config.commandTimeoutMs, pty: !!args.pty, env: args.env })
          audit(id, 'exec', cmd, res.code, b.machine)
          const parts = []
          if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
          if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
          if (!parts.length) parts.push('(no output)')
          let text = parts.join('\n')
          if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${config.commandTimeoutMs}ms]`
          else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
          return { text }
        } catch (err) {
          throw new Error(friendlyMessage(err, { host: b.machine.host, port: b.machine.port }))
        }
      },
    }),

    defineTool({
      name: 'rw_search',
      description:
        'Search remote files for a pattern (recursive SFTP walk — works on ANY remote including Windows, honors ignore rules). Returns matching file:line rows; output is capped. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        pattern: { type: 'string', required: true, description: 'Pattern to search for (extended regex)' },
        path: { type: 'string', description: 'Directory to search (default: current remote workspace)' },
        glob: { type: 'string', description: 'Only files whose NAME matches this glob, e.g. *.ts (optional)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default true)' },
        contextLines: { type: 'integer', description: 'Lines of context around each match (default 0)' },
        maxMatches: { type: 'integer', description: 'Max matches to return (default 500)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const pattern = String(args.pattern || '')
        if (!pattern) throw new Error('rw_search: pattern is required')
        const dir = args.path ? normalizeRemotePath(String(args.path)) : (b.workspace || '')
        if (!dir) throw new Error('rw_search: no path and no remote workspace set')
        let regex
        try {
          regex = new RegExp(pattern, args.ignoreCase === false ? '' : 'i')
        } catch (err) {
          throw new Error('rw_search: bad pattern: ' + ((err && err.message) || err))
        }
        const sftp = await b.pool.sftp()
        const maxMatches = Math.min(Math.max(Number(args.maxMatches) || 500, 1), 2000)
        const matcher = ignoreMatcher()
        const { matches, scanned, truncated } = await searchTree(sftp, dir, {
          regex,
          glob: args.glob,
          contextLines: Math.min(Math.max(Number(args.contextLines) || 0, 0), 10),
          maxMatches,
          maxScanBytes: Math.min(config.maxFileBytes || 1024 * 1024, 1024 * 1024),
          isIgnored: (name, isDir) => matcher(name, isDir),
        })
        if (!matches.length) return { text: `no matches for /${pattern}/ in ${dir} (${scanned} files scanned)` }
        let text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')
        text += `\n(${matches.length} match(es), ${scanned} files scanned${truncated ? ', TRUNCATED' : ''})`
        return { text: truncate(text, config.maxOutputChars) }
      },
    }),

    defineTool({
      name: 'rw_download',
      description:
        'Download a single remote file over SFTP into the local mirror of the current workspace (or to an explicit local path). Use when you need the actual file content locally, not just its text. Streams to disk (fastGet). Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        localPath: { type: 'string', description: 'Local destination (default: the workspace mirror, preserving the relative path)' },
      },
      output: okOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_download: a remote file path is required')
        const sftp = await b.pool.sftp()
        let local
        if (args.localPath) {
          local = path.resolve(String(args.localPath))
        } else {
          const ws = b.workspace
          if (!ws) throw new Error('rw_download: no remote workspace set — pass localPath explicitly')
          const base = mirrorDirFor(ws, b.machine.host, b.machine.username, b.machine.port)
          const rel = p.startsWith(ws) ? p.slice(ws.length).replace(/^\/+/, '') : p.slice(1)
          local = path.join(base, rel)
        }
        mkdirSync(path.dirname(local), { recursive: true })
        const st = await sftp.stat(p).catch(() => null)
        if (config.maxFileBytes > 0 && st && st.size > config.maxFileBytes) {
          throw new Error(`rw_download: file is ${st.size} bytes (over ${config.maxFileBytes} cap)`)
        }
        await sftp.fastGet(p, local)
        const bytes = existsSync(local) ? statSync(local).size : 0
        return { ok: true, bytes, text: `downloaded ${bytes} bytes from ${p} → ${local}` }
      },
    }),

    defineTool({
      name: 'rw_upload',
      description:
        'Upload a local file over SFTP to a path on the remote host (creating parent directories if needed). Use to push a local file directly, without a full rw_push of the whole mirror. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context.',
      parameters: {
        localPath: { type: 'string', required: true, description: 'Absolute local file path' },
        path: { type: 'string', required: true, description: 'Absolute remote destination path' },
      },
      output: okOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        const b = await requireBound(id)
        const rp = normalizeRemotePath(String(args.path || ''))
        const lp = String(args.localPath || '')
        if (!rp || rp === '/' || !lp) throw new Error('rw_upload: both localPath and a remote path are required')
        if (!existsSync(lp)) throw new Error(`rw_upload: local file not found: ${lp}`)
        const sftp = await b.pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(rp))
        const st = statSync(lp)
        await sftp.fastPut(lp, rp)
        audit(id, 'upload', `upload ${lp} → ${rp}`, 0, b.machine)
        return { ok: true, bytes: st.size, text: `uploaded ${st.size} bytes from ${lp} → ${rp}` }
      },
    }),

    defineTool({
      name: 'rw_forward',
      description:
        'Manage SSH port forwards. Direction "local" listens on 127.0.0.1:<listenPort> on THIS machine and forwards connections through SSH to <targetHost>:<targetPort> on the remote. Direction "reverse" asks the REMOTE to listen on 127.0.0.1:<listenPort> and pipes connections back to <targetHost>:<targetPort> on this machine. Call with a listenPort to create+start; with remove=true to delete. Remote context is per-session (per agent thread): each agent thread has its own machine + workspace; sub-agents start with no remote context. Forwards start on THIS session\'s connection.',
      parameters: {
        listenPort: { type: 'integer', required: true, description: 'Port to listen on (local for direction=local, remote for direction=reverse)' },
        targetHost: { type: 'string', description: 'Forward target host (default 127.0.0.1)' },
        targetPort: { type: 'integer', description: 'Forward target port (default: same as listenPort)' },
        direction: { type: 'string', description: 'local (default) or reverse' },
        autoStart: { type: 'boolean', description: 'Restart this forward automatically on future connects (default false)' },
        remove: { type: 'boolean', description: 'Remove an existing forward by listenPort (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { id, entry } = contextOf(exec)
        const b = await requireBound(id)
        const port = Number(args.listenPort)
        if (!port || port < 1 || port > 65535) throw new Error('rw_forward: a valid listenPort is required')
        const dir = args.direction === 'reverse' ? 'reverse' : 'local'
        const existing = forwards.list().find((f) => Number(f.listenPort) === port && f.direction === dir)
        if (args.remove) {
          if (!existing) return { text: `no forward on port ${port} to remove` }
          forwards.remove(existing.id)
          return { text: `removed ${existing.direction} forward on port ${port}` }
        }
        if (existing && existing.active) return { text: `already active: ${existing.direction} forward 127.0.0.1:${port} → ${existing.targetHost}:${existing.targetPort}` }
        const d = existing || forwards.define({
          direction: dir,
          listenPort: port,
          targetHost: args.targetHost || '127.0.0.1',
          targetPort: Number(args.targetPort) || port,
          autoStart: !!args.autoStart,
          // Bound to THIS context's machine (null for ephemeral/config-default
          // bindings, which match any pool on autoStart).
          machineId: entry.machineId || null,
        })
        const r = await forwards.start(d, b.pool)
        audit(id, 'forward', `${d.direction} forward ${port} → ${d.targetHost}:${d.targetPort}`, r.ok ? 0 : 1, b.machine)
        if (!r.ok) throw new Error(r.error)
        return { text: `${d.direction} forward active: 127.0.0.1:${port} → ${d.targetHost}:${d.targetPort} (id=${d.id})` }
      },
    }),

    defineTool({
      name: 'rw_disconnect',
      description:
        'Close the current SSH connection to the remote host, releasing the persistent pool (and stopping all active port forwards). Useful to rotate connections or after a long idle. Closes only THIS session\'s connection (its pool + forwards); other sessions\' remote contexts are unaffected.',
      parameters: {},
      output: okOut,
      async execute(args, exec) {
        const { id } = contextOf(exec)
        contexts.closePool(id)
        releaseContextWatchers(id)
        return { ok: true, text: 'disconnected (forwards stopped)' }
      },
    }),
  ]

  for (const t of tools) {
    ctx.tools.register(t)
  }

  // ── system-prompt injection: per-agent remote context ─────────────────────
  // The section text is evaluated synchronously per prompt assembly with the
  // current agent present (promptContext.agent.id === session id). It reads
  // STORED context state only — it never triggers a connection.
  //   1) Per-agent context (primary): if THIS agent's context is bound to a
  //      machine and has a workspace → inject machine + workspace (+ the
  //      active forwards of that context's pool when the pool is live).
  //   2) Fallback (legacy mirror-cwd, issue #13): a session opened directly
  //      in a dsh-remote mirror dir still gets the remote section mapped via
  //      resolveMirrorForLocal.
  // A plain local agent thread (unbound, cwd not in a mirror) gets no remote
  // section — sub-agents start clean and saved machines never leak into an
  // unrelated session's prompt.
  ctx.systemPrompt.section({
    name: 'dsh-remote',
    order: 88,
    text: (promptContext) => {
      const agent = promptContext && promptContext.agent
      // 1) per-agent context (bound machine + workspace → inject)
      if (agent && agent.id) {
        const contextId = sanitizeContextId(agent.id)
        const entry = contexts.peek(contextId)
        const machine = contexts.activeMachineOf(contextId)
        if (machine && machine.host) {
          const workspace = (entry && entry.workspace) || machine.workspace || ''
          if (workspace) {
            const pool = entry && entry.pool
            const fwd = pool ? forwards.activeFor(pool).map((f) => `${f.direction}:127.0.0.1:${f.listenPort}→${f.targetHost}:${f.targetPort}`) : []
            let extra = ''
            if (fwd.length) extra = `\nActive port forwards: ${fwd.join(', ')}`
            return (
              '## Remote workspace\n' +
              `Current remote workspace: ${machine.username || 'user'}@${machine.host}:${toDisplayPath(workspace, pool ? pool.platform : 'unknown')}\n` +
              'Use the rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_edit / rw_exec / rw_search / rw_sync / rw_push) to inspect and act on files on the remote host. Treat this directory as the working root for this task.' +
              extra
            )
          }
        }
      }
      // 2) fallback — legacy mirror-cwd sessions
      const session = agent && agent.session
      const cwd = session && session.header && session.header.cwd
      if (!cwd) return '' // no session cwd → nothing to map → stay quiet
      const { remotePath } = resolveMirrorForLocal(cwd)
      if (!remotePath) return '' // this session is NOT a remote session (issue #13)
      const gm = contexts.activeMachineOf(GLOBAL_CONTEXT_ID)
      const gentry = contexts.peek(GLOBAL_CONTEXT_ID)
      const gpool = gentry && gentry.pool
      const fwd = forwards.list().filter((f) => f.active).map((f) => `${f.direction}:127.0.0.1:${f.listenPort}→${f.targetHost}:${f.targetPort}`)
      let extra = ''
      if (fwd.length) extra = `\nActive port forwards: ${fwd.join(', ')}`
      return (
        '## Remote workspace\n' +
        `Current remote workspace: ${(gm && gm.username) || config.username || 'user'}@${(gm && gm.host) || config.host}:${toDisplayPath(remotePath, gpool ? gpool.platform : 'unknown')}\n` +
        'Use the rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_edit / rw_exec / rw_search / rw_sync / rw_push) to inspect and act on files on the remote host. Treat this directory as the working root for this task.' +
        extra
      )
    },
  })

  // ── slash commands ─────────────────────────────────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: 'Show the current remote workspace / connection status, active forwards, and how to use remote tools.',
      handler: (invocation) => {
        const s = status()
        const fwd = s.forwards.filter((f) => f.active)
        return {
          kind: 'success',
          text:
            `Remote host: ${s.username}@${s.host || '<none>'} (connected: ${s.connected}, source: ${s.activeSource})\n` +
            `Remote workspace: ${s.workspace || '(none)'}\n` +
            `Host key: ${s.hostKeyKnown ? 'trusted ✓' : 'not yet trusted'} (mode=${s.hostKeyMode})\n` +
            (s.hostKeyKnown ? `  — if the key changed / was mistrusted, run /remote-forget-key\n` : '') +
            (fwd.length ? `Active forwards:\n${fwd.map((f) => `  ${f.direction} 127.0.0.1:${f.listenPort} → ${f.targetHost}:${f.targetPort}`).join('\n')}\n` : '') +
            `\nUse tools: rw_list_dir / rw_read_file / rw_edit / rw_exec / rw_search / rw_forward.` +
            (s.workspace ? `\nCurrently working in ${s.workspace}.` : ''),
        }
      },
    })
    commands.register({
      name: 'remote-forget-key',
      description: 'Drop the trusted host-key record for the current machine so the next connect re-records it.',
      handler: () => {
        // The __global__ context's machine (settings UI / agentless callers),
        // falling back to the config default when the global context is unbound.
        const gm = contexts.activeMachineOf(GLOBAL_CONTEXT_ID)
        const host = (gm && gm.host) || config.host
        const port = gm ? (Number(gm.port) || 22) : config.port
        createHostKeyGuard({ host: host || '', port, hostKeyMode: config.hostKeyMode }).forgetHost()
        return { kind: 'success', text: `forgot host key for ${host || '<none>'}:${port} — the next connect will re-record it.` }
      },
    })
    commands.register({
      name: 'remote-ignore',
      description: 'Show the mirror ignore rules file location and the current default patterns (gitignore syntax).',
      handler: () => {
        return {
          kind: 'success',
          text:
            `Ignore file: ${ignoreFile()}\n(defaults merged with the file; gitignore syntax, '#' comments)\n\nDefault patterns:\n${DEFAULT_IGNORE.map((p) => '  ' + p).join('\n')}`,
        }
      },
    })
  }

  // ── JSON endpoints for settings UI ─────────────────────────────────────────
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const MAX_BODY_BYTES = 1024 * 1024
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let total = 0
      req.on('data', (c) => {
        total += c.length
        if (total > MAX_BODY_BYTES) {
          req.removeAllListeners('data')
          resolve('{}')
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(chunks.join('')))
    })

  // ── 本机目录选择器：DSH directoryPicker 服务优先，缺位/非原生则自持兜底 ──
  const PICK_TIMEOUT_MS = 120000
  const runPick = (bin, args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: PICK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code
          const msg = String(stderr || '')
          if (code === 1 && /(?:user canceled|-128)/i.test(msg)) return resolve({ cancelled: true })
          if (err.signal || err.killed) return reject(new Error('目录选择已超时，请重试或直接在输入框填本地路径'))
          if (code === 'ENOENT') return reject(Object.assign(new Error('未找到目录选择器程序 ' + bin), { code }))
          return reject(new Error((msg.trim() || (err && err.message) || '无法打开系统文件夹选择器').split('\n')[0]))
        }
        const p = String(stdout || '').replace(/[\r\n]+$/, '').trim()
        resolve(p === 'CANCELED' ? { cancelled: true } : (p ? { path: p } : { cancelled: true }))
      })
    })
  const pickLocalNative = async () => {
    const platform = process.platform
    if (platform === 'darwin') {
      return runPick('osascript', ['-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"', '-e', 'POSIX path of selectedFolder'])
    }
    if (platform === 'linux') {
      try {
        return await runPick('zenity', ['--file-selection', '--directory', '--title=Select Workspace Directory'])
      } catch (err) {
        if (err && err.code === 'ENOENT') return runPick('kdialog', ['--getexistingdirectory', '.', '--title', 'Select Workspace Directory'])
        throw err
      }
    }
    if (platform === 'win32') {
      const script =
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `$f = New-Object System.Windows.Forms.FolderBrowserDialog;` +
        `$f.Description = 'Select Workspace Directory';` +
        `if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { 'CANCELED' }`
      return runPick('powershell', ['-NoProfile', '-STA', '-Command', script])
    }
    throw new Error('当前系统不支持自动打开目录选择器，请在输入框直接填本地路径')
  }

  /** The ctx.directoryPicker capability object, or null when the service is
   * absent/unusable. Never throws — callers fall through to pickLocalNative. */
  const localPickCapability = async () => {
    const dp = (ctx && typeof ctx.get === 'function') ? (ctx.get('directoryPicker') || null) : null
    if (!dp || typeof dp.capability !== 'function') return null
    try {
      return await Promise.resolve(dp.capability())
    } catch {
      return null
    }
  }

  /** Windows has no single filesystem root — enumerate fixed/mapped drive
   * letters so the in-app browser can switch between them (the browse
   * backend's crumbs stop at the current drive's root). Empty on POSIX. */
  const listLocalDrives = () => {
    if (process.platform !== 'win32') return []
    const out = []
    for (let i = 67; i <= 90; i++) { // C..Z (A/B are legacy floppy — skip)
      const root = String.fromCharCode(i) + ':\\'
      try {
        statSync(root)
        out.push({ name: root.slice(0, -1), path: root })
      } catch {}
    }
    return out
  }

  // ── route helpers ─────────────────────────────────────────────────────────
  const routes = [
    {
      kind: 'exact',
      path: '/dsh-remote/status',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
          // Per-session remote context: ?sessionId= targets THAT session's
          // context (machine + workspace + pool); omitted → __global__ (the
          // legacy machine-global status the settings UI already uses).
          return sendJson(res, 200, status(contextIdOf(sessionId)))
        }
        sendJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      // Map a LOCAL path (typically a session cwd that sits inside a remote
      // mirror dir) to the remote path it mirrors, by reading each mirror
      // dir's .dsh-remote-meta.json. NO machine-workspace fallback (issue #13):
      // a session whose cwd is not inside any mirror is a pure LOCAL session —
      // the sidebar must show "no remote workspace", never another machine's
      // remembered default.
      // Accepts either ?local=<abs path> or ?sessionId=<id> (resolved via
      // the host sessions service header.cwd).
      kind: 'exact',
      path: '/dsh-remote/resolve-mirror',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let local = q.get('local') ? decodeURIComponent(q.get('local')) : ''
          const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
          let resolvedVia = 'query'
          if (!local && sessionId) {
            // 1) Live in-memory session header (active sessions only).
            try {
              const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
              const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
              const header = session && session.header ? session.header : null
              if (header && header.cwd) {
                local = String(header.cwd)
                resolvedVia = 'session'
              }
            } catch { /* sessions service unavailable */ }
            // 2) Durable session log header (works for historical sessions too):
            //    walk $DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
            //    and read the header line (first zstd frame) for cwd.
            if (!local) {
              try {
                const sessionsRoot = path.join(dshBase(), 'sessions')
                if (existsSync(sessionsRoot)) {
                  const targetDir = encodeSegmentSafe(sessionId)
                  for (const projDir of readdirSync(sessionsRoot)) {
                    const projPath = path.join(sessionsRoot, projDir)
                    if (!statSync(projPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
                    const sessDir = path.join(projPath, targetDir)
                    if (!statSync(sessDir, { throwIfNoEntry: false })?.isDirectory?.()) continue
                    const logFile = ['session.jsonl.zstd', 'session.jsonl', 'session.jsonl.gz'].map((n) => path.join(sessDir, n)).find((p) => existsSync(p))
                    if (!logFile) continue
                    const cwd = readSessionHeaderCwd(logFile)
                    if (cwd) {
                      local = cwd
                      resolvedVia = 'session-log'
                      break
                    }
                  }
                }
              } catch { /* session log scan failed */ }
            }
          }
          const root = remoteWorkspacesRoot()
          const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '') || ''
          let matched = ''
          let matchedRemote = ''
          if (local && existsSync(root)) {
            const base = norm(local)
            for (const hostDir of readdirSync(root)) {
              const hostPath = path.join(root, hostDir)
              if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
              for (const mirrorDir of readdirSync(hostPath)) {
                const metaPath = path.join(hostPath, mirrorDir, '.dsh-remote-meta.json')
                if (!existsSync(metaPath)) continue
                try {
                  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
                  const mirrorAbs = norm(path.join(hostPath, mirrorDir))
                  // Exact mirror dir match, or the local path is inside the mirror dir.
                  if (mirrorAbs === base || base.startsWith(mirrorAbs + path.sep) || base.startsWith(mirrorAbs + '/')) {
                    if (mirrorAbs.length > matched.length) {
                      matched = mirrorAbs
                      matchedRemote = String(meta.remotePath || '')
                    }
                  }
                } catch { /* skip unparsable meta */ }
              }
            }
          }
          // Issue #13: a non-mirror session is LOCAL — remotePath stays empty.
          const remotePath = matchedRemote || ''
          return sendJson(res, 200, {
            local, remotePath, mirrorDir: matched || null,
            // `fallback:true` now means "this session is NOT a remote session"
            // (used to mean "fell back to machine workspace").
            fallback: !matchedRemote,
            mode: matchedRemote ? 'remote' : 'local',
            resolvedVia,
          })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          // body.sessionId targets THAT session's context; omitted → __global__.
          const id = contextIdOf(payload.sessionId)
          if (payload.action === 'disconnect') {
            // The only web disconnect means: close THIS context's pool + stops
            // its forwards. The binding (machine + workspace) survives.
            contexts.closePool(id)
            releaseContextWatchers(id)
            return sendJson(res, 200, { ok: true, ...status(id) })
          }
          const machineIdArg = payload.machineId ? String(payload.machineId).trim() : ''
          let host = ''
          let port = 22
          let user = ''
          let password = ''
          let privateKeyPath = ''
          let passphrase = ''
          if (machineIdArg) {
            // machineId → resolve the registry machine (host/port/username) and
            // its keychain password, then bind the calling context to it.
            const i = machineIndex(machineIdArg)
            if (i < 0) return sendJson(res, 400, { ok: false, error: `machine ${machineIdArg} not found in registry` })
            const m = machines[i]
            host = String(m.host || '')
            port = Number(m.port) || 22
            user = m.username || ''
            password = (await machinePassword(m)) || ''
            privateKeyPath = m.privateKeyPath || ''
            passphrase = m.passphrase || ''
            contexts.bind(id, m.id)
          } else {
            host = String(payload.host || '').trim()
            if (!host) return sendJson(res, 400, { ok: false, error: 'host or machineId is required' })
            port = Number(payload.port) || (Number(config.port) || 22)
            user = payload.username !== undefined && payload.username !== '' ? String(payload.username) : (config.username || '')
            password = payload.password !== undefined && payload.password !== '' ? String(payload.password) : ''
            privateKeyPath = payload.privateKeyPath ? String(payload.privateKeyPath) : ''
            passphrase = payload.passphrase ? String(payload.passphrase) : ''
            // An explicit-host web connect is an EPHEMERAL binding on this
            // context (never persisted, issue #13).
            contexts.bindEphemeral(id, { id: machineId(), name: host, host, port, username: user, password, privateKeyPath, passphrase })
          }
          if (payload.workspace) contexts.setWorkspace(id, String(payload.workspace))
          const pool = await contexts.resolvePool(id)
          if (!pool) return sendJson(res, 400, { ok: false, error: 'no remote context for this session — call rw_connect first' })
          await pool.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs || 20000, 8000) })
          return sendJson(res, 200, { ok: true, ...status(id) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: friendlyMessage(err, { host: payload && payload.host, port: payload && payload.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ls',
      handler: async (req, res) => {
        try {
          // ?sessionId= → that session's context; omitted → __global__.
          const q = new URL(req.url, 'http://localhost').searchParams
          const id = contextIdOf(q.get('sessionId'))
          const b = await requireBound(id)
          await b.pool.detect()
          const raw = q.get('path') ? decodeURIComponent(q.get('path')) : b.workspace
          const canon = normalizeRemotePath(raw)
          const win = b.pool.platform === 'windows'
          // Windows root → "This PC" drive view (C:\ D:\ E:\), not the Git-Bash
          // MSYS root. When the platform probe was inconclusive we still try — a
          // real Windows box answers fsutil, a POSIX box yields no letters and
          // falls through to the normal root listing.
          if (canon === '/' || raw === '' || raw === '/') {
            if (win || b.pool.platform !== 'posix') {
              const drives = await listRemoteDrives(b.pool)
              if (drives.length) return sendJson(res, 200, { path: '', platform: 'windows', items: drives })
            }
            if (win) return sendJson(res, 200, { path: '', platform: 'windows', items: [] })
          }
          const out = await listDirStructured(b.pool, canon)
          const items = out.items.map((it) => ({
            ...it,
            // full display-form path so the client never joins paths itself
            path: toDisplayPath(joinRemotePath(canon, it.name), b.pool.platform),
          }))
          return sendJson(res, 200, { path: toDisplayPath(out.path, b.pool.platform), platform: win ? 'windows' : 'posix', items })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Read a remote file over SFTP (live). Text returns as content (CRLF→LF,
      // encoding-aware), binary is reported with size+head (base64). A stat
      // happens first; oversized files are previewed from a streamed head chunk
      // instead of being fully buffered.
      kind: 'exact',
      path: '/dsh-remote/read',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let p = q.get('path') ? decodeURIComponent(q.get('path')) : ''
          let encoding = ''
          let maxBytes = 256 * 1024
          // ?sessionId= (GET) or body.sessionId (POST); omitted → __global__.
          let id = contextIdOf(q.get('sessionId'))
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}')
            if (!p) p = String(body.path || '')
            if (body.encoding) encoding = String(body.encoding)
            if (body.maxBytes) maxBytes = Number(body.maxBytes)
            if (body.sessionId) id = contextIdOf(String(body.sessionId))
          }
          if (q.get('maxBytes')) maxBytes = Number(q.get('maxBytes'))
          if (!p) return sendJson(res, 400, { ok: false, error: 'path is required' })
          const target = normalizeRemotePath(p)
          maxBytes = Math.min(Math.max(Number(maxBytes) || 256 * 1024, 1024), 2 * 1024 * 1024)
          const b = await requireBound(id)
          let sftp
          try {
            sftp = await b.pool.sftp()
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'sftp unavailable: ' + ((err && err.message) || err) })
          }
          let st
          try { st = await sftp.stat(target) } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
          }
          if (st.size > maxBytes) {
            // Head preview for oversized files: fastGet to a temp file, read the
            // first maxBytes, delete the temp. Never buffers the whole file.
            const tmp = path.join(dshBase(), '.dsh-remote-preview-' + process.pid)
            try {
              await sftp.fastGet(target, tmp)
              const { open } = await import('node:fs/promises')
              const fd = await open(tmp, 'r')
              const head = Buffer.alloc(Math.min(maxBytes, st.size))
              await fd.read(head, 0, head.length, 0)
              await fd.close()
              try { unlinkSync(tmp) } catch {}
              const content = decodeBuf(head, encoding || config.encoding).replace(/\r\n/g, '\n')
              return sendJson(res, 200, { ok: true, binary: false, content, truncated: true, size: st.size })
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
            }
          }
          let buf
          try {
            buf = await sftp.readFile(target)
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
          }
          const headN = Math.min(buf.length, 8192)
          let binary = false
          for (let i = 0; i < headN; i++) {
            if (buf[i] === 0) { binary = true; break }
          }
          if (binary) {
            return sendJson(res, 200, { ok: true, binary: true, size: buf.length, head: buf.slice(0, Math.min(buf.length, 4096)).toString('base64') })
          }
          let content = decodeBuf(buf, encoding || config.encoding).replace(/\r\n/g, '\n')
          const truncated = content.length > maxBytes
          if (truncated) content = content.slice(0, maxBytes) + `\n…[truncated: ${buf.length - maxBytes} more bytes]`
          return sendJson(res, 200, { ok: true, binary: false, content, truncated })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Write a remote file (sidebar editor save). `expectedMtime` is an
      // optimistic lock: a 409 is returned when the remote changed meanwhile.
      kind: 'exact',
      path: '/dsh-remote/write',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          // body.sessionId → that session's context; omitted → __global__.
          const id = contextIdOf(body.sessionId)
          const b = await requireBound(id)
          const p = normalizeRemotePath(String(body.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path is required' })
          const sftp = await b.pool.sftp()
          let st = null
          try { st = await sftp.stat(p) } catch { /* new file */ }
          if (body.expectedMtime != null && st && st.mtime !== Number(body.expectedMtime)) {
            return sendJson(res, 409, { ok: false, error: `远端文件已变化（mtime ${st.mtime} ≠ ${body.expectedMtime}），已放弃保存——请重新读取后再编辑` })
          }
          const buf = encodeText(String(body.content ?? ''), body.encoding || config.encoding)
          if (!st) await mkdirRemoteDirs(sftp, remoteDirname(p))
          await sftp.writeFile(p, buf)
          audit(id, 'write', `write ${p}`, 0, b.machine)
          const st2 = await sftp.stat(p).catch(() => null)
          return sendJson(res, 200, { ok: true, bytes: buf.byteLength, mtime: st2 ? st2.mtime : Math.floor(Date.now() / 1000) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Generic remote fs ops used by the sidebar context menu + picker:
      // mkdir / rename / remove (recursive) / write / append.
      kind: 'exact',
      path: '/dsh-remote/fs',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const op = String(body.op || '')
          // body.sessionId → that session's context; omitted → __global__.
          const id = contextIdOf(body.sessionId)
          const b = await requireBound(id)
          const sftp = await b.pool.sftp()
          if (op === 'mkdir') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            await mkdirRemoteDirs(sftp, p)
            audit(id, 'mkdir', `mkdir ${p}`, 0, b.machine)
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'rename') {
            const p = normalizeRemotePath(String(body.path || ''))
            const d = normalizeRemotePath(String(body.dest || ''))
            if (!p || !d) return sendJson(res, 400, { ok: false, error: 'path and dest required' })
            await sftp.rename(p, d)
            audit(id, 'move', `move ${p} → ${d}`, 0, b.machine)
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'remove') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            const st = await sftp.stat(p).catch(() => null)
            if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
            if (st.isDirectory && st.isDirectory()) {
              await removeRemoteTree(sftp, p)
            } else {
              await sftp.unlink(p)
            }
            audit(id, 'remove', `remove ${p}`, 0, b.machine)
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'write' || op === 'append') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            let content = ''
            if (op === 'append') {
              try { content = decodeBuf(await sftp.readFile(p), body.encoding || config.encoding) } catch { /* new */ }
            }
            const buf = encodeText(content + String(body.content ?? ''), body.encoding || config.encoding)
            if (op === 'write' && !(await sftp.stat(p).catch(() => null))) await mkdirRemoteDirs(sftp, remoteDirname(p))
            await sftp.writeFile(p, buf)
            audit(id, op, `${op} ${p}`, 0, b.machine)
            return sendJson(res, 200, { ok: true, bytes: buf.byteLength })
          }
          if (op === 'download') {
            // Download a remote file into THIS context's workspace mirror.
            const p = normalizeRemotePath(String(body.path || ''))
            const ws = b.workspace
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            if (!ws) return sendJson(res, 400, { ok: false, error: 'no remote workspace set' })
            const st = await sftp.stat(p).catch(() => null)
            if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
            if (config.maxFileBytes > 0 && st.size > config.maxFileBytes) {
              return sendJson(res, 400, { ok: false, error: `file is ${st.size} bytes (over ${config.maxFileBytes} cap)` })
            }
            const base = mirrorDirFor(ws, b.machine.host, b.machine.username, b.machine.port)
            const rel = p.startsWith(ws) ? p.slice(ws.length).replace(/^\/+/, '') : p.slice(1)
            const local = path.join(base, rel)
            mkdirSync(path.dirname(local), { recursive: true })
            await sftp.fastGet(p, local)
            audit(id, 'download', `download ${p}`, 0, b.machine)
            return sendJson(res, 200, { ok: true, bytes: st.size, local })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown op' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/workspace',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          // body.sessionId → that session's context; omitted → __global__.
          const id = contextIdOf(payload.sessionId)
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { error: 'path must be an absolute directory' })
          const b = await requireBound(id)
          const okDir = await isRemoteDir(b.pool, p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory: ${p}` })
          persistWorkspaceFor(id, p)
          const local = ensureMirror(p, b.machine.host, b.machine.username, b.machine.port)
          startAutoPush(local, id)
          return sendJson(res, 200, { ok: true, workspace: p, localMirror: local, ...status(id) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/mirror',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          // body.sessionId → that session's context; omitted → __global__.
          const id = contextIdOf(payload.sessionId)
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path must be an absolute directory' })
          // A bound context is required (an unbound context is a local session
          // — mirroring it would clobber another session's remote, issue #13).
          const b = await requireBound(id)
          const okDir = await isRemoteDir(b.pool, p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
          const local = ensureMirror(p, b.machine.host, b.machine.username, b.machine.port)
          persistWorkspaceFor(id, p)
          startAutoPush(local, id)
          return sendJson(res, 200, { ok: true, path: p, localMirror: local, ...status(id) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-pick',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          let outcome = null
          let via = 'service'
          const cap = await localPickCapability()
          if (cap && cap.kind === 'native' && typeof cap.pick === 'function') {
            try {
              const pickAbort = new AbortController()
              const p = await Promise.resolve(cap.pick(pickAbort.signal || null))
              pickAbort.abort()
              outcome = (typeof p === 'string' && p) ? { path: p } : { cancelled: true }
            } catch (err) {
              outcome = null
            }
          }
          // Prefer a REAL OS dialog over the browse backend: operators expect
          // an Explorer-style chooser, and the own spawn (PowerShell
          // FolderBrowserDialog / osascript / zenity-kdialog) works even where
          // the host mounted browse — DSH Desktop (Electron) deliberately
          // mounts browse on win32 because the native backend's koffi dialog
          // worker cannot run under Electron, but a plain child process can.
          if (!outcome) {
            via = 'own'
            try {
              outcome = await pickLocalNative()
            } catch (err) {
              // No usable OS dialog (headless host, missing chooser binary):
              // fall back to the host's browse capability — fs-only, works
              // display-less — served as an in-app browser by the client
              // (backed by /dsh-remote/local-list + /dsh-remote/local-mkdir).
              if (cap && cap.kind === 'browse' && typeof cap.list === 'function') {
                return sendJson(res, 200, { ok: true, kind: 'browse', via: 'browse' })
              }
              return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) + ' — 可直接在输入框填本地路径' })
            }
          }
          if (outcome.cancelled) return sendJson(res, 200, { ok: true, cancelled: true, via })
          return sendJson(res, 200, { ok: true, path: outcome.path, via })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.list !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法列出本机目录' })
          const m = (req.url || '').match(/path=([^&]*)/)
          const raw = m ? decodeURIComponent(m[1]) : ''
          // No path → the browse backend lists the host home directory.
          try {
            const out = await Promise.resolve(cap.list(raw ? raw : undefined))
            return sendJson(res, 200, { ok: true, ...out, drives: listLocalDrives() })
          } catch (listErr) {
            return sendJson(res, 400, { ok: false, error: String((listErr && listErr.message) || listErr), code: (listErr && listErr.code) || 'directory-unreadable' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-mkdir',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.createDirectory !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法新建文件夹' })
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = String(payload.path || '')
          const name = String(payload.name || '')
          if (!p.trim() || !name.trim()) return sendJson(res, 400, { ok: false, error: 'path and name required' })
          try {
            const created = await Promise.resolve(cap.createDirectory(p, name))
            return sendJson(res, 200, { ok: true, path: created })
          } catch (mkErr) {
            return sendJson(res, 400, { ok: false, error: String((mkErr && mkErr.message) || mkErr), code: (mkErr && mkErr.code) || 'directory-create-failed' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/machines',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { machines: machines.map(sanitizeMachine), currentId: store.currentId })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const action = body.action || 'add'
            if (action === 'add' || action === 'update') {
              const host = String(body.host || '').trim()
              if (!host) return sendJson(res, 400, { ok: false, error: 'host required' })
              const id = body.id || machineId()
              const i = machineIndex(id)
              const prev = i >= 0 ? machines[i] : null
              const credBackend = body.credentialBackend === 'plain' ? 'plain'
                : (body.encryptPassword ? platformBackend() : (prev && prev.credentialBackend ? prev.credentialBackend : 'plain'))
              const rec = {
                id,
                name: String(body.name || '').trim() || host,
                host,
                port: Number(body.port) || 22,
                username: String(body.username || '').trim() || 'root',
                password: '',
                privateKeyPath: String(body.privateKeyPath || '').trim(),
                passphrase: body.passphrase || '',
                workspace: String(body.workspace || '').trim(),
                hostKeyMode: body.hostKeyMode || '',
                useAgent: !!body.useAgent,
                keyboardInteractive: !!body.keyboardInteractive,
                proxy: body.proxy && body.proxy.host ? {
                  host: String(body.proxy.host),
                  port: Number(body.proxy.port) || 22,
                  username: String(body.proxy.username || '').trim(),
                  password: String(body.proxy.password || ''),
                  privateKeyPath: String(body.proxy.privateKeyPath || '').trim(),
                } : undefined,
                credentialBackend: credBackend,
                recentWorkspaces: prev && prev.recentWorkspaces ? prev.recentWorkspaces : [],
                lastConnectedAt: prev && prev.lastConnectedAt ? prev.lastConnectedAt : null,
                latencyMs: prev && prev.latencyMs ? prev.latencyMs : null,
              }
              if (body.password) {
                if (credBackend !== 'plain') {
                  await saveSecret(id, String(body.password), secretsDir())
                  rec.password = ''
                } else {
                  rec.password = String(body.password)
                }
              } else if (prev && prev.password) {
                rec.password = prev.password
              }
              if (i >= 0) machines[i] = rec; else machines.push(rec)
              // Issue #13: saving a machine must NOT make it the active
              // remote context. `currentId` stays untouched on add/update —
              // only an explicit "设为当前" (or rw_connect) activates one.
              // keepCurrentKey:false leaves the stored `currentId` byte-for-byte
              // alone, so a fresh registry stays "no choice yet" (not an
              // explicit none) and a previously-cleared registry stays cleared.
              saveMachines(machines, store.currentId, false)
              return sendJson(res, 200, { ok: true, machine: sanitizeMachine(rec), machines: machines.map(sanitizeMachine), currentId: store.currentId })
            }
            if (action === 'delete') {
              const i = machineIndex(String(body.id || ''))
              if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
              const m = machines[i]
              if (m.credentialBackend && m.credentialBackend !== 'plain') {
                await deleteSecret(m.id, secretsDir()).catch(() => {})
              }
              machines.splice(i, 1)
              const wasCurrent = store.currentId === m.id
              if (wasCurrent) {
                // Issue #13: deleting the current machine leaves NO active
                // remote context (never auto-promote a sibling — that would
                // make an unrelated machine leak into the session again).
                // The GLOBAL context is unbound + its pool closed; other
                // session contexts are untouched.
                store.currentId = null
                store.explicitNone = true
                saveMachines(machines, null)
                contexts.clearBinding(GLOBAL_CONTEXT_ID)
                contexts.closePool(GLOBAL_CONTEXT_ID)
                releaseContextWatchers(GLOBAL_CONTEXT_ID)
              } else {
                saveMachines(machines, store.currentId)
              }
              return sendJson(res, 200, { ok: true, machines: machines.map(sanitizeMachine), currentId: store.currentId })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/test-connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const probe = new SshPool({
            ...config,
            host: String(body.host || config.host),
            port: Number(body.port) || config.port,
            username: String(body.username || config.username),
            password: String(body.password || ''),
            privateKeyPath: String(body.privateKeyPath || config.privateKeyPath),
            passphrase: String(body.passphrase || ''),
            proxy: body.proxy && body.proxy.host ? {
              host: String(body.proxy.host),
              port: Number(body.proxy.port) || 22,
              username: String(body.proxy.username || ''),
              password: String(body.proxy.password || ''),
              privateKeyPath: String(body.proxy.privateKeyPath || ''),
            } : undefined,
            connectTimeoutMs: Math.min(Math.max(Number(body.connectTimeoutMs) || config.connectTimeoutMs, 2000), 30000),
            commandTimeoutMs: 10000,
          })
          const started = Date.now()
          await probe.connect()
          await probe.exec('true', { timeoutMs: 10000 })
          probe.close()
          const latencyMs = Date.now() - started
          const mi = machines.findIndex((m) => m.host === probe.config.host && m.username === probe.config.username && Number(m.port) === probe.config.port)
          if (mi >= 0) {
            machines[mi].lastConnectedAt = new Date().toISOString()
            machines[mi].latencyMs = latencyMs
            saveMachines(machines, store.currentId)
          }
          return sendJson(res, 200, { ok: true, host: probe.config.host, user: probe.config.username, latencyMs, lastConnectedAt: new Date().toISOString(), platform: probe.platform, shell: probe.shellMode, gitBash: probe.gitBashPath || '' })
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: friendlyMessage(err, { host: body && body.host, port: body && body.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/current',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = String(body.id || '').trim()
          // Issue #13: an empty id is an explicit "active remote = none" —
          // saved machines stay in the registry but nothing is current.
          if (!id) {
            await setCurrent('')
            return sendJson(res, 200, { ok: true, currentId: null, ...status() })
          }
          const okSet = await setCurrent(id)
          if (!okSet) return sendJson(res, 404, { ok: false, error: 'machine not found' })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forget-key',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // The __global__ context's machine (machine-global, settings UI),
        // falling back to the config default when the global context is unbound.
        const gm = contexts.activeMachineOf(GLOBAL_CONTEXT_ID)
        const host = (gm && gm.host) || config.host
        const port = gm ? (Number(gm.port) || 22) : config.port
        createHostKeyGuard({ host: host || '', port, hostKeyMode: config.hostKeyMode }).forgetHost()
        return sendJson(res, 200, { ok: true, ...status() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forwards',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { forwards: forwards.list() })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const action = String(body.action || '')
          if (action === 'define') {
            const d = forwards.define({
              direction: body.direction === 'reverse' ? 'reverse' : 'local',
              listenPort: Number(body.listenPort),
              targetHost: body.targetHost || '127.0.0.1',
              targetPort: Number(body.targetPort) || Number(body.listenPort),
              autoStart: !!body.autoStart,
              machineId: store.currentId,
            })
            return sendJson(res, 200, { ok: true, forward: d, forwards: forwards.list() })
          }
          if (action === 'start' || action === 'stop') {
            const d = forwards.list().find((f) => f.id === body.id)
            if (!d) return sendJson(res, 404, { ok: false, error: 'forward not found' })
            if (action === 'start') {
              // The settings UI manages the GLOBAL context's pool.
              const gpool = await contexts.resolvePool(GLOBAL_CONTEXT_ID)
              if (!gpool) return sendJson(res, 500, { ok: false, error: 'global context is not bound to a machine — connect first' })
              const r = await forwards.start(d, gpool)
              if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
            } else {
              forwards.stop(d.id)
            }
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          if (action === 'remove') {
            forwards.remove(String(body.id || ''))
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown action' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/task',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const id = q.get('id') || ''
          const t = tasks.get(id)
          if (!t) return sendJson(res, 404, { ok: false, error: 'task not found' })
          return sendJson(res, 200, { ok: true, task: t })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const id = String(body.id || '')
            if (body.action === 'cancel') {
              const ok = tasks.cancel(id)
              return sendJson(res, 200, { ok, task: tasks.get(id) })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/tasks',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, tasks: tasks.list() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/audit',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const q = new URL(req.url, 'http://localhost').searchParams
        return sendJson(res, 200, { ok: true, auditEnabled: !!config.auditLog, file: auditFile(), lines: readAudit(q.get('limit')) })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ssh-config',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const text = readSshConfigText()
          return sendJson(res, 200, { ok: true, file: sshConfigPath(), present: !!text, entries: importableEntries(text) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/home',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          // body.sessionId → that session's context; omitted → __global__.
          const id = contextIdOf(payload.sessionId)
          const b = await requireBound(id)
          const out = await b.pool.exec('echo ~', { timeoutMs: Math.min(config.commandTimeoutMs, 5000) })
          const home = String(out.stdout || '').replace(/\s+/g, '').trim()
          if (!home) return sendJson(res, 200, { ok: true, home: null, hint: 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径' })
          return sendJson(res, 200, { ok: true, home })
        } catch (err) {
          return sendJson(res, 200, { ok: true, home: null, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-check',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const current = readVersion()
        const latest = await fetchLatestVersion()
        if (latest === null) return sendJson(res, 200, { ok: false, current, error: '无法连接 npm registry' })
        const rawMode = readUpdateMode() || config.updateMode || 'manual'
        return sendJson(res, 200, {
          ok: true,
          current,
          latest,
          updateAvailable: gtVersion(latest, current),
          updateMode: ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : 'manual',
          updatedMarker: existsSync(path.join(selfDir(), '.dsh-remote-updated')),
        })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const target = String(body.version || '')
          if (!target) return sendJson(res, 400, { ok: false, error: 'version is required' })
          const result = await applyUpdate(target)
          return sendJson(res, 200, { ok: true, from: readVersion(), ...result })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-mode',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const mode = String(body.mode || '')
          if (!['manual', 'auto', 'off'].includes(mode)) return sendJson(res, 400, { ok: false, error: 'mode must be manual | auto | off' })
          if (!persistUpdateMode(mode)) return sendJson(res, 500, { ok: false, error: 'cannot persist mode' })
          return sendJson(res, 200, { ok: true, mode })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]

  const disposers = routes.map((r) => webServer.register(r))
  ctx.effect(() => () => disposers.forEach((d) => d && d()), 'dsh-remote.routes')

  // ── auto-update: check on load + on an interval; apply silently ───────────
  // Failures are swallowed (never break the plugin). The persisted override
  // (settings UI) wins over the profile-config default.
  const rawMode = readUpdateMode() || config.updateMode || 'manual'
  const effectiveUpdateMode = ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : 'manual'
  if (effectiveUpdateMode === 'auto') {
    const currentVersion = readVersion()
    const checkAndApply = async () => {
      const latest = await fetchLatestVersion()
      if (latest && gtVersion(latest, currentVersion)) {
        try { await applyUpdate(latest) } catch {}
      }
    }
    void checkAndApply()
    const updateTimer = setInterval(checkAndApply, Math.max(config.updateCheckIntervalMs, 60000))
    if (typeof updateTimer.unref === 'function') updateTimer.unref()
    ctx.effect(() => () => clearInterval(updateTimer), 'dsh-remote.update-timer')
  }
}
