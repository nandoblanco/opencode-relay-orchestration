import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { Plugin } from '@opencode/plugin/tui'
import { createStore } from '../src/store.ts'
import { memoryStorage } from './helpers.ts'
import { RelayRpc } from '../src/rpc.ts'

const stubUrl = 'data:text/javascript,' + encodeURIComponent(`
import { createEffect } from "solid-js"
function flatten(node) {
  if (!node) return []
  if (typeof node === "string") return [node]
  if (typeof node._content === "string") return [node._content]
  if (node.tag === "#text" && typeof node.content === "string") return [node.content]
  const out = []
  for (const child of node.children || []) out.push(...flatten(child))
  return out
}
export function createElement(tag) {
  const node = { tag, children: [] }
  Object.defineProperty(node, "content", {
    configurable: true,
    get() { return this._content !== undefined ? this._content : flatten(this).join("\\n") },
    set(value) { this._content = value },
  })
  return node
}
export const createTextNode = (text) => ({ tag: "#text", content: String(text), children: [] })
export const insertNode = (parent, child) => { if (child) parent.children.push(child) }
export const setProp = (node, key, value) => { node[key] = value }
export const effect = createEffect
export function insert(parent, accessor) {
  const index = parent.children.length
  const slot = { tag: "#slot", children: [] }
  parent.children.splice(index, 0, slot)
  createEffect(() => {
    const value = typeof accessor === "function" ? accessor() : accessor
    slot.children = Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []
  })
}
`)

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'solid-js') return { url: import.meta.resolve('solid-js/dist/solid.js'), shortCircuit: true }
  if (specifier === '@opentui/solid') return { url: stubUrl, shortCircuit: true }
  return nextResolve(specifier, context)
} })
let plugin: typeof import('../src/tui.ts')['default']
try { plugin = (await import('../src/tui.ts')).default } finally { hooks.deregister() }
test('TUI audit summarizes related records and export explicitly requests a file write', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Audit record', 'session')
  const slots: any[] = []; const layers: any[] = []; const alerts: any[] = []; const toasts: any[] = []; const exports: any[] = []
  const api = { validateConfig: async () => ({ roles: [], errors: [], limits: { maxRunningTasks: 1, maxFixCycles: 2 }, enableProbe: false }), listRecords: async () => [record], getSnapshot: async () => record, listRuns: async () => [], listEvidence: async () => [], exportReport: async (input: any) => { exports.push(input); return { name: 'relay-abcd1234.md', markdown: '# Audit', path: '.relay/reports/relay-abcd1234.md' } }, events: { on: () => () => {} } }
  const ctx = { location: { directory: '/project' }, client: { rpc: () => api }, data: { on: () => () => {} }, keymap: { layer: (factory: any) => { layers.push(factory()) } }, ui: { slot: (claim: any) => { slots.push(claim); return () => {} }, router: { current: () => ({ type: 'session', sessionID: 'session' }) }, panel: { current: () => undefined }, dialog: { alert: async (input: any) => { alerts.push(input) } }, toast: { show: (input: any) => { toasts.push(input) } } } } as unknown as Plugin.Context
  const dispose = await plugin.setup(ctx)
  slots.find(slot => slot.append === 'app').render()
  const commands = layers.flatMap(layer => layer.commands)
  await commands.find(command => command.id === 'relay-audit').run()
  assert.match(alerts[0].message, /Audit record: draft; 0 runs/)
  await commands.find(command => command.id === 'relay-export').run()
  assert.deepEqual(exports, [{ recordID: record.id, write: true }])
  assert.equal(toasts.at(-1).message, 'Report written: .relay/reports/relay-abcd1234.md')
  api.exportReport = async () => { throw { type: 'invalid_op', message: 'Could not write report file.' } }
  await commands.find(command => command.id === 'relay-export').run()
  assert.equal(toasts.at(-1).message, 'Could not write report file.')
  api.listRecords = async () => []
  await commands.find(command => command.id === 'relay-audit').run()
  assert.equal(toasts.at(-1).message, 'No Relay record selected.')
  await commands.find(command => command.id === 'relay-export').run()
  assert.equal(toasts.at(-1).message, 'No Relay record selected.')
  await dispose?.()
})

