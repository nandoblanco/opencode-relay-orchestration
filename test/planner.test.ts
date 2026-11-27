import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Plugin } from '@opencode/plugin'
import { setup, promptTitle } from '../src/server.ts'
import { registerPlanner, plannerTools } from '../src/planner.ts'
import { createStore, StoreError } from '../src/store.ts'
import { memoryStorage } from './helpers.ts'
import { plannerTokensMessage } from '../src/view.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
for (const explorer of [true, false]) test(`planner prompt effective exploration=${explorer} and configured widths`, async () => {
  const h = await harness()
  await h.storage.set('relay/config', { version: 1, roles: { explorer: { providerID: 'test', id: 'explore' } }, explorer, widths: [768, 1440], updatedAt: 'now' })
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'UI task' } })
  const text = h.prompts[0].text
  assert.equal(text.includes('Call relay_explore for codebase questions before adding tasks'), explorer)
  assert.equal(text.includes('Read files directly only when the path is already known'), explorer)
  assert.match(text, /each Playwright check.*768, 1440/)
  assert.match(text, /scope "task" \(run after every task\); set scope: "final"/)
  assert.match(text, /^Brainstorm and plan the following task using Relay record/)
  assert.match(text, /PHASE 1: BRAINSTORM FIRST \(REQUIRED BEFORE ANY PLAN TOOLS\)/)
  assert.match(text, /Do NOT call relay_plan_add or relay_plan_submit yet/)
  assert.match(text, /PHASE 2: DRAFT AND SUBMIT PLAN \(ONLY AFTER USER CONFIRMS DIRECTION\)/)
  assert.match(text, /already satisfied, do not submit; call relay_plan_cancel/)
})
test('planner prompt disables brainstorm-first when brainstormFirst is false', async () => {
  const h = await harness()
  await h.storage.set('relay/config', { version: 1, brainstormFirst: false, updatedAt: 'now' })
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Concrete task' } })
  const text = h.prompts[0].text
  assert.match(text, /^Plan the following task using Relay record/)
  assert.doesNotMatch(text, /PHASE 1: BRAINSTORM FIRST/)
  assert.match(text, /ambiguous, conflicting, or high-risk, call the question tool to clarify/)
})
test('planner draft cancel sanitizes reason, withdraws pending approval, restores and unlocks', async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness(false, true)
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Already done' } })
  await h.invoke('relay_plan_add', { tasks: ['Task'] })
  await h.invoke('relay_plan_submit'); await tick()
  const result = await h.invoke('relay_plan_cancel', { reason: '  Already\n\u202edone  ' })
  h.reject(); await tick()
  const record = (await h.store.list())[0]
  assert.equal(record.phase, 'cancelled'); assert.equal(record.cancelReason, 'Already done')
  assert.match(result.content, /Cancelled: Already done/)
  assert.match((await h.invoke('relay_status')).content, /Cancelled: Already done/)
  assert.equal((await h.call('getSnapshot', { recordID: record.id })).approvalResult.outcome, 'withdrawn')
  assert.deepEqual(h.switches, ['planner', 'original']); assert.deepEqual(h.permissions, [])
})
test('planner cancel rejects invalid reason and non-draft, accepts 500 sanitized characters', async () => {
  const h = await harness()
  assert.equal(h.tools.get('relay_plan_cancel').input.properties.reason.maxLength, 500)
  assert.match(h.tools.get('relay_plan_cancel').input.properties.reason.description, /max 500 characters/)
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Cancel limits' } })
  for (const reason of [' \u202e\n ', 'x'.repeat(501)]) await assert.rejects(h.invoke('relay_plan_cancel', { reason }), /1 to 500/)
  const record = (await h.store.list())[0]
  await h.store.write(record.id, record.revision, current => { current.phase = 'approved' })
  await assert.rejects(h.invoke('relay_plan_cancel', { reason: 'Done' }), /Only a draft/)
  const current = await h.store.get(record.id)
  await h.store.write(record.id, current.revision, current => { current.phase = 'draft' })
  await h.invoke('relay_plan_cancel', { reason: 'x'.repeat(500) })
  assert.equal((await h.store.get(record.id)).cancelReason!.length, 500)
})
for (const mode of ['valid', 'no-model', 'no-session-model', 'switch-failure', 'create-failure']) test(`planner model ${mode}`, async t => {
  t.mock.method(console, 'error', () => {})
  const store = createStore(memoryStorage(), { directory: '/project', projectID: 'project' })
  const events: string[] = []; let command: any
  const model = { providerID: 'test', id: 'planner', variant: 'high' }
  const ctx = { options: { roles: { builder: { providerID: 'test', id: 'build' }, reviewer: { providerID: 'test', id: 'review' } } }, command: { transform: async (edit: any) => { edit({ add: (value: any) => { if (value.name === 'relay') command = value } }); return { dispose: async () => {} } } }, tool: { transform: async () => ({ dispose: async () => {} }) },
    session: { get: async () => ({ ...(mode === 'no-session-model' ? {} : { model: { providerID: 'test', id: 'original' } }), tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 0 } } }), switchModel: async ({ model }: any) => { events.push(`switch:${model.id}`); if (mode === 'switch-failure') throw Error('switch failed') }, prompt: async () => { events.push('prompt') } },
  } as unknown as Plugin.Context
  if (mode === 'create-failure') t.mock.method(store, 'create', async () => { throw Error('create failed') })
  await registerPlanner(ctx, { store, snapshot: record => record, changed: work => work, validateSession: async () => {}, cleanTitle: promptTitle, isWorker: () => false, pending: () => false, model: mode === 'no-model' ? undefined : model, requestPlan: async () => { throw Error('unused') } })
  const work = command.execute({ sessionID: 'parent', prompt: { text: 'Task' } })
  if (mode === 'create-failure') {
    await assert.rejects(work, /create failed/)
    assert.equal((await store.list()).length, 0)
    assert.deepEqual(events, ['switch:planner', 'switch:original'])
  } else {
    await work
    assert.deepEqual(events, ['no-model', 'no-session-model'].includes(mode) ? ['prompt'] : ['switch:planner', 'prompt'])
    const tracking = (await store.list())[0].plannerSession!
    assert.equal(tracking.model?.id, mode === 'no-session-model' ? undefined : mode === 'valid' ? 'planner' : 'original')
    assert.equal(tracking.previousModel?.id, mode === 'no-session-model' ? undefined : 'original'); assert.equal(tracking.tokensAtStart.input, 1)
    if (mode === 'no-session-model') assert.ok(tracking.restoredAt)
    assert.equal((await store.list()).length, 1)
  }
})
for (const mode of ['success', 'missing', 'abort', 'timeout']) test(`explorer ${mode}: read-only child, bounded wait and tokens`, async t => {
  if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = createStore(memoryStorage(), { directory: '/project', projectID: 'project' }); const record = await store.create('Explore', 'parent')
  const tools = new Map<string, any>(); const children: any[] = []; const prompts: any[] = []; const interrupted: string[] = []; const controller = new AbortController()
  let explorerCommand: any
  const ctx = { command: { transform: async (edit: any) => { edit({ add: (value: any) => { explorerCommand = value } }); return { dispose: async () => {} } } }, tool: { transform: async (edit: any) => { edit({ add: (value: any) => tools.set(value.name, value) }); return { dispose: async () => {} } } },
    session: { create: async (input: any) => { children.push(input); return { id: 'explorer-child' } }, prompt: async (input: any) => { prompts.push(input) }, wait: async () => { if (mode !== 'success') await new Promise(() => {}) }, context: async () => [{ type: 'assistant', content: [{ type: 'text', text: 'old answer' }] }, { type: 'assistant', content: [{ type: 'text', text: 'x'.repeat(8100) }] }], get: async () => ({ tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } } }), interrupt: async ({ sessionID }: any) => { interrupted.push(sessionID) } },
  } as unknown as Plugin.Context
  await registerPlanner(ctx, { store, snapshot: record => record, changed: work => work, validateSession: async () => {}, cleanTitle: promptTitle, isWorker: id => id === 'worker', pending: () => false, explorer: mode === 'missing' ? undefined : { providerID: 'test', id: 'explore' }, requestPlan: async () => record })
  const invoke = (name: string, sessionID = 'parent') => tools.get(name).execute({ question: 'Investigate read-only' }, { sessionID, signal: controller.signal })
  await assert.rejects(invoke('relay_explore', 'worker'), /workers and probes/)
  const work = invoke('relay_explore')
  if (mode === 'missing') { await assert.rejects(work, /No explorer model configured/); assert.equal(children.length, 0); return }
  await tick()
  assert.equal(children[0].parentID, 'parent'); assert.deepEqual(children[0].model, { providerID: 'test', id: 'explore' }); assert.equal(children[0].location.directory, '/project')
  for (const name of ['edit', 'write', 'shell', 'subagent', 'question', 'relay.approve', 'relay.signoff', 'relay.verify', ...plannerTools, 'relay_report']) assert.ok(children[0].permissions.some((rule: any) => rule.action === name && rule.resource === '*' && rule.effect === 'deny'))
  assert.ok(children[0].permissions.some((rule: any) => rule.action === 'shell' && rule.resource === '*opencode*'))
  for (const name of plannerTools) await assert.rejects(invoke(name, 'explorer-child'), /including explorers/)
  await assert.rejects(explorerCommand.execute({ sessionID: 'explorer-child', prompt: { text: 'Must not create' } }), /workers and probes/)
  if (mode === 'abort') controller.abort()
  if (mode === 'timeout') t.mock.timers.tick(600000)
  if (mode === 'success') {
    const result = await work; assert.equal(result.content.split('\n\nTokens:')[0].length, 8000); assert.match(result.content, /\(truncated\)/); assert.match(result.content, /Tokens: input 10, output 20, reasoning 3, cache read 4, cache write 5/); assert.match(prompts[0].text, /read-only/)
    assert.deepEqual(interrupted, [])
  } else { await assert.rejects(work, mode === 'abort' ? /Explorer interrupted/ : /timed out after 10 minutes/); assert.deepEqual(interrupted, ['explorer-child']) }
})
for (const stage of ['prompt', 'wait', 'context', 'get']) test(`explorer ${stage} failure interrupts the child without leaking errors`, async t => {
  t.mock.method(console, 'error', () => {})
  const store = createStore(memoryStorage(), { directory: '/project', projectID: 'project' }); const record = await store.create('Explore', 'parent')
  let tool: any; const interrupted: string[] = []
  const ctx = { command: { transform: async () => ({ dispose: async () => {} }) }, tool: { transform: async (edit: any) => { edit({ add: (value: any) => { if (value.name === 'relay_explore') tool = value } }); return { dispose: async () => {} } } }, session: {
    create: async () => ({ id: 'explorer-failure' }), prompt: async () => { if (stage === 'prompt') throw Error('private transport details') }, wait: async () => { if (stage === 'wait') throw Error('private wait details') }, context: async () => { if (stage === 'context') throw Error('private context details'); return [{ type: 'assistant', content: [{ type: 'text', text: 'Answer' }] }] }, get: async () => { throw Error('private token details') }, interrupt: async ({ sessionID }: any) => { interrupted.push(sessionID) },
  } } as unknown as Plugin.Context
  await registerPlanner(ctx, { store, snapshot: record => record, changed: work => work, validateSession: async () => {}, cleanTitle: promptTitle, isWorker: () => false, pending: () => false, explorer: { providerID: 'test', id: 'explore' }, requestPlan: async () => record })
  await assert.rejects(tool.execute({ question: 'Read only' }, { sessionID: 'parent', signal: new AbortController().signal }), /Explorer could not complete\. Inspect its child session before retrying\./)
  assert.deepEqual(interrupted, ['explorer-failure'])
})
async function harness(staleStart = false, plannerModel = false, restoreFailure = false, roles?: Record<string, unknown>) {
  const storage = memoryStorage(); const tools = new Map<string, any>(); const prompts: any[] = []; const created: any[] = []
  const switches: string[] = []
  const permissions: any[] = []; const commands = new Map<string, any>(); const events: any[] = []
  let command: any; let handlers: any; let allow!: () => void; let reject!: (error: object) => void
  let approvedReads = 0
  const ctx = { storage: { ...storage, get: async (key: string) => {
    const value = await storage.get(key) as any
    if (staleStart && value?.phase === 'approved' && ++approvedReads === 2) { value.revision++; await storage.set(key, value) }
    return value
  } }, options: { enableProbe: true, roles: roles ?? { builder: { providerID: 'test', id: 'build' }, reviewer: { providerID: 'test', id: 'review' }, ...(plannerModel ? { planner: { providerID: 'test', id: 'planner' } } : {}) } }, location: { directory: '/project', project: { id: 'project' } },
    command: { transform: async (edit: any) => { edit({ add: (value: any) => { commands.set(value.name, value); if (value.name === 'relay') command = value } }); return { dispose: async () => {} } } },
    tool: { transform: async (edit: any) => { edit({ add: (value: any) => tools.set(value.name, value) }); return { dispose: async () => {} } } },
    permission: { hook: async () => ({ dispose: async () => {} }), list: async () => [], reply: async () => {}, assert: async () => new Promise<void>((resolve, fail) => { allow = resolve; reject = fail }) },
    rpc: { register: async (_: unknown, value: any) => { handlers = value; return { dispose: async () => {}, events: { emit: async (_: string, event: any) => { events.push(event) } } } } },
    model: { list: async () => ({ data: [{ id: 'build', name: 'Build', providerID: 'test', status: 'active', capabilities: { tools: true, input: ['text', 'image'] }, limit: { context: 1000 }, variants: [] }] }) },
    session: { update: async (input: any) => { if (input.permissions) permissions.splice(0, permissions.length, ...input.permissions) }, get: async () => ({ projectID: 'project', location: { directory: '/project' }, permissions: structuredClone(permissions), model: { providerID: 'test', id: 'original' }, tokens: { input: prompts.length * 10, output: prompts.length * 2, reasoning: 0, cache: { read: prompts.length * 3, write: 0 } } }), switchModel: async ({ model }: any) => { switches.push(model.id); if (restoreFailure && model.id === 'original') throw Error('restore failed') }, prompt: async (input: any) => { prompts.push(input) }, create: async (input: any) => { const id = `child-${created.length}`; created.push({ ...input, id }); return { id } }, wait: async () => new Promise(() => {}), interrupt: async () => {} },
  } as unknown as Plugin.Context
  const dispose = await setup(ctx)
  const context = { error: (type: string, message: string) => ({ type, message }) }
  const store = createStore(storage, { directory: '/project', projectID: 'project' })
  return { ctx, storage, commands, permissions, events, dispose, store, tools, prompts, created, switches, command: () => command, call: (name: string, input: object) => handlers[name](input, context), invoke: (name: string, input = {}, sessionID = 'parent') => tools.get(name).execute(input, { sessionID }), allow: () => allow(), reject: () => reject({ _tag: 'Permission.DeclinedError' }) }
}
test('configure command facts and permission denial preserve storage; allow round-trips global JSON', async t => {
  const h = await harness()
  const list = h.ctx.model.list
  t.mock.method(h.ctx.model, 'list', async () => {
    const result = await list({})
    return { ...result, data: [...result.data, { ...result.data[0], id: 'text-model', name: 'Text model', capabilities: { ...result.data[0].capabilities, input: ['text'] } }] }
  })
  const updates: any[] = []
  t.mock.method(h.ctx.session, 'update', async (input: any) => { updates.push(input) })
  await h.commands.get('relay-configure').execute({ sessionID: 'parent', prompt: { text: '' } })
  assert.match(h.prompts[0].text, /question tool once with all 10 questions batched together in its questions array \(4 jobs \+ 6 settings\)/)
  assert.match(h.prompts[0].text, /planner, builder, reviewer \(image yes only\), explorer/)
  assert.match(h.prompts[0].text, /brainstorm before drafting on\/off/)
  assert.match(h.prompts[0].text, /top 3 candidates.*\(Recommended\).*automatic write-in/)
  assert.equal(h.prompts[0].text.split('test/build |').length - 1, 1)
  assert.equal(h.prompts[0].text.split('test/text-model |').length - 1, 1)
  assert.match(h.prompts[0].text, /test\/build \|.*image yes/)
  assert.match(h.prompts[0].text, /test\/text-model \|.*image no/)
  assert.match(h.prompts[0].text, /Reviewer requires image yes\./)
  assert.match(h.prompts[0].text, /test\/build.*context 1000/)
  const denied = h.invoke('relay_config_set', { widths: [390], explorer: false })
  await tick(); h.reject(); await assert.rejects(denied, /Settings not saved: permission was denied\./)
  assert.equal(await h.storage.get('relay/config'), undefined)
  assert.deepEqual(updates[0].permissions, [{ action: 'shell', resource: '*opencode*', effect: 'deny' }])
  assert.deepEqual(updates[1].permissions, [])
  const accepted = h.invoke('relay_config_set', { widths: [390], explorer: false, autoStart: false, brainstormFirst: false })
  await tick(); h.allow(); await accepted
  const saved = await h.storage.get('relay/config') as any
  assert.equal(saved.version, 1); assert.deepEqual(saved.widths, [390]); assert.equal(saved.autoStart, false); assert.equal(saved.brainstormFirst, false)
  const report = await h.call('validateConfig', {})
  assert.match(report.source, /^saved /); assert.match(report.summary, /auto-start off/); assert.match(report.summary, /brainstorm off/); assert.equal(report.brainstormFirst, false)
})
test('configure prompt explicitly reports empty and text-only reviewer availability', async t => {
  const h = await harness()
  const list = h.ctx.model.list
  const textOnly = t.mock.method(h.ctx.model, 'list', async () => {
    const result = await list({})
    return { ...result, data: result.data.map(model => ({ ...model, capabilities: { ...model.capabilities, input: ['text'] } })) }
  })
  await h.commands.get('relay-configure').execute({ sessionID: 'parent', prompt: { text: '' } })
  assert.match(h.prompts[0].text, /image no/)
  assert.match(h.prompts[0].text, /No image-capable models are available for reviewer\./)
  textOnly.mock.restore()
  t.mock.method(h.ctx.model, 'list', async () => ({ data: [] }))
  await h.commands.get('relay-configure').execute({ sessionID: 'parent', prompt: { text: '' } })
  assert.match(h.prompts[1].text, /Available models\n\(none\)/)
})
test('saved planner model and autoStart false take effect without restart', async () => {
  const h = await harness()
  await h.storage.set('relay/config', { version: 1, roles: { planner: { providerID: 'test', id: 'changed' } }, autoStart: false, updatedAt: 'now' })
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'New model' } })
  assert.deepEqual(h.switches, ['changed'])
  assert.match(h.prompts[0].text, /Approval saves the plan without starting work/)
  assert.doesNotMatch(h.prompts[0].text, /start the approved tasks automatically/)
  await h.invoke('relay_plan_add', { tasks: ['No automatic builder'] })
  await h.invoke('relay_plan_submit'); await tick(); h.allow(); await tick(); await tick()
  assert.equal((await h.store.list())[0].phase, 'approved'); assert.equal(h.created.length, 0)
  const status = (await h.invoke('relay_status')).content
  assert.match(status, /planner: test\/changed/); assert.match(status, /saved now/)
  assert.match(status, /Choose Start in the panel or TUI/)
})
test('orchestrator reads changed saved builder model at launch without restart', async () => {
  const h = await harness()
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Live config models' } })
  await h.invoke('relay_plan_add', { tasks: ['Launch changed builder'] })
  await h.storage.set('relay/config', { version: 1, roles: { builder: { providerID: 'test', id: 'new-builder' } }, updatedAt: 'now' })
  await h.invoke('relay_plan_submit'); await tick(); h.allow(); await tick(); await tick()
  assert.equal(h.created[0].model.id, 'new-builder')
})
test('active-record lockdown adds only shell deny and removes it on terminal', async t => {
  const h = await harness()
  const updates: any[] = []
  t.mock.method(h.ctx.session, 'update', async (input: any) => { updates.push(input) })
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Lock' } })
  assert.deepEqual(updates[0].permissions, [{ action: 'shell', resource: '*opencode*', effect: 'deny' }])
  const record = (await h.store.list())[0]
  await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel' } })
  assert.deepEqual(updates.at(-1).permissions, [])
})
test('persisted lockdown ownership removes a lock after plugin reload', async t => {
  const h = await harness()
  await h.storage.set('relay/lockdown/parent', { owned: true })
  const updates: any[] = []
  t.mock.method(h.ctx.session, 'update', async (input: any) => { updates.push(input) })
  const record = await h.store.create('Existing draft', 'parent')
  await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel' } })
  assert.deepEqual(updates.at(-1).permissions, [])
  assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
})
for (const userDeny of [false, true]) test(`lockdown preserves existing and newly added user rules; matching user deny=${userDeny}`, async () => {
  const h = await harness()
  const original = { action: 'edit', resource: 'keep/*', effect: 'ask' }
  const matching = { action: 'shell', resource: '*opencode*', effect: 'deny' }
  h.permissions.push(original, ...(userDeny ? [matching] : []))
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Preserve rules' } })
  assert.equal(Boolean(await h.storage.get('relay/lockdown/parent')), !userDeny)
  const added = { action: 'write', resource: 'later/*', effect: 'deny' }
  h.permissions.push(added)
  const record = (await h.store.list())[0]
  await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel' } })
  assert.deepEqual(h.permissions, [original, ...(userDeny ? [matching] : []), added])
})
for (const mode of ['update', 'gone']) test(`lockdown ${mode} failure does not block mutations, events or pending cleanup`, async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness()
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Failure isolation' } })
  await h.invoke('relay_plan_add', { tasks: ['Pending test'] })
  await h.invoke('relay_plan_submit'); await tick()
  const record = (await h.store.list())[0]
  if (mode === 'update') t.mock.method(h.ctx.session, 'update', async () => { throw Error('update failed') })
  else t.mock.method(h.ctx.session, 'get', async () => { throw { _tag: 'SessionNotFoundError' } })
  const before = h.events.length
  const result = await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel' } })
  assert.equal(result.phase, 'cancelled'); assert.ok(h.events.length > before)
  h.reject(); await tick()
  assert.equal((await h.call('getSnapshot', { recordID: record.id })).pendingApproval, undefined)
  if (mode === 'gone') assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
})
test('failed lockdown acquisition does not block creation or emit', async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness()
  t.mock.method(h.ctx.session, 'update', async () => { throw Error('update failed') })
  const record = await h.call('createRecord', { title: 'Still saved', sessionID: 'parent' })
  assert.equal(record.phase, 'draft'); assert.equal(h.events.at(-1).recordID, record.id)
})
test('failed acquire leaves no ownership and the next changed event retries the lock', async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness()
  const update = h.ctx.session.update; let calls = 0
  t.mock.method(h.ctx.session, 'update', async (input: Parameters<typeof update>[0]) => {
    if (++calls === 1) throw Error('acquire failed')
    await update(input)
  })
  const record = await h.call('createRecord', { title: 'Retry lock', sessionID: 'parent' })
  assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
  assert.deepEqual(h.permissions, [])
  await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'addTask', title: 'Retry acquisition' } })
  assert.equal(calls, 2)
  assert.deepEqual(await h.storage.get('relay/lockdown/parent'), { owned: true })
  assert.deepEqual(h.permissions, [{ action: 'shell', resource: '*opencode*', effect: 'deny' }])
})
test('user matching deny added after a failed acquire survives release', async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness()
  const mock = t.mock.method(h.ctx.session, 'update', async () => { throw Error('acquire failed') })
  const record = await h.call('createRecord', { title: 'User deny', sessionID: 'parent' })
  assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
  mock.mock.restore()
  const deny = { action: 'shell', resource: '*opencode*', effect: 'deny' }
  h.permissions.push(deny)
  const changed = await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'addTask', title: 'Observe user rule' } })
  assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
  await h.call('mutate', { recordID: record.id, expectedRevision: changed.revision, op: { type: 'cancel' } })
  assert.deepEqual(h.permissions, [deny])
  assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
})
test('configure denial is not masked by failed unlock and double configure is rejected', async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness()
  const request = h.invoke('relay_config_set', { widths: [390] })
  await tick()
  await assert.rejects(h.invoke('relay_config_set', { widths: [1280] }), /already pending/)
  t.mock.method(h.ctx.session, 'update', async () => { throw Error('unlock failed') })
  h.reject(); await assert.rejects(request, /Settings not saved: permission was denied\./)
  assert.equal(await h.storage.get('relay/config'), undefined)
})
test('stale configure approval cannot overwrite a newer config; updatedAt is stamped after approval', async t => {
  const h = await harness()
  const first = h.invoke('relay_config_set', { widths: [390] }); await tick()
  const newer = { version: 1, widths: [1280], updatedAt: 'newer' }
  await h.storage.set('relay/config', newer)
  h.allow(); await assert.rejects(first, /changed while approval was pending/)
  assert.deepEqual(await h.storage.get('relay/config'), newer)
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const second = h.invoke('relay_config_set', { widths: [390] }); await tick()
  t.mock.timers.tick(5000); h.allow(); await second
  assert.equal((await h.storage.get('relay/config') as any).updatedAt, new Date(6000).toISOString())
})
test('worker cannot run configure command; explorer false returns a readable disabled error', async () => {
  const h = await harness()
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Worker guard' } })
  await h.invoke('relay_plan_add', { tasks: ['Task'] }); await h.invoke('relay_plan_submit')
  await tick(); h.allow(); await tick(); await tick()
  await assert.rejects(h.commands.get('relay-configure').execute({ sessionID: h.created[0].id, prompt: { text: '' } }), /workers and probes/)
  await h.storage.set('relay/config', { version: 1, explorer: false, updatedAt: 'now' })
  await assert.rejects(h.invoke('relay_explore', { question: 'Read' }), /explorer is disabled/)
})
test('restart reconciliation releases an owned lock on an already completed record', async () => {
  const h = await harness()
  const record = await h.store.create('Restart terminal', 'parent')
  await h.store.write(record.id, record.revision, current => { current.phase = 'completed' })
  h.permissions.push({ action: 'shell', resource: '*opencode*', effect: 'deny' })
  await h.storage.set('relay/lockdown/parent', { owned: true })
  await h.dispose()
  await setup(h.ctx)
  assert.deepEqual(h.permissions, [])
  assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
})
test('prompt failure restores through the shared lifecycle once and retains a readable draft error', async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness(false, true)
  t.mock.method(h.ctx.session, 'prompt', async () => { throw Error('private transport failure') })
  await assert.rejects(h.command().execute({ sessionID: 'parent', prompt: { text: 'Fail prompt' } }), /Could not start the Relay planner.*draft was retained/)
  const record = (await h.store.list())[0]
  assert.ok(record.plannerSession!.restoredAt)
  await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel' } })
  assert.deepEqual(h.switches, ['planner', 'original'])
})
test('concurrent prompt failure and cancellation restore exactly once', async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness(false, true)
  let release!: () => void
  const switchModel = h.ctx.session.switchModel
  t.mock.method(h.ctx.session, 'switchModel', async (input: Parameters<typeof switchModel>[0]) => { await switchModel(input); if (input.model.id === 'original') await new Promise<void>(resolve => { release = resolve }) })
  t.mock.method(h.ctx.session, 'prompt', async () => { throw Error('prompt failed') })
  const command = assert.rejects(h.command().execute({ sessionID: 'parent', prompt: { text: 'Concurrent restore' } }), /Could not start/)
  await tick()
  const record = (await h.store.list())[0]
  const cancelled = h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel' } })
  await tick(); release(); await Promise.all([command, cancelled])
  assert.deepEqual(h.switches, ['planner', 'original'])
})
for (const mode of ['reject', 'timeout']) test(`terminal planner token capture ${mode} renders unavailable`, async t => {
  t.mock.method(console, 'error', () => {})
  const h = await harness(false, true)
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Token failure' } })
  const record = (await h.store.list())[0]
  const get = h.ctx.session.get; let reads = 0
  t.mock.method(h.ctx.session, 'get', async (input: Parameters<typeof get>[0]) => { if (++reads > 1) return get(input); if (mode === 'reject') throw Error('get failed'); return await new Promise<never>(() => {}) })
  if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
  const closing = h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel' } })
  await tick()
  if (mode === 'timeout') t.mock.timers.tick(10000)
  await closing
  const end = await h.store.get(record.id)
  assert.equal(end.plannerSession!.tokensAtEnd, undefined)
  assert.equal(plannerTokensMessage(end), 'Planner session tokens: unavailable')
})
for (const submit of [false, true]) for (const fail of [false, true]) test(`planner restores once on ${submit ? 'submit then cancel' : 'draft cancel'}, failure=${fail}`, async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const h = await harness(false, true, fail)
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Track planner' } })
  assert.deepEqual(h.switches, ['planner'])
  if (submit) {
    await h.invoke('relay_plan_add', { tasks: ['Task'] })
    await h.invoke('relay_plan_submit')
    assert.deepEqual(h.switches, ['planner', 'original'])
  }
  const before = (await h.store.list())[0]
  await h.call('mutate', { recordID: before.id, expectedRevision: before.revision, op: { type: 'cancel' } })
  if (submit) { h.reject(); await tick() }
  const end = await h.store.get(before.id)
  assert.equal(end.phase, 'cancelled'); assert.ok(end.plannerSession!.restoredAt)
  assert.equal(end.plannerSession!.tokensAtEnd!.input, 10)
  assert.deepEqual(h.switches, ['planner', 'original'])
  if (fail) assert.ok(errors.mock.calls.some(call => call.arguments[0] === 'Relay planner model restore failed'))
})
test('completed sign-off captures planner tokens and restores once', async () => {
  const h = await harness(false, true)
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Complete planner tracking' } })
  let record = (await h.store.list())[0]
  record = await h.store.write(record.id, record.revision, current => {
    current.phase = 'running'
    current.tasks = [{ id: 'task', title: 'Done', status: 'completed', fixCycles: 0, updatedAt: current.updatedAt }]
    current.approvals = [{ kind: 'plan', revision: current.revision, planRevision: current.planRevision, approvedAt: current.updatedAt, source: 'permission-assert' }]
  })
  const closing = h.call('signOff', { recordID: record.id, expectedRevision: record.revision })
  await tick(); h.allow(); await closing
  const completed = await h.store.get(record.id)
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.plannerSession!.tokensAtEnd!.input, 10)
  assert.deepEqual(h.permissions, [])
  assert.equal(await h.storage.get('relay/lockdown/parent'), undefined)
  assert.deepEqual(h.switches, ['planner', 'original'])
})
test('relay command binds a cleaned capped record and delivers planner instructions; duplicate rejected', async () => {
  const h = await harness()
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'A\n\u202e' + 'x'.repeat(600) }, delivery: 'next' })
  assert.ok(h.prompts[0].text.includes('A\n\u202e' + 'x'.repeat(600)))
  const record = (await h.store.list())[0]
  assert.equal(record.sessionID, 'parent'); assert.equal(Array.from(record.title).length, 500); assert.doesNotMatch(record.title, /[\n\u202e]/)
  assert.equal(h.prompts.length, 1); assert.equal(h.prompts[0].sessionID, 'parent'); assert.match(h.prompts[0].text, /relay_plan_add/); assert.match(h.prompts[0].text, /relay_plan_submit/); assert.match(h.prompts[0].text, /Do not edit files/)
  await assert.rejects(h.command().execute({ sessionID: 'parent', prompt: { text: 'Duplicate' } }), /already owns an active/)
  assert.equal((await h.store.list()).length, 1)
})
test('planner adds valid tasks/checks, rejects invalid check before writes and enforces draft and pending', async () => {
  const h = await harness(); await h.command().execute({ sessionID: 'parent', prompt: { text: 'Task' } })
  const check = { name: 'Tests', command: 'npm test', adapter: 'command', policy: 'automated-required' }
  await assert.rejects(h.invoke('relay_plan_add', { tasks: ['No partial invalid check'], checks: [{ ...check, command: 'bad\ncommand' }] }), /Invalid check "Tests".*Control and format characters/)
  assert.equal((await h.store.list())[0].tasks.length, 0)
  await h.invoke('relay_plan_add', { tasks: ['Build'], checks: [check] })
  let record = (await h.store.list())[0]
  assert.equal(record.tasks.length, 1); assert.equal(record.checks.length, 1); assert.ok(record.checks[0].id)
  await assert.rejects(h.invoke('relay_plan_add', { checks: [check] }), /Duplicate check name: Tests/)
  const pending = await h.invoke('relay_plan_submit'); await tick(); assert.match(pending.content, /Waiting for approval/)
  assert.match((await h.invoke('relay_status')).content, /Waiting for approval/)
  await assert.rejects(h.invoke('relay_plan_add', { tasks: ['Blocked'] }), /already waiting/)
  await h.call('withdrawApproval', { recordID: record.id, key: `${record.id}@${record.revision}` }); h.reject(); await tick()
  assert.match((await h.invoke('relay_status')).content, /Approval request withdrawn/)
  record = await h.store.approve(record.id, record.revision, async () => {})
  await assert.rejects(h.invoke('relay_plan_add', { tasks: ['Approved blocked'] }), /not available/)
})
test('submit starts and launches builder only on approved settlement', async t => {
  t.mock.method(console, 'error', () => {})
  for (const outcome of ['approved', 'rejected', 'withdrawn', 'stale']) {
    const h = await harness(); await h.command().execute({ sessionID: 'parent', prompt: { text: outcome } }); await h.invoke('relay_plan_add', { tasks: ['Build'] })
    const record = (await h.store.list())[0]
    await h.invoke('relay_plan_submit'); await tick()
    if (outcome === 'withdrawn') await h.call('withdrawApproval', { recordID: record.id, key: `${record.id}@${record.revision}` })
    if (outcome === 'stale') await h.store.mutate(record.id, record.revision, { type: 'addTask', title: 'External plan change' })
    if (outcome === 'rejected') h.reject(); else h.allow()
    await tick(); await tick()
    const snapshot = await h.call('getSnapshot', { recordID: record.id })
    assert.equal(snapshot.approvalResult.outcome, outcome)
    assert.equal(h.created.length, outcome === 'approved' ? 1 : 0)
    if (outcome === 'approved') {
      assert.equal(snapshot.phase, 'running')
      for (const name of plannerTools) { assert.ok(h.created[0].permissions.some((rule: any) => rule.action === name && rule.effect === 'deny')); await assert.rejects(h.invoke(name, {}, h.created[0].id), /workers and probes/) }
    } else assert.equal(snapshot.phase, 'draft')
  }
})
test('worker probe structurally cannot call any planner tool', async () => {
  const h = await harness()
  await h.call('probeWorkerSession', { parentSessionID: 'parent', model: { id: 'build', providerID: 'test' } })
  for (const name of plannerTools) await assert.rejects(h.invoke(name, {}, h.created[0].id), /workers and probes/)
  await assert.rejects(h.command().execute({ sessionID: h.created[0].id, prompt: { text: 'Worker command' } }), /workers and probes/)
})
test('empty relay input and submitting an empty plan are readable errors', async () => {
  const h = await harness()
  await assert.rejects(h.command().execute({ sessionID: 'parent', prompt: { text: ' \n\t ' } }), /nonempty task description/)
  assert.equal((await h.store.list()).length, 0)
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Empty plan' } })
  await assert.rejects(h.invoke('relay_plan_submit'), /Add at least one task before submitting/)
})
test('planner tools select the newest active session record', async () => {
  const h = await harness()
  const older = await h.store.create('Older', 'parent'); const newer = await h.store.create('Newest', 'parent')
  await h.store.write(older.id, older.revision, record => { record.createdAt = '2026-01-01T00:00:00Z' })
  await h.store.write(newer.id, newer.revision, record => { record.createdAt = '2026-02-01T00:00:00Z' })
  await h.invoke('relay_plan_add', { tasks: ['Only newest'] })
  assert.equal((await h.store.get(older.id)).tasks.length, 0); assert.equal((await h.store.get(newer.id)).tasks.length, 1)
  assert.match((await h.invoke('relay_status')).content, /\nNewest\n/)
})
test('autoStart stale revision logs failure but retains approved result for manual start', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  const h = await harness(true)
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Stale start' } }); await h.invoke('relay_plan_add', { tasks: ['Build'] })
  const record = (await h.store.list())[0]
  await h.invoke('relay_plan_submit'); await tick(); h.allow(); await tick(); await tick()
  const snapshot = await h.call('getSnapshot', { recordID: record.id })
  assert.equal(snapshot.phase, 'approved'); assert.equal(snapshot.approvalResult.outcome, 'approved'); assert.equal(snapshot.approvals.length, 1); assert.equal(h.created.length, 0)
  assert.ok(logs.mock.calls.some(call => String(call.arguments[0]).includes('could not auto-start') && (call.arguments[2] as StoreError).code === 'stale_revision'))
})
test('planner task and check limits explain how to correct input', async () => {
  const h = await harness(); await h.command().execute({ sessionID: 'parent', prompt: { text: 'Limits' } })
  let record = (await h.store.list())[0]
  record = await h.store.write(record.id, record.revision, current => {
    current.tasks = Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, title: 'Task', status: 'pending', fixCycles: 0, updatedAt: current.updatedAt }))
    current.checks = Array.from({ length: 20 }, (_, index) => ({ id: `check-${index}`, name: `Check ${index}`, command: 'npm test', adapter: 'command', policy: 'automated-required' }))
  })
  await assert.rejects(h.invoke('relay_plan_add', { tasks: ['Extra'] }), /Task limit \(200\) reached/)
  await assert.rejects(h.invoke('relay_plan_add', { checks: [{ name: 'Extra', command: 'npm test', adapter: 'command', policy: 'automated-required' }] }), /Check limit \(20\) reached/)
})
test('planner tools reject both worker and image-probe identities before record lookup', async () => {
  const tools = new Map<string, any>(); const store = createStore(memoryStorage(), { directory: '/project', projectID: 'project' })
  const ctx = { command: { transform: async () => ({ dispose: async () => {} }) }, tool: { transform: async (edit: any) => { edit({ add: (value: any) => tools.set(value.name, value) }); return { dispose: async () => {} } } } } as unknown as Plugin.Context
  await registerPlanner(ctx, { store, snapshot: record => record, changed: work => work, validateSession: async () => { assert.fail('Worker must be rejected before validation') }, cleanTitle: promptTitle, isWorker: id => ['worker', 'image-probe'].includes(id), pending: () => false, requestPlan: async () => { throw Error('Must not submit') } })
  for (const sessionID of ['worker', 'image-probe']) for (const name of plannerTools) await assert.rejects(tools.get(name).execute({}, { sessionID }), /workers and probes/)
})
test('plan add retries stale revision once and never retries other failures', async () => {
  const storage = memoryStorage(); const store = createStore(storage, { directory: '/project', projectID: 'project' }); const record = await store.create('Retry', 'parent')
  const tools = new Map<string, any>(); let calls = 0
  const ctx = { command: { transform: async () => ({ dispose: async () => {} }) }, tool: { transform: async (edit: any) => { edit({ add: (value: any) => tools.set(value.name, value) }); return { dispose: async () => {} } } } } as unknown as Plugin.Context
  await registerPlanner(ctx, { store: { ...store, mutate: async (...args: Parameters<typeof store.mutate>) => { calls++; if (calls === 1) { await store.mutate(record.id, 1, { type: 'addTask', title: 'Concurrent' }); throw new StoreError('stale_revision', 2) }; return store.mutate(...args) } }, snapshot: record => record, changed: work => work, validateSession: async () => {}, cleanTitle: promptTitle, isWorker: () => false, pending: () => false, requestPlan: async () => record })
  await tools.get('relay_plan_add').execute({ tasks: ['Retried'] }, { sessionID: 'parent' })
  assert.equal(calls, 2); assert.deepEqual((await store.get(record.id)).tasks.map(task => task.title), ['Concurrent', 'Retried'])
})
test('relay_plan_add accepts scoped task objects and rejects invalid allowedPaths before writing', async () => {
  const h = await harness()
  await h.command().execute({ sessionID: 'parent', prompt: { text: 'Scoped tasks' } })
  await assert.rejects(h.invoke('relay_plan_add', { tasks: ['Safe', { title: 'Bad', allowedPaths: ['../escape.ts'] }] }), /traverse parent directories/i)
  assert.equal((await h.store.list())[0].tasks.length, 0)
  await h.invoke('relay_plan_add', { tasks: ['Unscoped', { title: 'Scoped', allowedPaths: ['./src\\report.ts', 'test/*.ts'] }] })
  const tasks = (await h.store.list())[0].tasks
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].allowedPaths, undefined)
  assert.deepEqual(tasks[1].allowedPaths, ['src/report.ts', 'test/*.ts'])
})
test('/relay fails fast before creating a draft when builder or reviewer models are not configured', async () => {
  const empty = await harness(false, false, false, {})
  await assert.rejects(
    empty.command().execute({ sessionID: 'parent', prompt: { text: 'Ship feature' } }),
    /Relay models are not configured for: builder, reviewer\. Run \/relay-configure before running \/relay\./,
  )
  assert.equal((await empty.store.list()).length, 0)
  assert.deepEqual(empty.prompts, [])
  assert.deepEqual(empty.switches, [])
  const partial = await harness(false, false, false, { builder: { providerID: 'test', id: 'build' } })
  await assert.rejects(
    partial.command().execute({ sessionID: 'parent', prompt: { text: 'Ship feature' } }),
    /Relay models are not configured for: reviewer\. Run \/relay-configure before running \/relay\./,
  )
  assert.equal((await partial.store.list()).length, 0)
  assert.deepEqual(partial.prompts, [])
  const ready = await harness(false, false, false, { builder: { providerID: 'test', id: 'build' }, reviewer: { providerID: 'test', id: 'review' } })
  await ready.command().execute({ sessionID: 'parent', prompt: { text: 'Ship feature' } })
  assert.equal((await ready.store.list()).length, 1)
  assert.equal(ready.prompts.length, 1)
  assert.deepEqual(ready.switches, [])
})
