// Regression test for the DSH ≥ 0.7 boot crash (0.8.11).
//
// Reported error:
//   Error: failed to apply loader entry b6b03bef (dsh-remote):
//   cannot get property "workspaces" without inject
//
// Root cause: apply() read the optional `workspaces` service as
//   ctx.get('workspaces') || ctx.workspaces
// In DSH 0.7.x the web client moved to the client-modules + cordis v4
// architecture:
//   1. the `workspaces` service is provided by a SIBLING loader entry
//      (@deepseek-ai/dsh-api-workspace-controller), not by an ancestor of
//      this entry's fiber, and its provider fiber may not be ACTIVE yet when
//      our apply() runs — so ctx.get('workspaces') legitimately returns
//      undefined (strict lookup, no throw);
//   2. the cordis v4 context proxy THROWS `cannot get property "X" without
//      inject` for any property it cannot resolve (older cordis returned
//      undefined) — so the `|| ctx.workspaces` fallback crashed the whole
//      loader entry at boot.
//
// The client-side `workspaces` service was dead code anyway: the local
// folder chooser is served by the host half (/dsh-remote/local-pick, DSH
// directoryPicker service with built-in browse fallback).
//
// Hermetic: no browser, no DSH. A Proxy emulates the cordis v4 context
// contract — real member properties work, every other property access
// throws exactly like the new context proxy does for a service that is not
// provided/injected in this fiber's scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Load the client bundle ────────────────────────────────────────────────
// lib/client.js is a classic browser script that registers itself via
// window.__ModuleLoader__.load({ id, factory }); the factory receives a
// synchronous require (the client module system's module table).
const registrations = []
globalThis.window = {
  __ModuleLoader__: { load: (reg) => registrations.push(reg) },
}
// Minimal React stand-in: the factory only DEFINES components at load time —
// no hook or createElement call runs outside render, so a null-returning
// stub is sufficient to evaluate the module.
const React = {
  createElement: () => null,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
}
const fakeRequire = (spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require: ${spec}`)
}

await import('../lib/client.js')

const reg = registrations.find((r) => r.id === 'dsh-remote')
assert.ok(reg, 'client bundle registered dsh-remote via window.__ModuleLoader__')
const plugin = reg.factory(fakeRequire)
assert.equal(plugin.name, 'dsh-remote')
assert.equal(typeof plugin.apply, 'function')

// ── cordis v4-style context ───────────────────────────────────────────────
// Real members (get/inject/effect) resolve; ANY other property access throws
// exactly like the cordis v4 context proxy for an unprovided service.
// ctx.get() performs the optional lookup and returns undefined (never throws),
// mirroring ReflectService.get().
function makeCtx({ slots = null } = {}) {
  const injectedServices = []
  const target = {
    get: (name) => (name === 'slots' ? slots : undefined),
    inject: (names) => { injectedServices.push(names) }, // never invoked: service may never be provided
    effect: () => () => {},
  }
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop]
      if (typeof prop === 'string' && prop !== 'then') {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return undefined
    },
    has(t, prop) { return prop in t },
  })
  return { ctx: proxy, injectedServices }
}

test('client apply() survives a cordis v4 context — the 0.8.10 boot crash', () => {
  const registered = []
  const slots = {
    injected: [],
    inject: (key, cb) => { slots.injected.push([key, cb]) },
    register: (opts) => { registered.push(opts) },
  }
  const { ctx, injectedServices } = makeCtx({ slots })

  // The old code threw here: `ctx.get('workspaces') || ctx.workspaces`
  // evaluated the throwing property access because the service is not in
  // this entry's scope (sibling fiber / not active yet).
  assert.doesNotThrow(() => plugin.apply(ctx), 'apply() must not crash on the new cordis context proxy')

  // ...and it must have done its actual work, not bailed out early:
  assert.ok(slots.injected.some(([k]) => k === 'settings.section'), 'settings.section injection registered')
  assert.ok(
    slots.injected.some(([k]) => k === 'conversation.hero.workspace.directoryFlow'),
    'conversation.hero.workspace.directoryFlow injection registered',
  )
  assert.ok(
    injectedServices.some((names) => names.includes('betterSidebar')),
    'betterSidebar is awaited via ctx.inject (guarded pattern), never via property access',
  )
})

test('client apply() bails cleanly when slots is unavailable', () => {
  const { ctx } = makeCtx({ slots: null })
  assert.doesNotThrow(() => plugin.apply(ctx))
})