test('TUI app slot registers global palette/slash commands once and disposes slots', async () => {
  // Stub only the native renderer import; exercise the actual plugin setup and commands.
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@opentui/solid') return { url: stubUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  } })
  let plugin
  try { plugin = (await import('../src/tui.ts')).default } finally { hooks.deregister() }
  const slots: any[] = []; const layers: any[] = []; const disposed: string[] = []; const alerts: any[] = []
  let currentPanel: { name: string } | undefined = { name: 'opencode-relay-orchestration:status' }
  const ctx = {
    location: { directory: '/project' },
    client: { rpc: () => ({ validateConfig: async () => ({ roles: [], errors: [], limits: { maxRunningTasks: 1, maxFixCycles: 2 }, enableProbe: false }), listRecords: async () => [], events: { on: () => () => { disposed.push('rpc') } } }) },
    data: { on: () => () => { disposed.push('reconnect') } },
    keymap: { layer: (factory: () => unknown) => { layers.push(factory()) } },
    ui: { slot: (claim: any) => { slots.push(claim); return () => { disposed.push(claim.append) } },
      router: { current: () => ({ type: 'session', sessionID: 'session' }) },
      panel: { open: (name: string) => { assert.equal(name, 'opencode-relay-orchestration:status'); return false }, current: () => currentPanel, close: () => { currentPanel = undefined; disposed.push('panel-close') } },
      dialog: { alert: async (input: unknown) => { alerts.push(input) } },
    },
  } as unknown as Plugin.Context
  const dispose = await plugin.setup(ctx)
  assert.equal(typeof dispose, 'function')
  assert.equal(layers.length, 0)
  const app = slots.find(slot => slot.append === 'app')
  assert.ok(app); assert.ok(slots.find(slot => slot.append === 'session.panel'))
  assert.equal(app.render(), null); assert.equal(app.render(), null)
  assert.equal(layers.length, 2); assert.equal(layers[1].mode, 'global')
  assert.equal(layers[0].enabled(), false); assert.equal(layers[0].commands[0].bind, 'escape')
  assert.equal(layers[0].commands[0].run(), false)
  const panel = slots.find(slot => slot.append === 'session.panel')
  panel.render({ name: 'opencode-relay-orchestration:status', sessionID: 'session', focused: false })
  assert.equal(layers[0].enabled(), false)
  assert.equal(layers[0].commands[0].run(), false)
  panel.render({ name: 'opencode-relay-orchestration:status', sessionID: 'session', focused: true })
  assert.equal(layers[0].enabled(), true)
  layers[0].commands[0].run()
  assert.equal(layers[0].enabled(), false)
  assert.equal(disposed.pop(), 'panel-close')
  currentPanel = { name: 'opencode-relay-orchestration:status' }
  panel.render({ name: currentPanel.name, sessionID: 'session', focused: true })
  currentPanel = undefined
  assert.equal(layers[0].enabled(), false); assert.equal(layers[0].commands[0].run(), false)
  currentPanel = { name: 'other:panel' }
  assert.equal(layers[0].enabled(), false); assert.equal(layers[0].commands[0].run(), false)
  currentPanel = { name: 'opencode-relay-orchestration:status' }
  layers[1].commands.find((command: any) => command.id === 'relay-close').run()
  assert.equal(layers[0].enabled(), false); assert.equal(layers[0].commands[0].run(), false)
  assert.equal(disposed.pop(), 'panel-close')
   const names = ['relay-validate-config', 'relay-probe-image', 'relay-status', 'relay-audit', 'relay-export', 'relay-add-check', 'relay-remove-check', 'relay-manual-verify', 'relay-close', 'relay-withdraw', 'relay-new', 'relay-add-task', 'relay-approve', 'relay-signoff', 'relay-start', 'relay-interrupt', 'relay-resume', 'relay-complete', 'relay-cancel', 'relay-assign-task']
  assert.deepEqual(layers[1].commands.map((command: any) => command.id), names)
  for (const command of layers[1].commands) {
    assert.equal(command.palette, true); assert.equal(command.slash.name, command.id)
    assert.ok(command.description.length > 0)
  }
  await layers[1].commands.find((command: any) => command.id === 'relay-status').run()
  assert.match(alerts[0].message, /No relay record/)
  await dispose!()
  assert.deepEqual(disposed.sort(), ['app', 'reconnect', 'rpc', 'session.panel'].sort())
})

