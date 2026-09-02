# Per-Session / Per-Agent-Thread Remote Context — Design Contract

- **Repo:** `D:\Devel\app_wb\dsh-remote`
- **Branch:** `feat/per-session-remote-context` (base `v0.8.10`, head `0b43552`)
- **Status:** LOCKED — this document is the single design contract the team implements
  against. Implementation members build to this spec; reviewers judge implementations
  against it; the test matrix in §6 is the contract for the test engineer.
- **Deliverable scope of the requirements task:** this file only. No code changes here.
- **DSH host used for assumption verification (read-only):**
  `D:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\`
  (all cited `@deepseek-ai/*` packages at version `0.1.2-alpha.1`).

---

## 0. Problem statement

Today `dsh-remote` keeps **one machine-global remote context**: a single `SshPool`,
one `config.host/workspace`, one `store.currentId` (issue #13: "saved machines are
standby, never an implicit active context" — partially fixed). Consequences that this
change removes:

1. Two concurrent DSH sessions (or a session and its sub-agents) share one SSH pool and
   one workspace — one agent's `rw_connect`/`rw_pick_workspace` clobbers the other's.
2. A sub-agent (spawned with a fresh session) inherits the parent's remote context via
   the shared global pool, violating the requirement that agent threads carry their own
   remote context and sub-agents start clean.
3. Restarting the harness loses which session was working on which machine.

**Target:** the active remote context is **per agent thread** (per session id). A new
agent thread starts **UNBOUND** (local, no remote). Binding is explicit
(`rw_connect` / `POST /dsh-remote/connect`). Each context has its own SSH pool,
workspace, forwards activation and audit identity. The machine **registry**
(`machines.json`) stays global; **mirrors** stay global/shared per remote path;
**known-hosts TOFU** stays global.

The DSH runtime makes this possible without any host change: tool execution carries the
calling agent (`exec.agent`), `agent.id === session.id`, sub-agents get their own fresh
session id, and system-prompt section text is evaluated synchronously with
`context.agent` present. All four are verified against the host checkout in §1.

---

## 1. DSH runtime assumptions — VERIFIED against the host checkout

Base path for all citations: `D:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\`
(abbreviated below as `@deepseek-ai/`). Package versions: `0.1.2-alpha.1`.
Line numbers verified by direct file read on this checkout.

### 1.1 Tool dispatch passes the caller agent — VERIFIED

**Claim:** the tool registry dispatches `tool.execute(exec.arguments, exec)` where `exec`
contains the calling `agent` for normal agent turns.

Evidence chain:

1. The agent loop schedules every assistant-step tool call with the initiating agent:
   `@deepseek-ai/dsh-agent-loop/lib/index.js:117-129`
   ```js
   async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
     const agent = ctx.agents.requireInitiator();          // line 118
     const { session } = agent;
     const planned = toolCalls.map((block) => ({
       block,
       exec: {
         callId: block.id,
         name: block.name,
         arguments: parseArguments(block.arguments),
         agent,                                            // line 126
         signal
       }
     }));
   ```
   Doc comment at lines 107-108: "The committed step's AgentLoop driver boundary supplies
   the initiating Agent that becomes each explicit `ToolExecutionInput.agent`."
2. The tool registry mints the execution object carrying `agent`:
   `@deepseek-ai/dsh-tools/lib/index.js:3034` — `createExecution(exec)`. The base object
   is built at lines 3046-3060:
   ```js
   const base = {
     token, callId, rootCallId, name, signal,
     ...agent !== void 0 ? { agent } : {},                 // line 3052
     ...parent !== void 0 ? { parent } : {},               // line 3053
     deferContext(...) { ... }, concludeTurn() { ... }
   };
   ```
   and at lines 3066-3069 `execution = { ...base, arguments: deepFreeze(detached) }` —
   i.e. `exec = { token, callId, rootCallId, name, signal, agent?, parent?, arguments, … }`.
3. Dispatch invokes the registered body with `(arguments, exec)`:
   `@deepseek-ai/dsh-tools/lib/index.js:3185-3201` — `dispatchToolBody(exec)` ends in
   `const returned = await tool.execute(exec.arguments, exec);` (line 3201).
4. `defineTool` forwards both arguments to the plugin:
   `@deepseek-ai/dsh-tools/lib/index.js:837-868` — the wrapper `async execute(args, exec)
   { ...; return userExecute(args, exec); }` (line 866).

**Conclusion:** for every normal agent turn, a plugin tool's `execute(args, exec)`
receives `exec.agent` = the calling Agent instance. For agentless call paths
(non-agent callers) `exec.agent` may be absent — the plugin must degrade to the
`__global__` context (see §2.3).

### 1.2 Agent id === session id — VERIFIED

**Claim:** `agent.id` is always equal to `agent.session.id`, so the agent id can be used
as the stable, persistent per-session context key.

Evidence: `@deepseek-ai/dsh-agent/lib/index.js:602-605` — `AgentRegistry.enter()`:
```js
enter(agent, owner) {
  const id = agent.id;
  if (id !== agent.session.id) throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`);
  const carrier = scopeTarget(agent, agent);
```
The invariant is enforced at registration; any live agent in the registry satisfies
`agent.id === agent.session.id`. (The registry keys its store by this shared id —
see `store.get(id)` lookups at lines 685-690, "the shared agent/session id".)

### 1.3 Sub-agents get their OWN session/agent (no runtime-state inheritance) — VERIFIED

**Claim:** a spawned (or forked) sub-agent runs as a fresh child Agent with its own
session id — it cannot see the parent's remote context, which is keyed by session id.

Evidence:

1. Spawn backend doc: `@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js:6-7` —
   "…runs each child as a fresh child Agent on the same cordis context (its own session,
   own system prompt, zero parent context)"; and line 30: `inheritsParentContext = false`.
2. Shared in-process driver mints a fresh session id for every child:
   `@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:166` —
   `const childId = SessionId(randomUUID());` and lines 180-181 —
   `parent.ctx.agents.create({ sessionId: childId, ... })`. By §1.2 the child agent's id
   therefore equals this fresh `childId`, never the parent's.
3. Fork backend: `@deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:5-9` — the fork
   child is "SEEDED with a prefix of the parent's session log — so the child inherits
   the parent's **conversation** context instead of starting fresh" (seed = completed
   turn prefix, lines 23-28, passed at lines 48-51). It still goes through
   `startInProcessRun` (driver line 166) → **fresh random session id**. Line 44
   `inheritsParentContext = true` refers to the conversation seed only.

**Conclusion:** both spawn and fork sub-agents have a fresh session id (and hence a fresh
context key). Whatever dsh-remote stores under the parent's session id is invisible to
the child. A forked child's *conversation* mentions the parent's remote work, but it
holds no live pool and no binding — exactly the isolation required.

### 1.4 System-prompt assembly carries `context.agent` — VERIFIED

**Claim:** a `ctx.systemPrompt.section({ text })` callback is invoked **synchronously**
with an assembly context that includes `agent` (and `agent.session.header.cwd`), so a
section can resolve its context by `context.agent.id`.

Evidence:

1. Context builder: `@deepseek-ai/dsh-agent/lib/index.js:384-390` —
   ```js
   function assembleContextFor(agent, signal) {
     return {
       agent,
       scope: agent,
       ...signal === void 0 ? {} : { signal }
     };
   }
   ```
2. The loop driver assembles per step with itself as the agent:
   `@deepseek-ai/dsh-agent-loop/lib/index.js:499` (inside `ReactLoopAgent.preStep`) —
   `const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));`
3. Section text is evaluated with that context, synchronously inside the assembly:
   `@deepseek-ai/dsh-system-prompt/lib/index.js:288-331` — `assemble(context = {})`;
   line 319: `text: typeof section.text === "function" ? section.text(context) : section.text`
   (plain synchronous call within the `sections` map; the surrounding `assemble` is async
   only for the later `system-prompt/assemble` waterfall at line 331).
4. `context.agent.session.header.cwd` is a live, documented field — the loop registers
   prompt variables off it at `@deepseek-ai/dsh-agent-loop/lib/index.js:1037-1039`:
   ```js
   ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
   ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
   ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd);
   ```

**Conclusion:** the `dsh-remote` prompt section may synchronously compute
`context.agent.id` as its context key, read `context.agent.session.header.cwd` for the
legacy cwd→mirror fallback, and read the context's binding from the ContextStore.

### 1.5 Compatibility note

All four assumptions hold on the installed desktop host (0.1.2-alpha.1) and match the
plugin's peer range `^0.1.0-rc.6` + `@deepseek-ai/cordis ^4.0.1`. The plugin must still
defend against a missing `exec.agent` (§2.3 fallback) because the registry tolerates
agentless executions in general.

---

## 2. Context model

### 2.1 Context key

- **Context id** = the caller agent's id = its session id (§1.1 + §1.2).
  Derivation inside a tool: `exec?.agent?.id ?? exec?.agent?.session?.id` (§1.2 makes the
  two equal whenever `agent` is present; the `session.id` read is belt-and-braces).
- **Sanitization:** the id is passed through the existing `encodeSegmentSafe()` rule
  (`lib/index.js:136-139`: replace `[^A-Za-z0-9._-]` with `_`, empty → `'session'`)
  before use as a store key or audit segment. Real session ids are UUIDs (unchanged by
  the rule); the rule exists so exotic ids can never inject path separators into
  `contexts.json` keys or audit lines.
- **Reserved key `'__global__'`:** used by every caller that has no agent — web routes
  without `sessionId`, slash commands, settings-UI actions, startup bootstrap.
  `'__global__'` already satisfies the sanitize rule.

### 2.2 Binding rules (normative)

1. **New agent threads start UNBOUND.** A context with no entry (neither in-memory nor
   in `contexts.json`) has `machineId: null`, `workspace: ''`, no pool. It never
   inherits `store.currentId`, the config-default host, or any parent's binding
   (issue #13 philosophy extended from the machine registry to contexts).
2. **Ephemeral bindings are never persisted.** A context bound via
   `rw_connect(..., save: false)` or via an explicit-host web `/connect` (no `machineId`)
   holds its machine record **in memory only**. `contexts.json` is not created or
   updated for it. Ephemeral credentials are never written anywhere. If the process
   restarts, or the context's pool is evicted (§4.3), the ephemeral binding is gone and
   the context reports unbound.
3. **Persisted bindings reference registry machines.** A context bound via
   `rw_connect(..., save: true)` (default) or a web `/connect` carrying `machineId`
   persists `{ machineId, workspace }` in `contexts.json`. `machineId` is a reference
   into the (global) `machines.json` registry; credentials live only in the registry /
   keychain and are resolved at connect time.
4. **`__global__` keeps legacy behavior:** config-default bootstrap when the registry has
   no explicit choice (`lib/index.js:912-916`), the registry `currentId` as its binding
   source, and the startup auto-restore probe (`lib/index.js:924-937`). Everything else
   (pool, LRU, idle eviction, forwards, audit segment) treats it like any context.
5. **Unbound ≠ broken.** An unbound context's tools fail with an actionable error
   ("no remote context for this session — call rw_connect first"); they never silently
   fall back to the global pool.

### 2.3 Context resolution (single helper, normative)

```js
// inside apply(), available to every tool and every web route
function resolveContext(execOrSessionId) {
  // returns { id, entry, pool, machine, workspace, ephemeral }
  //   id:        sanitized context id, or '__global__'
  //   entry:     { machineId, workspace } from live store (memory ∪ disk) or null
  //   pool:      the context's live SshPool (lazy; materialized from disk when a
  //              persisted entry exists and no pool is live — §4.3)
  //   machine:   resolved machine record (registry lookup + keychain password via
  //              machinePassword()) or null
  //   workspace: effective workspace (entry.workspace || '')
}
```

Resolution order for the id: `exec?.agent?.id` → `exec?.agent?.session?.id` → `'__global__'`.
For web routes: `sessionId` (query for GET, `body.sessionId` for POST) → `'__global__'`.
For the prompt section: `promptContext.agent?.id` → no agent → return `''` (stay silent).

### 2.4 Per-context state

```
{
  machineId: string | null,   // registry machine reference, or null when unbound/ephemeral
  workspace: string,          // '' until rw_pick_workspace / mirror / workspace route
  // in-memory only:
  ephemeralMachine: object | null,  // full machine record for save:false / explicit-host binds
  pool: SshPool | null,             // lazy per-context pool (§4)
  lastUsed: number,                 // ms epoch, LRU + idle bookkeeping
}
```

The **machine registry** (`machines.json`, `store.currentId`, `explicitNone`) and the
**mirror directories** (`remoteWorkspacesRoot()/<host-tag>/<mirror>`,
`mirrorDirFor()` / `ensureMirror()`, unchanged) stay global. Two contexts on the same
remote path share the same mirror dir (three-way sync state is per remote path, not per
context).

---

## 3. Persistence — `contexts.json`

- **Location:** `path.join(remoteWorkspacesRoot(), 'contexts.json')` — the same root as
  `machines.json` (`lib/index.js:130-132`, `:233-234`). Root honors `DSH_HOME`
  (`dshBase()`, `lib/index.js:123-127`), which is what makes isolated test homes work.
- **Shape (exact):**
  ```json
  {
    "version": 1,
    "contexts": {
      "<sanitizedContextId>": { "machineId": "m-…", "workspace": "/abs/path", "updatedAt": "2025-…Z" }
    }
  }
  ```
- **What is persisted:** `machineId` (a reference to a registry machine) + `workspace`
  (+ `updatedAt`, ISO-8601) only. **Never** host credentials, ephemeral machine records,
  or forward state.
- **Atomic write:** write `contexts.json.tmp` in the same directory, then
  `renameSync` over `contexts.json` (mkdir -p first). A crashed write can never leave a
  torn file.
- **Corrupt / unreadable / wrong-shape file:** fall back to `{ version: 1, contexts: {} }`
  in memory (log a warn via `ctx.logger` if present); the next save atomically replaces
  the corrupt file. Mirrors the existing tolerant loaders (`loadMachines`,
  `loadKnownHosts`).
- **Stale reference:** if a persisted `machineId` no longer exists in the registry at
  materialization time, the entry is dropped (atomic save) and the context reports
  unbound with error text `binding machine <id> no longer exists in registry — call
  rw_connect again`.
- **Session continuity:** session ids survive harness restarts (resumed sessions keep
  their id), so bindings persist meaningfully across restarts. Spawned/forked sub-agent
  ids are fresh random UUIDs (§1.3) and never collide with or inherit parent entries.

---

## 4. Pools — one `SshPool` per live context

### 4.1 Injectable pool factory (test hook, normative signature)

`apply(ctx, config, options = {})` gains a third parameter:

```js
export async function apply(ctx, config, { poolFactory } = {})
// poolFactory: (config) => SshPool-like. Default: (config) => new SshPool(config)
```

Every context pool — including `__global__` — is created through the factory, so tests
can substitute a fake pool that records `setTarget/connect/exec/sftp/close` calls and
needs no network. The `SshPool` surface a factory must provide (unchanged class,
`lib/index.js:306-792`): `config`, `setTarget()`, `connect()`, `exec()`, `sftp()`,
`detect()`, `invalidate()`, `close()`, `client`, `platform`, `gitBashPath`, `shellMode`,
and the `passwordResolver` / `onReady` / `onCloseHook` hooks.

### 4.2 Laziness and materialization

- A context gets a pool **lazily** on first use (tool call, web route op, or forward
  start). Unbound contexts never create a pool.
- **Re-materialization:** when a context has a persisted entry but no live pool
  (after restart or eviction), the next use rebuilds it: resolve `machineId` in the
  registry → resolve password via `machinePassword()` (plain or keychain,
  `lib/index.js:833-840`) → `poolFactory(...)` + `setTarget(machine + password)` →
  `workspace` from the entry. No write-back to `contexts.json` on read.
- The `__global__` context additionally materializes from legacy sources exactly as
  today: registry `currentId` (its binding), config-default bootstrap when the registry
  has no explicit choice, and the startup auto-restore probe.

### 4.3 LRU cap + idle timeout (normative)

New config keys (added to the `Config` schema, `lib/index.js:56-117`):

| key | type | default | meaning |
|---|---|---|---|
| `maxRemoteContexts` | integer ≥ 1 | `8` | max simultaneously **live** pools (including `__global__`) |
| `remoteContextIdleMs` | integer ≥ 0 | `1800000` (30 min) | idle eviction threshold; `0` disables idle eviction |

- **LRU:** `lastUsed` is bumped on every context use (pool `exec`/`sftp`/`connect`,
  workspace pick, forward start). When materializing a new live context would exceed
  `maxRemoteContexts`, the live context with the **oldest `lastUsed`** (other than the
  one being materialized) is evicted.
- **Idle:** a `setInterval` checker (every 60 s; **`unref()`'d** so it never holds the
  process open; registered as a `ctx.effect` disposer) evicts live contexts with
  `now - lastUsed > remoteContextIdleMs` when `remoteContextIdleMs > 0`.
- **Eviction does:** close the pool (which stops that pool's forwards via the
  `onCloseHook` → `forwards.detach` wiring, §5), clear **that context's** auto-push
  watchers, and drop the live entry. **Eviction does NOT** touch `contexts.json` —
  the persisted binding survives and is re-materialized on next use (§4.2). An
  ephemeral (in-memory-only) binding is lost on eviction, per §2.2(2).

### 4.4 Global-context legacy behavior preserved

The `__global__` context continues to: adopt the config-default host when the registry
has no explicit choice; follow `store.currentId` (set via `POST /current`,
`rw_connect save:true` without an agent caller, or legacy `applyActiveMachine()`); and
run the startup auto-restore probe (best-effort `pool.exec('echo dsh-remote-restore')`).
It is otherwise a normal context under the LRU/idle rules.

---

## 5. Forwarding — multi-pool `ForwardManager`

- **`forwards.json` stays GLOBAL** (one file, `lib/index.js:236`; shape
  `{ defs: [...] }` unchanged, `lib/forwards.js:31-46`). Definitions keep their
  `machineId` field (`lib/forwards.js:92-105`).
- **Refactor:** `ForwardManager` no longer owns one pool (`lib/forwards.js:18-29` today
  stores a single `this.pool`/`this.client`). New contract:
  ```js
  const forwards = new ForwardManager({ file: forwardsFile() })
  forwards.start(def, pool)      // start on an explicit pool; server entry remembers pool+client
  forwards.attach(client, pool)  // called from pool.onReady(client)
  forwards.detach(client)        // called from pool.onCloseHook(); stops only that pool's servers
  ```
  - `servers` map entries gain `pool` (and keep `client`):
    `{ kind, server?, sockets, client, pool }`.
  - `start(def, pool)`: `client = await pool.connect()`; the local server /
    `forwardIn` reverse listen is created on **that** client (today's
    `_startLocal`/`_startReverse`, `lib/forwards.js:135-170`, take `client` already —
    only the single-pool assumption around them changes).
  - `attach(client, pool)`: registers the per-client `tcpip`/`close` listeners
    (today's `attach`, `lib/forwards.js:49-61`), then auto-starts **only** defs with
    `autoStart && direction === 'local' && !servers.has(def.id)` **and**
    `def.machineId == null || def.machineId === pool's bound machineId`
    (a `null` machineId matches any pool).
  - `detach(client)`: stops only the server entries whose `client` is that pool's
    client; removes that client's listeners. Other pools' forwards keep running.
  - `list()` unchanged (global defs + `active` = any live server).
  - The reverse `tcpip` handler is registered per client, so reverse tunnels already
    route to the right local target; it must use the **entry's** def/pool, not globals.
- **Pool wiring in `apply()`** (replaces `lib/index.js:987-989`): each context pool gets
  `pool.onReady = (client) => forwards.attach(client, pool)` and
  `pool.onCloseHook = () => forwards.detach(pool's live client)`.

---

## 6. Tools — the `(args, exec)` contract

### 6.1 Normative resolution

Every `rw_*` tool changes its body from `async execute(args)` to
`async execute(args, exec)` (the registry already passes `exec`, §1.1) and starts by
resolving its context via §2.3. All pool/workspace references in the tool bodies
(`pool`, `wsPath()`, `config.host` used as "the" host, `persistWorkspace()`,
`audit()`) become **context-scoped**. Tool names, parameter schemas (beyond the
additions below) and output shapes stay unchanged; `check.mjs` gates
(tool name `^rw_[a-z][a-z0-9_]*$`, route prefix `/dsh-remote/`, object-param
`additionalProperties`) continue to apply.

### 6.2 Per-tool behavior

| tool | change |
|---|---|
| `rw_info` | Reports the **calling context**: `contextId`, bound machine (user@host:port) or `unbound`, `workspace`, `localMirror`, `connected` (this context's pool), active forwards of this pool, host-key state for this context's host. Unbound → explains how to bind (`rw_connect`). |
| `rw_connect` | Gains optional param `machineId` (string). Resolution: `machineId` given → machine from registry (host/port/username resolved; password via `machinePassword()` incl. keychain) — `host` no longer required in that case; else explicit `host` as today. **Binds the CALLING context:** `save !== false` (default true) → upsert registry (existing logic, `lib/index.js:1333-1348`) **and** persist `{ machineId, workspace }` for the context (workspace = existing context workspace or the machine's stored workspace, else `''`); `save: false` → ephemeral in-memory bind on the context (never persisted, §2.2(2)). Connects the context's pool and pings (`echo ok`) as today. |
| `rw_pick_workspace` | Sets the **calling context's** workspace (verified dir via the context pool); `ensureMirror` + `startAutoPush` unchanged (mirrors stay global per remote path, §2.4); persists the context entry when the binding is persistent (§2.2(3)), memory-only when ephemeral. |
| `rw_sync` / `rw_push` / `rw_download` / `rw_upload` | Use the calling context's pool + workspace. Mirror dir resolution (`mirrorDirFor`) unchanged (global). `rw_download`'s default local target = the **context's** workspace mirror. |
| `rw_list_dir` / `rw_stat` / `rw_read_file` / `rw_write_file` / `rw_edit` / `rw_append` / `rw_mkdir` / `rw_remove` / `rw_move` / `rw_exec` / `rw_search` | Use the calling context's pool. Default paths resolve against the calling context's workspace (today's `wsPath()`). Unbound context → error `no remote context for this session — call rw_connect first` (never the global pool, §2.2(5)). |
| `rw_forward` | Defines + starts on the calling context's pool: `forwards.define({ …, machineId: <context's bound machineId or null> })` (replaces today's `store.currentId`, `lib/index.js:1935`), then `forwards.start(d, pool)`. |
| `rw_disconnect` | Closes **only the calling context's** pool (forwards of that pool stop via §5; that context's auto-push watchers clear). Does not touch the registry, `store.currentId`, or any other context. |

### 6.3 Tool descriptions (normative wording change)

Every `rw_*` description gains the sentence: **"Remote context is per-session (per
agent thread): each agent thread has its own machine + workspace; sub-agents start with
no remote context."** `rw_connect` additionally: "Binds the machine to this session.
`save: false` keeps the binding ephemeral (this process only, never persisted)."
`rw_disconnect` additionally: "Closes only this session's connection; other sessions'
contexts are unaffected."

### 6.4 Slash commands

`/remote`, `/remote-forget-key`, `/remote-ignore` (registered at
`lib/index.js:1992-2032`) are operator/settings-level and report/act on the
`__global__` context (legacy behavior). No per-session slash command is added in this
change.

---

## 7. Web routes — `sessionId` scoping

### 7.1 Scoped routes (normative list)

`sessionId` is an **optional** scope: `?sessionId=<id>` for GET, `body.sessionId` for
POST. **Absent ⇒ `__global__` context (exactly today's behavior).** When present, the
route operates on that context (resolving/materializing its pool per §4.2).

| route | scoped behavior |
|---|---|
| `GET /dsh-remote/status?sessionId=` | Context status (§7.3 response shape). |
| `POST /dsh-remote/connect` | Body may carry `sessionId` **and** `machineId` (resolves the machine — incl. keychain password — from the registry instead of explicit `host`/`password`), `workspace`, or legacy explicit fields (`host`, `username`, `port`, `password`, `privateKeyPath`). With `machineId` → persisted binding on the context; with explicit host → ephemeral binding. `action: "disconnect"` → close the context's pool (only means of web disconnect). Returns the context status. |
| `GET /dsh-remote/ls?sessionId=` | Lists on the context's pool (default path = context workspace; Windows drive view as today). |
| `GET\|POST /dsh-remote/read` | Reads via the context's SFTP. |
| `POST /dsh-remote/write` | Writes via the context's SFTP (`expectedMtime` lock unchanged). |
| `POST /dsh-remote/fs` | All ops (`mkdir`/`rename`/`remove`/`write`/`append`/`download`) on the context's pool; `download` targets the context's workspace mirror. |
| `POST /dsh-remote/workspace` | Sets the context's workspace (verified dir), persists per §2.2 rules, `ensureMirror` + `startAutoPush` as today. |
| `POST /dsh-remote/mirror` | `ensureMirror` (global mirror dir) + set context workspace; returns `localMirror` + context status. |
| `POST /dsh-remote/home` | `echo ~` on the context's pool. |

### 7.2 Unchanged (machine-global, settings UI)

`/machines`, `/current`, `/test-connect`, `/forget-key`, `/forwards`, `/task`, `/tasks`,
`/audit`, `/ssh-config`, `/local-pick`, `/local-list`, `/local-mkdir`, `/resolve-mirror`,
`/update-check`, `/update-apply`, `/update-mode` — untouched. `/forwards` GET still
lists the global defs (now with multi-pool `active` semantics, §5); define/start/stop
from the settings UI targets the `__global__` context's pool (its `machineId` =
`store.currentId`, as today).

### 7.3 Per-context `/status` response shape (normative)

```json
{
  "ok": true,
  "contextId": "<sanitized id or __global__>",
  "machineId": "m-… | null",
  "host": "127.0.0.1", "port": 12922, "username": "user",
  "connected": true,
  "workspace": "/tmp",
  "localMirror": "<mirror dir or ''>",
  "activeSource": "context | ephemeral | config | none",
  "sessionMode": "remote | local",
  "sessionRemotePath": "<mirror-mapped path or ''>",
  "forwards": [ /* global defs with active flags */ ],
  "hostKeyMode": "accept-new", "hostKeyKnown": true,
  "currentId": "<registry currentId or null>",
  "machines": [ /* sanitized registry list */ ],
  "auditEnabled": true, "platform": "posix|windows|unknown",
  "shell": "native|git-bash", "gitBash": ""
}
```

- Machine-bound fields (`host/port/username/connected/workspace/localMirror/
  activeSource/hostKeyKnown`) describe **the requested context**; registry fields
  (`machines/currentId`) stay global.
- `activeSource`: `context` = persisted binding live; `ephemeral` = in-memory binding
  live; `config` = `__global__` bootstrap from config default; `none` = unbound.
- `sessionMode`: `remote` when the context is bound to a machine **or** the session's
  cwd maps into a mirror (legacy, `resolveMirrorForLocal`, `lib/index.js:1184-1211`);
  else `local`.
- A fresh, never-connected `sessionId` returns
  `{ machineId: null, host: '', connected: false, workspace: '', activeSource: 'none',
  sessionMode: 'local', … }` — **not** a 404 (the E2E relies on this, §12.5(4)).
- The no-`sessionId` response keeps the exact legacy fields the settings UI already
  consumes (including `activeSource` values `ephemeral|machine|config|none` — for the
  global context `machine` maps to the new `context` value; implementers may keep both
  spellings for backward compatibility, but `context` is normative).

### 7.4 Client wiring (`lib/client.js`)

- The client already has the session id in scope (`props.scope.sessionId`,
  `lib/client.js:1052`) and already sends `sessionId` to `/resolve-mirror`.
- **Contract:** the remote **sidebar / workspace-file UI** (file browser + editor:
  `/ls`, `/read`, `/write`, `/fs`, `/mirror`, `/workspace`, `/home`, and the status
  poll feeding it, `/status`) appends the current session id when present. The
  **settings panel** (machines, forwards, audit, ssh-config, update) stays global and
  sends no `sessionId`.
- `POST /dsh-remote/connect` from the client (when that UI path is used) passes
  `sessionId` + `machineId` (preferred) rather than raw credentials.
- Client changes are additive: when `scope.sessionId` is absent the client must behave
  byte-for-byte as today (global context).

---

## 8. System prompt — the `dsh-remote` section

The section (`lib/index.js:1969-1989`, `name: 'dsh-remote'`, `order: 88`) keeps its
name/order and synchronous `text(promptContext)` signature (§1.4) but resolves its
context by agent id:

1. `contextId = promptContext?.agent?.id` (sanitized). No agent → return `''`.
2. **Primary path — bound context:** if the context (live entry, or `contexts.json`
   entry resolvable in the registry) has `machineId` **and** `workspace` → inject:
   `Current remote workspace: <user>@<host>:<workspace>` using the **context's machine
   record** (not `config.host`), plus the standard rw_* guidance and the **active
   forwards of the context's pool** (when the pool is live). The section must NOT
   trigger a connection — it reads stored state only.
3. **Fallback — legacy mirror cwd:** otherwise, if `context.agent.session.header.cwd`
   maps into a dsh-remote mirror (`resolveMirrorForLocal`, `lib/index.js:1184-1211`) →
   today's text (legacy sessions opened directly in a mirror dir keep working).
4. Otherwise → `''` (plain local session, issue #13: no leak).

Consequence: a spawned sub-agent (fresh id, unbound, cwd = parent's local workspace)
gets **no** remote section; a forked child likewise — its conversation seed may mention
remote work, but the section itself is driven by its own (empty) context + cwd.

---

## 9. Audit

- Every audit line (`lib/index.js:958-964`) gains the **context id segment**, sanitized
  per §2.1. New line format (single spaces around `|` as today):
  `ISO | <contextId> | <user>@<host>:<port> | <op> | <code|-> | <cmd>`
  (today: `ISO | user@host:port | op | code | cmd` — one segment inserted after the
  timestamp).
- Unbound / pre-bind events that carry no machine (e.g. a failed `rw_connect` from an
  unbound context) log the target from the attempt (`user@host:port` of the failed
  attempt) with the calling context id.
- The global context logs as `__global__`. `/dsh-remote/audit` output shape unchanged
  (raw lines); the reader should tolerate both old and new line formats during
  migration.

---

## 10. Non-goals (normative — reviewers must flag scope creep)

1. **`machines.json` registry stays global** — one file, one `currentId`, issue #13
   semantics (`lib/registry.js`) unchanged. Contexts reference machines; they never
   store machine copies.
2. **Known-hosts TOFU stays global** (`known_hosts.json`,
   `lib/index.js:247-302`) — host-key trust is per host:port, not per context.
3. **Mirror dirs stay global/shared** per remote path (`mirrorDirFor`/`ensureMirror`
   unchanged; sync state `.dsh-remote-sync-state.json` remains per mirror dir).
4. **Credentials/keychain unchanged** (`lib/credential.js`); **update system
   unchanged** (`lib/update.js`, routes, timers); **sync/search/paths logic unchanged**
   (`lib/sync.js`, `lib/search.js`, `lib/paths.js`); `lib/sshconfig.js`,
   `lib/hostkey.js`, `lib/ignore.js`, `lib/errors.js`, `lib/tasks.js` unchanged.
5. **No npm version bump** on this branch (`package.json` stays `0.8.10`).
6. No changes to DSH host packages; no new plugin dependencies; no client UI redesign
   (wiring is additive per §7.4).
7. No per-context `forwards.json` (defs stay global, §5); no per-context known-hosts.

---

## 11. Recommended module layout (guidance, not mandatory)

- `lib/contexts.js` (new, pure, unit-testable): ContextStore — load/save
  (atomic + corrupt-fallback), get/set, sanitized-key helpers, LRU/idle bookkeeping,
  ephemeral overlay. Same style as `lib/registry.js` (pure logic + file plumbing).
- `lib/index.js`: apply() wires ContextStore + pool factory + multi-pool
  ForwardManager; tools gain `(args, exec)`; routes gain `sessionId`.
- `lib/forwards.js`: multi-pool refactor (§5).
- `lib/client.js`: additive `sessionId` wiring (§7.4).
- New config keys per §4.3 added to `Config` with schemastery-safe defaults (no
  `.optional()` — follow the existing style, e.g. `proxy` at `lib/index.js:94-103`).

---

## 12. Test matrix (contract for the test engineer)

Run everything with `npm test` (node --test) where possible; the two PowerShell
scripts are Windows-local and are invoked manually / in local CI (the ubuntu GitHub CI
at `.github/workflows/ci.yml` already tolerates a skipped boot smoke).

### 12.1 Unit — ContextStore (new `test/contexts.test.js`)

Use a temp `DSH_HOME` per test (so `remoteWorkspacesRoot()` is isolated).

1. **Isolation:** bind context `a` (machine A, ws1) and `b` (machine B, ws2); entries
   never bleed across ids; unbound `c` stays `{ machineId: null, workspace: '' }`.
2. **Binding:** set/get round-trips `{ machineId, workspace }` for one id; updating
   `workspace` keeps `machineId`; `updatedAt` advances.
3. **Persistence round-trip:** set entries → file exists with
   `{ version: 1, contexts: {…} }` shape; a **fresh** ContextStore (simulated restart)
   loading the same file sees identical entries; ephemeral-only contexts are **absent**
   from the file (assert the raw JSON contains no ephemeral id).
4. **Corrupt repair:** write garbage (`{not json`) to `contexts.json`; load → empty
   store, no throw; a subsequent set atomically rewrites a valid file.
5. **LRU eviction:** `maxRemoteContexts = 2`; materialize live pools for `a`, `b`;
   touch `a`; materialize `c` → `b` (oldest `lastUsed`) is evicted: its fake pool's
   `close()` called, its watchers cleared, its **persisted** entry still on disk.
6. **Idle eviction:** `remoteContextIdleMs` tiny (e.g. 50 ms) with the checker invoked
   directly (or a short real wait); idle live pool closed, persisted entry kept;
   `remoteContextIdleMs = 0` disables eviction.
7. **Global bootstrap:** (a) registry absent + config host set → `__global__` materializes
   from config default; (b) registry with `currentId: null` **explicit** (`explicitNone`)
   + config host set → `__global__` stays inert (config default NOT adopted);
   (c) registry `currentId` set → `__global__` binds that machine.
8. **Sanitized ids:** context id `a/b\\c:d` stores under key `a_b_c_d` and is served
   back for the same raw id; `''` → `'session'`; `'__global__'` round-trips untouched.

### 12.2 Unit — ForwardManager multi-pool (extend `test/` with `test/forwards.test.js`)

Fake pools = objects with `connect()` resolving a fake client (`new EventEmitter()`);
fake server = a `net`-free stub captured by the manager (or real `net.createServer` on
ephemeral ports — implementer's choice; assertions must not require a network).

1. `attach(clientA, poolA)` auto-starts only `autoStart` local defs whose
   `machineId` is `null` or `=== 'mA'`; a def bound to `'mB'` does **not** start on
   pool A.
2. `attach(clientB, poolB)` (bound `mB`) starts the `'mB'` def on pool B; both null-
   machineId defs run concurrently on both pools; `list()` marks each `active`.
3. `detach(clientA)` stops **only** pool A's servers (their stubs closed); pool B's
   stay active; `attach(clientA2, poolA)` after a "reconnect" re-attaches cleanly.
4. `start(def, pool)` on an already-active def is a no-op success; `stop(id)` removes
   the right pool's server; `remove(id)` persists the def deletion in the single global
   `forwards.json` (assert one file, shape `{ defs: [...] }`).

### 12.3 Tool harness (new `test/harness.test.js` — drives the REAL `apply()`)

Harness pattern (normative):

- `process.env.DSH_HOME` → fresh temp dir per test (isolated registry + contexts.json).
- Mock `ctx`: records `tools.register(t)`, `systemPrompt.section(s)`, `effect(fn, name)`,
  `get('commands') → null`, `get('sessions') → null`,
  `get('webServer') → { register(route) { routes.push(route) } }`.
- `poolFactory` → **FakePool** instances (array-tracked): implements the §4.1 surface;
  `exec('echo ok') → { code: 0, stdout: 'ok' }`; `sftp()` → in-memory sftp (reuse
  `test/helpers.js` `makeSftp`/`MemFs` per fake pool); records `setTarget`/`close`
  calls; `client` = a truthy stub once "connected".
- `apply(ctx, config, { poolFactory })` with `config` at schema defaults plus
  `auditLog: false` (or keep audit on and assert segments — implementer's choice, but
  the audit-format test in §12.3.9 must exist).
- Tool invocation helper: `call(toolName, args, agentId)` → find the registered tool,
  `await tool.execute(args, agentId ? { agent: { id: agentId, session: { id: agentId } } } : {})`.
- Route helper: `route(path, method, { query, body })` → build a fake `req`
  (`url` with query, `method`, body as a readable stream) + fake `res` capturing
  `statusCode` and JSON.

Scenarios (each an independent test):

1. **Two agents, two hosts, no clobber:** `a` → `rw_connect {host:'h-a'}`;
   `b` → `rw_connect {host:'h-b'}`; `a` → `rw_pick_workspace /a`; `b` →
   `rw_pick_workspace /b`. Assert: FakePool[a] `setTarget` host `h-a` + workspace `/a`
   (unchanged by b's actions); FakePool[b] `h-b` + `/b`; `rw_list_dir` (default path)
   from `a` reads `a`'s MemFs tree; `b`'s pool `connect()` count never touched by `a`
   calls.
2. **Sub-agent isolation:** parent `p` bound to `h-p` + ws `/p`; child `c` (a fresh id,
   e.g. `crypto.randomUUID()` — exactly what the host driver mints, §1.3) calls
   `rw_info` → reports **unbound/local, no machine, no workspace**; `c` calling
   `rw_list_dir` (no path) fails with the "no remote context" error; parent `p` is
   still bound/connected.
3. **Per-context workspace:** as (1) — additionally assert each context's
   `rw_exec` (default cwd) prefixes `cd /a` / `cd /b` respectively (inspect the
   recorded command string in the fake pool).
4. **Persistence restore after simulated restart:** `a` → `rw_connect {host:'h-a',
   save: true}` + `rw_pick_workspace /a` (assert `contexts.json` on disk contains
   `a → { machineId, workspace: '/a' }` and `machines.json` gained the machine);
   **second `apply()`** on the SAME temp home (fresh closure state, fresh fake pools);
   `a` → `rw_list_dir /a` succeeds: new FakePool got `setTarget` with `h-a` and
   workspace `/a` **without** another `rw_connect`; a brand-new id `z` stays unbound.
5. **`?sessionId=` route routing:** with contexts `s1` (h-a) and `s2` (h-b) live,
   `GET /dsh-remote/status?sessionId=s1` → `host h-a, connected true, workspace /a`;
   `…?sessionId=s2` → `h-b /b`; `GET /dsh-remote/ls?sessionId=s1` lists `s1`'s tree;
   `POST /dsh-remote/workspace { sessionId: 's2', path: '/b2' }` changes **only**
   s2.
6. **`rw_disconnect` independence:** disconnect from `a`; FakePool[a] `close()` called;
   `b` still `connected` (its fake pool's `client` intact, `rw_list_dir` works).
7. **LRU eviction closes the oldest pool:** config `maxRemoteContexts: 2`; bind + use
   `a`, then `b`, touch `a`, bind `c` → FakePool[b].closed === true, FakePool[a/c]
   alive; `b`'s persisted entry still in `contexts.json`; `b`'s next tool use
   re-materializes a new fake pool.
8. **Ephemeral never persisted:** `a` → `rw_connect {host:'h-e', save: false}`;
   `contexts.json` does not mention `a`; simulate eviction or second apply → `a`
   unbound again.
9. **Audit segments:** with `auditLog: true`, a bound `a` running `rw_exec 'ls'`
   appends a line containing `| a |` and the op/exec fields in the §9 format; an
   agentless call (exec without agent) logs `| __global__ |`.

### 12.4 Windows boot smoke — `scripts/boot-smoke.ps1` (new)

Windows counterpart of `scripts/boot-smoke.sh` (hard-link copy is not available on
Windows — use `Copy-Item -Recurse`). Normative script behavior:

1. `TMP = Join-Path $env:TEMP ("dsh-boot-smoke-" + [guid]::NewGuid().ToString("N"))`;
   create `$TMP\harness\profiles`.
2. Copy the **product web profile**:
   `Copy-Item -Recurse "%AppData%\dsh-desktop\harness\profiles\web" "$TMP\harness\profiles\web"`
3. Overwrite the bundled plugin lib with the **source** lib (so the smoke tests THIS
   branch):
   ```powershell
   Remove-Item -Recurse -Force "$TMP\harness\profiles\web\node_modules\dsh-remote\lib"
   Copy-Item -Recurse ".\lib" "$TMP\harness\profiles\web\node_modules\dsh-remote\lib"
   ```
4. Pick a free port (e.g. start at 53200, retry +1 on bind failure, ≤ 20 tries).
5. Launch the bundled harness (native node from the DSH Desktop install):
   ```powershell
   $env:DSH_HOME = "$TMP\harness"
   Start-Process -PassThru -WindowStyle Hidden `
     "D:\Program Files\DSH Desktop\resources\app\node_modules\node\bin\node.exe" `
     -ArgumentList '--expose-internals',
       'D:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js',
       'web',
       '--patch', 'D:\Program Files\DSH Desktop\resources\dsh-desktop.patch.yml',
       '--host', '127.0.0.1', '--port', "$PORT" `
     -RedirectStandardOutput "$TMP\boot.log" -RedirectStandardError "$TMP\boot.err"
   ```
6. Poll the log ≤ 40 s for `dsh web:` (healthy) or `DSH entry failed` (fatal), like the
   bash script's loop.
7. **Probe the JSON routes (new vs the bash script):**
   `GET http://127.0.0.1:$PORT/dsh-remote/machines` and
   `GET http://127.0.0.1:$PORT/dsh-remote/status` — both must return **HTTP 200** with
   a JSON body (`machines` array present; `status` has `hostKeyMode`). A plugin that
   fails to load ⇒ 404/no route ⇒ script fails.
8. Always: stop the process (kill the tree), `Remove-Item -Recurse $TMP`, exit 0/1 with
   `tail`-equivalent of the log on failure.

All paths in (3)-(5) verified to exist on the dev machine at spec time (see §14 refs).

### 12.5 Sandbox E2E — `scripts/e2e-multisession.ps1` (new)

Multi-session E2E against the **real local SSH endpoints** (OpenSSH servers running on
127.0.0.1; machines already in the dev-machine registry with plain passwords — verified
present at spec time, §14):

| name | registry id | endpoint | user |
|---|---|---|---|
| server-b | `m-mtgxru10-rfof` | `127.0.0.1:12922` | `user` |
| server-a | `m-mth1c6hl-wvus` | `127.0.0.1:12722` | `user` |

Script behavior (normative):

1. Boot a sandbox exactly like §12.4 (isolated temp `DSH_HOME`, source lib copied over
   the profile's bundled lib, temp port). **But the registry must contain the two test
   machines** — the isolated home starts empty, so the script first seeds
   `$DSH_HOME\remote-workspaces\machines.json` by copying the two machine records
   (server-b, server-a) out of the real registry
   `%AppData%\dsh-desktop\harness\remote-workspaces\machines.json`
   (filter `list` by the two ids; keep `password`/`credentialBackend: plain` verbatim —
   they are plain, non-sensitive test-box credentials).
2. Wait for the harness to be healthy (`dsh web:` in log; routes probe 200).
3. **Bind sessions:**
   - `POST /dsh-remote/connect` body
     `{ "sessionId": "s1", "machineId": "m-mtgxru10-rfof", "workspace": "/tmp" }`
     → expect `ok: true, connected: true, machineId: "m-mtgxru10-rfof", workspace: "/tmp"`.
   - `POST /dsh-remote/connect` body
     `{ "sessionId": "s2", "machineId": "m-mth1c6hl-wvus", "workspace": "/home/user" }`
     (server-a). **Fallback:** if server-a does not authenticate (non-`ok` or `connected:
     false`), retry s2 with
     `{ "sessionId": "s2", "machineId": "m-mtgxru10-rfof", "workspace": "/tmp/e2e-s2" }`
     (server-b, distinct workspace) and record in the script output:
     `E2E NOTE: server-a (m-mth1c6hl-wvus) did not authenticate; used server-b fallback`.
4. **Assertions (all must pass):**
   - `GET /dsh-remote/status?sessionId=s1` and `?sessionId=s2` return distinct connected
     contexts: different `machineId` (or, in fallback mode, different `workspace`),
     both `connected: true`, both `sessionMode: 'remote'`; `s1.workspace === '/tmp'`.
   - `GET /dsh-remote/ls?sessionId=s1&path=/tmp` → 200 with `items` array; same for
     `s2` (its workspace path).
   - `POST /dsh-remote/connect` `{ "sessionId": "s1", "action": "disconnect" }` →
     `ok: true`; then `GET /dsh-remote/status?sessionId=s1` → `connected: false`;
     `GET /dsh-remote/status?sessionId=s2` → **still `connected: true`** (independence).
   - `GET /dsh-remote/status?sessionId=s3` (never connected) → 200 with
     `machineId: null, connected: false, workspace: '', sessionMode: 'local'`
     (fresh unbound session reports local).
   - `GET /dsh-remote/status` (no sessionId) → 200 legacy shape (global context
     intact, `machines` list present).
   - `contexts.json` under the temp home contains `s1` (and `s2`) entries with
     `machineId` + `workspace` and **no credential fields** (assert the raw file does
     not contain the password string).
5. Teardown: stop harness, remove temp home, print PASS/FAIL summary; exit non-zero on
   any failed assertion.

---

## 13. Acceptance criteria (measurable)

Each bullet is verifiable by a test, command, or E2E assertion (names from §12):

1. `docs/per-session-context-spec.md` exists and is the only new doc; `git status`
   shows no unexpected files.
2. All four §1 assumptions are implemented on the strength of the verified host
   behavior: tools read the context from the 2nd `execute` arg (harness test 2 and 3
   pass with `{ agent: { id } }` execs; agentless execs route to `__global__`).
3. New agent threads start unbound: harness test 2 — a fresh-id child reports unbound
   from `rw_info` and gets the "no remote context" error from workspace-relative tools,
   while its parent stays bound.
4. Ephemeral bindings are never persisted: harness test 8 — no `contexts.json` entry
   after `save: false`; second `apply()` sees the context unbound.
5. Only `machineId` + `workspace` (± `updatedAt`) are persisted: harness test 4 +
   E2E assertion — `contexts.json` entries contain exactly those fields; raw file
   contains no password/credential strings.
6. `contexts.json` lives under `remoteWorkspacesRoot()`, uses the `{ version: 1,
   contexts: {…} }` shape, atomic writes, corrupt-file fallback to empty (unit tests
   3, 4).
7. `__global__` keeps legacy behavior: unit test 7 (a/b/c bootstrap cases); no-
   `sessionId` web routes behave as pre-change (E2E legacy `/status` assertion;
   settings UI flows in the client unchanged).
8. The machine registry stays global: `machines.json` single file; context binds by
   reference (harness test 4); no per-context registry files exist (inspect temp home
   in E2E teardown).
9. Per-context pools are isolated: harness tests 1 and 6 — two hosts no clobber;
   `rw_disconnect` closes only the calling context's pool.
10. LRU + idle eviction: harness test 7 + unit tests 5, 6 — oldest pool closed at cap;
    idle pool closed after threshold; persisted bindings survive eviction and
    re-materialize on next use; checker interval is `unref()`'d (assert
    `timer.unref` was called or process exits cleanly with only idle contexts).
11. `apply(ctx, config, { poolFactory })` injectable factory: harness runs the real
    `apply()` with fake pools — zero real SSH connections during `npm test`
    (no network in CI).
12. Forwarding multi-pool: unit tests 1-4 — machineId-matched autoStart, per-pool
    attach/detach isolation, single global `forwards.json`.
13. `sessionId`-scoped routes work for exactly the §7.1 list: harness test 5 (status/
    ls/workspace) + E2E (connect with machineId, ls, disconnect, fresh-session status);
    `/machines`, `/current`, `/forwards`, `/test-connect`, `/tasks`, `/audit` remain
    global (E2E legacy status + no-`sessionId` probes).
14. System prompt per-agent: bound context → section names the context's
    machine/workspace (assert via the registered section fn with
    `{ agent: { id, session: { header: { cwd } } } }` contexts: bound id → context
    machine text; unbound id + mirror cwd → legacy mirror text; unbound id + local cwd
    → `''`).
15. Audit lines carry the sanitized context id segment (harness test 9; format per §9).
16. Windows boot smoke: `pwsh scripts/boot-smoke.ps1` exits 0 — isolated `DSH_HOME`
    boots the real desktop harness with this branch's lib, and
    `GET /dsh-remote/machines` + `GET /dsh-remote/status` return 200.
17. E2E: `pwsh scripts/e2e-multisession.ps1` exits 0 — all §12.5(4) assertions pass on
    the local SSH endpoints (server-b primary; server-a or documented server-b fallback).
18. Regression gates still green: `npm test` (all pre-existing tests), `node --check`
    on every `lib/*.js`, `node check.mjs` (command/tool/route-name lints).
19. No npm version bump: `package.json` version unchanged (`0.8.10`).

---

## 14. References

Current-state anchors in `lib/index.js` (branch head, for implementer orientation):
`apply()` :807 · single `SshPool` :808 · `Config` :56-117 · `dshBase` :123-127 ·
`remoteWorkspacesRoot` :130-132 · `encodeSegmentSafe` :136-139 · file constants
:233-238 · `SshPool` class :306-792 · `ephemeral`/`activeMachine` :820-830 ·
`machinePassword` :833-840 · `applyActiveMachine` :848-860 · `setCurrent` :862-879 ·
`clearActiveMachine` :884-905 · config bootstrap :912-916 · auto-restore probe
:924-937 · `persistWorkspace` :942-955 · `audit` :958-964 · `ForwardManager` wiring
:986-989 · auto-push :995-1048 · `wsPath` :1180 · `resolveMirrorForLocal` :1184-1211 ·
`sessionRemotePath` :1221-1235 · `status()` :1236-1259 · tools :1272-1955 ·
prompt section :1969-1989 · slash commands :1992-2032 · web routes :2130-2939 ·
registry logic `lib/registry.js` (loadMachines :17, saveMachines :43, sanitizeMachine
:62, applyMachine :71, machineId :87) · forwards `lib/forwards.js` (attach :49,
detach :63, define :92, start :114, list :74, stop :201, stopAll :216).

Environment facts verified at spec time (2025-06, dev machine):

- DSH host checkout present at
  `D:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\`
  (all packages `0.1.2-alpha.1`).
- Boot-smoke inputs exist:
  `D:\Program Files\DSH Desktop\resources\app\node_modules\node\bin\node.exe`,
  `D:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js`,
  `D:\Program Files\DSH Desktop\resources\dsh-desktop.patch.yml`,
  `%AppData%\dsh-desktop\harness\profiles\web` (bundled
  `dsh-remote` 0.8.10 with `lib/` overridable).
- Local registry
  `%AppData%\dsh-desktop\harness\remote-workspaces\machines.json`
  contains `server-b m-mtgxru10-rfof` (127.0.0.1:12922, user `user`, `plain`) and
  `server-a m-mth1c6hl-wvus` (127.0.0.1:12722, user `user`, `plain`) — the E2E endpoints.