async function tuiContext(initialResult = false) {
  let snapshot = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Plan', 'session')
  if (initialResult) snapshot = { ...snapshot, approvalResult: { revision: 1, outcome: 'rejected', at: snapshot.updatedAt } }
  let changed!: (event: unknown) => void
  let reads = 0
  const slots: any[] = []; const layers: any[] = []; const toasts: any[] = []
  const ctx = {
    location: { directory: '/project' },
    client: { rpc: () => ({ validateConfig: async () => ({ roles: [], errors: [], limits: { maxRunningTasks: 1, maxFixCycles: 2 }, enableProbe: false }), listEvidence: async () => [], listRuns: async () => [], listRecords: async () => [snapshot], getSnapshot: async () => { reads++; return snapshot }, mutate: async () => { throw { type: 'stale_revision' } }, events: { on: (name: string, callback: typeof changed) => { assert.equal(name, 'changed'); changed = callback; return () => {} } } }) },
    data: { on: () => () => {} },
    keymap: { layer: (factory: () => unknown) => { layers.push(factory()) } },
    ui: { slot: (claim: any) => { slots.push(claim); return () => {} }, router: { current: () => ({ type: 'session', sessionID: 'session' }) },
      panel: { open: () => true, current: () => ({ name: 'opencode-relay-orchestration:status' }) },
      dialog: { prompt: async () => 'New task' }, toast: { show: (input: unknown) => { toasts.push(input) } },
    },
  } as unknown as Plugin.Context
  const dispose = await plugin.setup(ctx)
  slots.find(slot => slot.append === 'app').render()
  const node = slots.find(slot => slot.append === 'session.panel').render({ name: 'opencode-relay-orchestration:status', sessionID: 'session', focused: true })
  const command = (id: string) => layers[1].commands.find((item: any) => item.id === id).run()
  await command('relay-status')
  return { node, toasts, command, dispose, ctx, reads: () => reads, snapshot: () => snapshot, update: (record: typeof snapshot) => { snapshot = record }, changed: async () => { changed({ recordID: snapshot.id, revision: snapshot.revision, location: { directory: '/project' } }); await new Promise(resolve => setImmediate(resolve)) } }
}
test('TUI changed event refetches the current snapshot and updates rendered text', async () => {
  const ui = await tuiContext()
  try {
    const reads = ui.reads()
    assert.match(ui.node.content, /Plan\nRevision 1/)
    ui.update({ ...ui.snapshot(), title: 'Refreshed plan', revision: 2 })
    await ui.changed()
    assert.equal(ui.reads(), reads + 1)
    assert.match(ui.node.content, /Refreshed plan\nRevision 2/)
  } finally { await ui.dispose!() }
})
test('TUI approval result toasts appear only when a known record result changes', async () => {
  const ui = await tuiContext(true)
  try {
    assert.deepEqual(ui.toasts, [])
    const record = ui.snapshot()
    ui.update({ ...record, phase: 'approved', revision: 2, approvals: [{ kind: 'plan', revision: 1, planRevision: record.planRevision, approvedAt: record.updatedAt, source: 'permission-assert' }], approvalResult: { revision: 1, outcome: 'approved', at: record.updatedAt } })
    await ui.changed()
    assert.deepEqual(ui.toasts, [{ message: 'Plan approved for revision 1', variant: 'success' }])
    await ui.changed()
    assert.equal(ui.toasts.length, 1)
    ui.update({ ...record, revision: 2, approvalResult: { revision: 2, outcome: 'rejected', at: record.updatedAt } })
    await ui.changed()
    assert.deepEqual(ui.toasts[1], { message: 'Approval rejected', variant: 'warning' })
  } finally { await ui.dispose!() }
})
test('TUI failed mutation shows a readable error toast and panel error text', async () => {
  const ui = await tuiContext()
  try {
    await ui.command('relay-add-task')
    const message = 'This record changed. Review the refreshed snapshot and retry.'
    assert.deepEqual(ui.toasts, [{ message, variant: 'error' }])
    assert.ok(ui.node.content.includes(message))
    assert.doesNotMatch(ui.node.content, /stale_revision/)
  } finally { await ui.dispose!() }
})
test('TUI phase commands issue explicit mutations only when their transition is available', async () => {
  const ui = await tuiContext()
  try {
    const r = ui.snapshot()
    await ui.command('relay-start')
    assert.match(ui.toasts.at(-1).message, /not available/)
    ui.update({ ...r, phase: 'approved', approvals: [{ kind: 'plan', revision: 1, planRevision: r.planRevision, approvedAt: r.updatedAt, source: 'permission-assert' }] })
    await ui.changed()
    await ui.command('relay-start')
    assert.match(ui.toasts.at(-1).message, /This record changed/)
    ui.update({ ...r, phase: 'interrupted', interruptReason: 'server_restart' }); await ui.changed()
    assert.match(ui.node.content, /Interrupted: server restarted/)
    await ui.command('relay-resume')
    assert.match(ui.toasts.at(-1).message, /not available/)
  } finally { await ui.dispose!() }
})
test('TUI interrupt trims reason and treats blank input as cancel without RPC', async () => {
  const ui = await tuiContext()
  try {
    ui.update({ ...ui.snapshot(), phase: 'running' }); await ui.changed()
    let calls = 0; let submitted: any
    const api = ui.ctx.client.rpc(RelayRpc) as any
    // The context factory returns a fresh wrapper; replace it for this interaction test.
    ;(ui.ctx.client as any).rpc = () => ({ ...api, mutate: async (input: any) => { calls++; submitted = input; return ui.snapshot() } })
    for (const reason of ['', '   ']) { (ui.ctx.ui.dialog as any).prompt = async () => reason; await ui.command('relay-interrupt') }
    assert.equal(calls, 0)
    ;(ui.ctx.ui.dialog as any).prompt = async () => '  Pause now  '
    await ui.command('relay-interrupt'); assert.equal(calls, 1); assert.deepEqual(submitted.op, { type: 'interrupt', reason: 'Pause now' })
  } finally { await ui.dispose!() }
})
test('TUI image probe reports missing session and distinguishes host errors from wrong answers', async () => {
  const ui = await tuiContext()
  try {
    let calls = 0; let image = 'error'
    const report = () => ({ roles: [{ role: 'reviewer', model: { providerID: 'test', id: 'vision' }, errors: [], image }], errors: [], limits: { maxRunningTasks: 1, maxFixCycles: 2 }, enableProbe: true })
    const original = ui.ctx.client.rpc(RelayRpc) as any
    ;(ui.ctx.client as any).rpc = () => ({ ...original, validateConfig: async () => report(), probeImage: async () => { calls++; return report() } })
    await ui.command('relay-validate-config')
    ;(ui.ctx.ui.router as any).current = () => ({ type: 'home' })
    await ui.command('relay-probe-image')
    assert.equal(calls, 0); assert.match(ui.toasts.at(-1).message, /Select a session/)
    ;(ui.ctx.ui.router as any).current = () => ({ type: 'session', sessionID: 'session' })
    await ui.command('relay-probe-image'); assert.match(ui.toasts.at(-1).message, /host error/)
    image = 'failed'; await ui.command('relay-probe-image'); assert.match(ui.toasts.at(-1).message, /did not match/)
  } finally { await ui.dispose!() }
})
test('TUI refresh loads run stages and relay-signoff shows pending then denial without duplicate prompts', async () => {
  const ui = await tuiContext()
  try {
    const r = ui.snapshot()
    ui.update({ ...r, phase: 'running', tasks: [{ id: 'task', title: 'Worker task', status: 'running', owner: { role: 'reviewer' }, fixCycles: 1, updatedAt: r.updatedAt }] })
    const original = ui.ctx.client.rpc(RelayRpc) as any
    let calls = 0; let reject!: (failure: unknown) => void
    ;(ui.ctx.client as any).rpc = () => ({ ...original, listRuns: async () => [{ id: 'run', recordID: r.id, taskID: 'task', role: 'reviewer', stage: 'review', status: 'reported', attempt: 2, startedAt: r.createdAt, model: { id: 'review', providerID: 'test' }, sessionID: 'worker', report: { verdict: 'changes', summary: 'Add an assertion', findings: [{ severity: 'major', text: 'Missing assertion' }] }, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } }], signOff: async () => { calls++; await new Promise((_, fail) => { reject = fail }); return ui.snapshot() } })
    await ui.changed()
    assert.match(ui.node.content, /Reviewing, attempt 2/); assert.match(ui.node.content, /1 finding \(1 major\)/); assert.match(ui.node.content, /Tokens: input 10, output 5/)
    await ui.command('relay-signoff'); assert.equal(calls, 0)
    ui.update({ ...ui.snapshot(), tasks: ui.snapshot().tasks.map(task => ({ ...task, status: 'completed' })) }); await ui.changed()
    const pending = ui.command('relay-signoff')
    await new Promise(resolve => setImmediate(resolve))
    assert.match(ui.node.content, /Waiting for sign-off of revision 1/)
    await ui.command('relay-signoff'); assert.equal(calls, 1)
    reject({ type: 'approval_denied' }); await pending
    assert.match(ui.node.content, /Sign-off was denied. The record is still running./)
    assert.equal(ui.snapshot().phase, 'running')
    assert.doesNotMatch(ui.node.content, /Waiting for sign-off/)
    assert.equal(ui.toasts.at(-1).variant, 'error')
  } finally { await ui.dispose!() }
})
test('TUI panel reads ctx.theme directly without calling unsupported surface("panel")', async () => {
  const { RGBA } = await import('@opentui/core')
  const ui = await tuiContext()
  try {
    const fg = RGBA.fromInts(240, 240, 240, 255)
    const accent = RGBA.fromInts(120, 180, 255, 255)
    ;(ui.ctx as any).theme = {
      background: { base: RGBA.fromInts(10, 12, 16, 255), raised: { base: RGBA.fromInts(20, 24, 30, 255) } },
      border: { base: RGBA.fromInts(60, 68, 82, 255) },
      text: { base: fg, muted: fg, faint: fg, action: { primary: { base: accent } }, feedback: { success: { base: fg }, warning: { base: fg }, error: { base: fg } } },
      surface(name: string) { if (name !== 'dialog' && name !== 'dialog.footer') throw new Error(`Invalid surface: ${name}`); return this },
    }
    await ui.changed()
    assert.match(ui.node.content, /Plan\nRevision 1/)
    assert.match(ui.node.content, /Role configuration/)
  } finally { await ui.dispose!() }
})
test('TUI background startup does not pop config error toasts when validateConfig fails', async () => {
  const toasts: any[] = []; const layers: any[] = []
  const ctx = {
    location: { directory: '/project' },
    client: { rpc: () => ({ validateConfig: async () => { throw new Error('server reloading') }, listRecords: async () => [], events: { on: () => () => {} } }) },
    data: { on: () => () => {} },
    keymap: { layer: (factory: any) => { layers.push(factory()) } },
    ui: { slot: (claim: any) => { if (claim.append === 'app') claim.render(); return () => {} }, router: { current: () => ({ type: 'session', sessionID: 'session' }) }, panel: { current: () => undefined }, dialog: {}, toast: { show: (input: any) => { toasts.push(input) } } },
  } as unknown as Plugin.Context
  const dispose = await plugin.setup(ctx)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(toasts.length, 0)
    await layers[1].commands.find((item: any) => item.id === 'relay-validate-config').run()
    assert.equal(toasts.length, 1)
    assert.match(toasts.at(-1).message, /Could not validate role configuration/)
  } finally { await dispose!() }
})
