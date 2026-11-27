import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup as setupPlugin, evaluateApproval, approveAction, promptTitle } from '../src/server.ts'
import { memoryStorage } from './helpers.ts'
import type { Plugin } from '@opencode/plugin'
import { approvalMessage, failureMessage } from '../src/view.ts'
import { createStore } from '../src/store.ts'
import { RelayRpc } from '../src/rpc.ts'
const tick = () => new Promise(resolve => setImmediate(resolve))
test('exportReport validates stored location/id and writes only its named Markdown file', async t => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'm6-export-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const storage = memoryStorage(); let handlers: any
  const ctx = { storage, location: { directory, project: { id: 'project' } }, permission: { hook: async () => ({ dispose: async () => {} }) }, rpc: { register: async (_: unknown, value: any) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } } } as unknown as Plugin.Context
  await setup(ctx)
  const context = { error: (type: string, message: string) => ({ type, message }) }
  const record = await handlers.createRecord({ title: 'Export test' }, context)
  const result = await handlers.exportReport({ recordID: record.id }, context)
  assert.equal(result.name, `relay-${record.id.slice(0, 8)}.md`); assert.match(result.markdown, /# Export test/); assert.equal(result.path, undefined)
  const written = await handlers.exportReport({ recordID: record.id, write: true }, context)
  assert.equal(written.path, `.relay/reports/${result.name}`)
  assert.equal(await readFile(join(directory, written.path), 'utf8'), result.markdown)
  assert.equal((await handlers.exportReport({ recordID: record.id, write: true }, context)).path, written.path)
  await rm(join(directory, '.relay'), { recursive: true, force: true })
  await writeFile(join(directory, '.relay'), 'block directory creation')
  const failed = await handlers.exportReport({ recordID: record.id, write: true }, context)
  assert.equal(failed.message, 'Could not write report file.')
  assert.equal(failureMessage(failed), 'Could not write report file.')
  const key = [...storage.data.keys()].find(key => key.endsWith(record.id))!
  for (const location of [{ directory: '/other', projectID: 'project' }, { directory, projectID: 'other' }]) {
    storage.data.set(key, { ...record, location })
    assert.equal((await handlers.exportReport({ recordID: record.id }, context)).type, 'invalid_op')
  }
  storage.data.set(key, { ...record, id: '../bad!!' })
  assert.equal((await handlers.exportReport({ recordID: record.id, write: true }, context)).type, 'invalid_op')
})
test('withdraw before assert, after Allow while queued, and after host rejection never writes', async t => {
  t.mock.method(console, 'error', () => {})
  for (const mode of ['before', 'queue', 'reject', 'cancel', 'old-revision']) {
    const storage = memoryStorage(); let handlers: any; let calls = 0; let allow!: () => void; let reject!: (error: object) => void; let before = mode === 'before'
    const context = { error: (type: string, message: string) => ({ type, message }) }
    const ctx = { storage, location: { directory: '/project', project: { id: 'project' } }, session: { get: async () => ({ projectID: 'project', location: { directory: '/project' } }) },
      permission: { hook: async () => ({ dispose: async () => {} }), list: async () => [], reply: async () => {}, assert: async () => { calls++; await new Promise<void>((resolve, fail) => { allow = resolve; reject = fail }) } },
      rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async (_: string, event: any) => {
        if (before) { const snapshot = await handlers.getSnapshot({ recordID: event.recordID }, context); if (snapshot.pendingApproval) { before = false; await handlers.withdrawApproval({ recordID: event.recordID, key: snapshot.pendingApproval.key }, context) } }
      } } } } },
    } as unknown as Plugin.Context
    await setup(ctx)
    const record = await handlers.createRecord({ title: mode, sessionID: 'parent' }, context)
    await handlers.requestApproval({ recordID: record.id, expectedRevision: 1, kind: 'plan' }, context); await tick()
    if (mode === 'before') assert.equal(calls, 0)
    else {
      for (const op of [{ type: 'addTask', title: 'Blocked' }, { type: 'addCheck' }, { type: 'removeCheck', checkID: 'x' }, { type: 'assignTask', taskID: 'x', owner: { role: 'builder' } }, { type: 'setTaskStatus', taskID: 'x', status: 'completed' }]) assert.equal((await handlers.mutate({ recordID: record.id, expectedRevision: 1, op }, context)).type, 'approval_pending')
      let release!: () => void; let blocked: Promise<unknown> | undefined
      if (mode === 'queue') {
        const store = createStore(storage, { directory: '/project', projectID: 'project' }); const other = await store.create('Queue blocker')
        blocked = store.write(other.id, other.revision, async () => { await new Promise<void>(resolve => { release = resolve }) })
        await tick(); allow(); await tick()
      }
      if (mode === 'old-revision') {
        const store = createStore(storage, { directory: '/project', projectID: 'project' })
        await store.mutate(record.id, 1, { type: 'addTask', title: 'Out-of-band revision' })
      }
      if (mode === 'cancel') await handlers.mutate({ recordID: record.id, expectedRevision: 1, op: { type: 'cancel' } }, context)
      else await handlers.withdrawApproval({ recordID: record.id, key: `${record.id}@1` }, context)
      if (mode === 'queue') { release(); await blocked }
      else reject({ _tag: 'Permission.DeclinedError' })
      await tick()
    }
    const snapshot = await handlers.getSnapshot({ recordID: record.id }, context)
    assert.deepEqual(snapshot.approvals, []); assert.equal(snapshot.phase, mode === 'cancel' ? 'cancelled' : 'draft'); assert.equal(snapshot.approvalResult.outcome, 'withdrawn'); assert.equal(snapshot.approvalResult.revision, 1)
    if (mode !== 'cancel') {
      let updated = await handlers.mutate({ recordID: record.id, expectedRevision: snapshot.revision, op: { type: 'addTask', title: 'Editable after withdrawal' } }, context)
      const taskID = updated.tasks.at(-1).id
      updated = await handlers.mutate({ recordID: record.id, expectedRevision: updated.revision, op: { type: 'assignTask', taskID, owner: { role: 'builder' } } }, context)
      assert.equal(updated.tasks.at(-1).owner.role, 'builder')
      updated = await handlers.mutate({ recordID: record.id, expectedRevision: updated.revision, op: { type: 'setTaskStatus', taskID, status: 'completed' } }, context)
      assert.equal(updated.tasks.at(-1).status, 'completed')
    }
  }
})
test('withdraw matches host requests, ignores late Allow and isolates a fresh token', async t => {
  t.mock.method(console, 'error', () => {})
  const storage = memoryStorage(); let handlers: any; const allows: (() => void)[] = []; const replies: any[] = []; let requests: any[] = []; let listFails = false; let replyFails = false
  const ctx = { storage, location: { directory: '/project', project: { id: 'project' } },
    session: { get: async () => ({ projectID: 'project', location: { directory: '/project' } }) },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => new Promise<void>(resolve => allows.push(resolve)), list: async () => { if (listFails) throw Error('list unavailable'); return requests }, reply: async (input: any) => { replies.push(input); if (replyFails) throw Error('reply unavailable') } },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  const context = { error: (type: string, message: string) => ({ type, message }) }
  const record = await handlers.createRecord({ title: 'Withdraw', sessionID: 'parent' }, context)
  const other = await handlers.createRecord({ title: 'Other', sessionID: 'parent' }, context)
  const input = { recordID: record.id, expectedRevision: 1, kind: 'plan' }
  const waiting = await handlers.requestApproval(input, context)
  assert.equal(waiting.phase, 'draft'); assert.ok(waiting.pendingApproval); await tick()
  const key = waiting.pendingApproval.key
  assert.equal((await handlers.withdrawApproval({ recordID: record.id, key: 'unknown' }, context)).type, 'invalid_op')
  assert.equal((await handlers.withdrawApproval({ recordID: other.id, key }, context)).type, 'invalid_op')
  requests = [{ id: 'match', action: 'relay.approve', resources: [key] }, { id: 'wrong-action', action: 'edit', resources: [key] }, { id: 'wrong-resource', action: 'relay.approve', resources: ['other'] }, { id: 'extra-resource', action: 'relay.approve', resources: [key, 'other'] }]
  const withdrawn = await handlers.withdrawApproval({ recordID: record.id, key }, context)
  assert.equal(withdrawn.pendingApproval, undefined); assert.equal(withdrawn.approvalResult.outcome, 'withdrawn')
  assert.equal(approvalMessage(withdrawn), 'Approval request withdrawn')
  assert.deepEqual(replies, [{ sessionID: 'parent', requestID: 'match', decision: 'reject' }])
  await handlers.requestApproval(input, context); await tick()
  allows[0](); await tick()
  let snapshot = await handlers.getSnapshot({ recordID: record.id }, context)
  assert.equal(snapshot.phase, 'draft'); assert.deepEqual(snapshot.approvals, []); assert.ok(snapshot.pendingApproval)
  allows[1](); await tick()
  snapshot = await handlers.getSnapshot({ recordID: record.id }, context)
  assert.equal(snapshot.phase, 'approved'); assert.equal(snapshot.approvalResult.outcome, 'approved')
  for (const failure of ['list', 'reply']) {
    const next = await handlers.createRecord({ title: failure, sessionID: 'parent' }, context)
    const pending = await handlers.requestApproval({ ...input, recordID: next.id }, context); await tick()
    listFails = failure === 'list'; replyFails = failure === 'reply'
    requests = [{ id: 'match', action: 'relay.approve', resources: [pending.pendingApproval.key] }]
    assert.equal((await handlers.withdrawApproval({ recordID: next.id, key: pending.pendingApproval.key }, context)).approvalResult.outcome, 'withdrawn')
    allows.at(-1)!(); await tick()
    snapshot = await handlers.getSnapshot({ recordID: next.id }, context)
    assert.equal(snapshot.phase, 'draft'); assert.deepEqual(snapshot.approvals, []); assert.equal(snapshot.approvalResult.outcome, 'withdrawn')
  }
  const storedKey = [...storage.data.keys()].find(key => key.endsWith(other.id))!
  storage.data.set(storedKey, { ...other, checks: [{ id: 'legacy', name: 'Legacy', command: 'npm\ntest', adapter: 'command', policy: 'automated-required' }] })
  const invalid = await handlers.requestApproval({ ...input, recordID: other.id }, context)
  assert.equal(invalid.type, 'invalid_op')
  assert.equal(failureMessage(invalid), 'Check "Legacy" contains unsupported characters or settings; remove and re-add it.')
})
async function setup(ctx: Plugin.Context) {
  return setupPlugin({ ...ctx, session: { ...ctx.session, update: async () => {} }, command: { transform: async () => ({ dispose: async () => {} }) }, tool: { transform: async () => ({ dispose: async () => {} }) } } as unknown as Plugin.Context)
}
test('setup logs reconciliation errors and continues; non-draft approval never prompts', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  const storage = memoryStorage(); let handlers: any; let prompts = 0
  const ctx = { storage: { ...storage, scan: async () => { throw Error('scan unavailable') } }, options: {}, location: { directory: '/project', project: { id: 'project' } }, permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => { prompts++ } }, rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } } } as unknown as Plugin.Context
  await setup(ctx)
  assert.equal(logs.mock.callCount(), 2); assert.equal(logs.mock.calls[0].arguments[0], 'Relay startup reconciliation failed')
  assert.equal(logs.mock.calls[1].arguments[0], 'Relay lockdown reconciliation failed')
  const { createStore } = await import('../src/store.ts'); const store = createStore(storage, { directory: '/project', projectID: 'project' })
  let r = await store.create('Plan'); const key = [...storage.data.keys()][0]
  const context = { error: (type: string) => ({ type }) }
  for (const phase of ['approved', 'running', 'interrupted', 'completed', 'cancelled']) {
    storage.data.set(key, { ...r, phase })
    assert.equal((await handlers.requestApproval({ recordID: r.id, expectedRevision: r.revision, kind: 'plan', sessionID: 'parent' }, context)).type, 'invalid_op')
  }
  assert.equal(prompts, 0)
  logs.mock.restore()
})
test('setup reconciles running records and forwards configured limits to mutations', async () => {
  const { createStore } = await import('../src/store.ts')
  const storage = memoryStorage(); const location = { directory: '/project', projectID: 'project' }; const store = createStore(storage, location)
  let r = await store.create('Restart')
  for (const title of ['One', 'Two']) r = await store.mutate(r.id, r.revision, { type: 'addTask', title })
  for (const task of r.tasks) r = await store.mutate(r.id, r.revision, { type: 'assignTask', taskID: task.id, owner: { role: 'builder' } })
  r = await store.approve(r.id, r.revision, async () => {}); r = await store.mutate(r.id, r.revision, { type: 'start' })
  let handlers: any
  const ctx = { storage, options: { limits: { maxRunningTasks: 2, maxFixCycles: 0 } }, location: { directory: '/project', project: { id: 'project' } }, permission: { hook: async () => ({ dispose: async () => {} }) }, rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } } } as unknown as Plugin.Context
  await setup(ctx)
  const context = { error: (type: string) => ({ type }) }
  r = await handlers.getSnapshot({ recordID: r.id }, context)
  assert.equal(r.phase, 'interrupted'); assert.equal(r.interruptReason, 'server_restart')
  r = await handlers.mutate({ recordID: r.id, expectedRevision: r.revision, op: { type: 'resume' } }, context)
  assert.equal(r.phase, 'interrupted')
  assert.equal(r.interruptReason, 'escalated: builder model not configured')
})
test('RPC v2 schemas accept new operations and reject malformed or legacy shapes', async () => {
  function accepts(schema: any, value: any): boolean {
    if (schema.oneOf) return schema.oneOf.filter((item: any) => accepts(item, value)).length === 1
    if ('const' in schema && value !== schema.const) return false
    if (schema.enum && !schema.enum.includes(value)) return false
    if (schema.type === 'string') return typeof value === 'string' && Array.from(value).length >= (schema.minLength ?? 0) && Array.from(value).length <= (schema.maxLength ?? Infinity)
    if (schema.type === 'integer') return Number.isInteger(value) && value >= (schema.minimum ?? -Infinity)
    if (schema.type === 'array') return Array.isArray(value) && value.every(item => accepts(schema.items, item))
    if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) && schema.required.every((key: string) => key in value) && Object.entries(value).every(([key, item]) => key in schema.properties ? accepts(schema.properties[key], item) : schema.additionalProperties !== false)
    return true
  }
  const input = RelayRpc.methods.mutate.input
  assert.equal(accepts(RelayRpc.methods.exportReport.input, { recordID: 'record' }), true)
  assert.equal(accepts(RelayRpc.methods.exportReport.input, { recordID: 'record', write: true }), true)
  assert.equal(accepts(RelayRpc.methods.exportReport.input, { recordID: 'record', path: '/arbitrary' }), false)
  assert.equal(accepts(RelayRpc.methods.exportReport.output, { name: 'relay-abcd1234.md', markdown: '# Report', path: '.relay/reports/relay-abcd1234.md' }), true)
  const storedReview = (RelayRpc.methods.listRuns.output as any).items.properties.report.oneOf[1]
  assert.equal(accepts(storedReview, { verdict: 'approve', summary: 'Legacy review', findings: [] }), true)
  assert.equal(accepts(storedReview, { verdict: 'approve', summary: 'Current review', findings: [], inspected: ['page.png hash'] }), true)
  const check = { id: 'check', name: 'Test', adapter: 'command', command: 'npm test', policy: 'automated-required' }
  assert.equal(accepts(input, { recordID: 'record', expectedRevision: 1, op: { type: 'addCheck', check } }), true)
  assert.equal(accepts(input, { recordID: 'record', expectedRevision: 1, op: { type: 'addCheck', check: { ...check, command: 'x'.repeat(161) } } }), false)
  const outputCheck = (RelayRpc.methods.getSnapshot.output as any).properties.checks.items
  assert.equal(outputCheck.properties.command.maxLength, 1000)
  assert.equal(accepts(outputCheck, { ...check, command: 'x'.repeat(1000) }), true)
  assert.equal(accepts(input, { recordID: 'record', expectedRevision: 1, op: { type: 'removeCheck', checkID: 'check' } }), true)
  assert.equal(accepts(input, { recordID: 'record', expectedRevision: 1, op: { type: 'addCheck', check: { ...check, extra: true } } }), false)
  assert.equal(accepts(RelayRpc.methods.listEvidence.input, { id: 'record' }), true)
  assert.equal(accepts(RelayRpc.methods.listEvidence.input, { id: 'record', extra: true }), false)
  assert.equal(accepts(RelayRpc.methods.recordManual.input, { id: 'record', revision: 1, taskID: 'task', checkID: 'check', note: 'Checked' }), true)
  assert.equal(accepts(RelayRpc.methods.recordManual.input, { id: 'record', revision: 1, taskID: 'task', checkID: 'check', note: 'Checked', source: 'adapter' }), false)
  assert.ok('verification_incomplete' in RelayRpc.methods.signOff.errors)
  for (const op of [{ type: 'start' }, { type: 'resume' }, { type: 'complete' }, { type: 'cancel' }, { type: 'interrupt', reason: 'server_restart' }, { type: 'assignTask', taskID: 'task', owner: { role: 'builder', sessionID: 'worker' } }]) assert.equal(accepts(input, { recordID: 'record', expectedRevision: 1, op }), true)
  for (const op of [{ type: 'interrupt' }, { type: 'interrupt', reason: '' }, { type: 'interrupt', reason: 'x'.repeat(501) }, { type: 'start', reason: 'extra' }, { type: 'assignTask', taskID: 'task', owner: { role: 'unknown' } }, { type: 'assignTask', taskID: 'task', owner: { role: 'builder', extra: true } }]) assert.equal(accepts(input, { recordID: 'record', expectedRevision: 1, op }), false)
  const { createStore } = await import('../src/store.ts')
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('V2')
  for (const field of ['reason', 'cancelReason']) {
    assert.equal(accepts(input, { recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel', [field]: 'Injected cancellation reason' } }), false)
  }
  assert.equal(record.cancelReason, undefined)
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, record), true)
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, { ...record, cancelReason: 'Already done' }), true)
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, { ...record, cancelReason: 'x'.repeat(501) }), false)
  const model = { providerID: 'test', id: 'planner', variant: 'high' }
  const tokens = { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 0 } }
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, { ...record, plannerSession: { previousModel: model, model, tokensAtStart: tokens, tokensAtEnd: tokens, restoredAt: 'now' } }), true)
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, { ...record, plannerSession: { tokensAtStart: tokens } }), true)
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, { ...record, plannerSession: { model } }), false)
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, { ...record, schemaVersion: 1 }), false)
  assert.equal(accepts(RelayRpc.methods.getSnapshot.output, { ...record, phase: 'unknown' }), false)
  assert.ok('approval_required' in RelayRpc.methods.mutate.errors)
  assert.equal(accepts(RelayRpc.methods.validateConfig.input, {}), true)
  assert.equal(accepts(RelayRpc.methods.validateConfig.input, { extra: true }), false)
  assert.equal(accepts(RelayRpc.methods.probeImage.input, { parentSessionID: 'parent' }), true)
  assert.equal(accepts(RelayRpc.methods.probeImage.input, { parentSessionID: 'parent', model: 'other' }), false)
  assert.equal(accepts(input, { recordID: 'record', expectedRevision: 1, op: { type: 'assignTask', taskID: 'task', owner: { role: 'builder', sessionID: 'x'.repeat(201) } } }), false)
})
test('prompt titles strip soft hyphen, directional and invisible format characters and tags', () => {
  for (const point of [0x00ad, 0x061c, ...Array.from({ length: 5 }, (_, i) => 0x2060 + i), ...Array.from({ length: 128 }, (_, i) => 0xe0000 + i)]) {
    assert.equal(promptTitle(`A${String.fromCodePoint(point)}B`), 'A B', `code point ${point.toString(16)}`)
  }
})
test('task titles form a sentence without count or revision metadata', () => {
  for (const metadata of [{}, { title: 'Plan' }, { title: 'Plan', taskCount: 2 }, { title: 'Plan', revision: 3 }]) {
    const input = { action: approveAction, effect: 'ask' as const, metadata: { ...metadata, taskTitles: ['t1', 't2'] }, message: '' }
    evaluateApproval(input)
    assert.doesNotMatch(input.message, /\?:/)
    assert.match(input.message, /: t1; t2\.$/)
    if (!('taskCount' in metadata) && !('revision' in metadata)) assert.equal(input.message, `Approve plan${'title' in metadata ? ' for Plan' : ''}: t1; t2.`)
  }
})
test('approval prompt includes bounded sanitized task text and ignores untrusted title shapes', () => {
  for (const count of [0, 2, 5]) {
    const input = { action: approveAction, effect: 'ask' as const, metadata: { title: 'Plan', revision: 3, taskCount: count, taskTitles: Array.from({ length: Math.min(count, 3) }, (_, i) => `Task ${i + 1}`) }, message: '' }
    evaluateApproval(input)
    assert.equal(input.message, count === 0 ? 'Approve plan for Plan? 0 tasks, revision 3.' : `Approve plan for Plan? ${count} tasks, revision 3: Task 1; Task 2${count === 5 ? '; Task 3 (+2 more)' : ''}.`)
  }
  const input = { action: approveAction, effect: 'ask' as const, metadata: { title: 'Long'.repeat(100), revision: 999, taskCount: 5, taskTitles: ['A\u202e\n B' + '😀'.repeat(100), 'x'.repeat(100), 'y'.repeat(100)] }, message: '' }
  evaluateApproval(input)
  assert.ok(Array.from(input.message).length <= 240)
  assert.doesNotMatch(input.message, /[\u202e\n]/)
  assert.match(input.message, /A B/)
  for (const taskTitles of ['bad', [42], null]) {
    const untrusted = { action: approveAction, effect: 'ask' as const, metadata: { taskTitles }, message: '' }
    evaluateApproval(untrusted); assert.equal(untrusted.message, 'Approve plan?')
  }
})
test('approval hook upgrades allow, preserves deny, ignores unrelated actions', () => {
  for (const effect of ['allow', 'ask', 'deny'] as const) {
    const input = { action: approveAction, effect, metadata: { title: 'Plan', revision: 3 } }
    evaluateApproval(input); assert.equal(input.effect, effect === 'deny' ? 'deny' : 'ask')
  }
  const other = { action: 'edit', effect: 'allow' as const }; evaluateApproval(other); assert.equal(other.effect, 'allow')
})
test('plain Permission.DeclinedError is a typed denial with rejected outcome and no approval', async () => {
  const storage = memoryStorage(); let handlers: any
  const ctx = { storage, location: { directory: '/project', project: { id: 'project' } },
    session: { get: async () => ({ projectID: 'project', location: { directory: '/project' } }) },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => { throw { _tag: 'Permission.DeclinedError' } } },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  const context = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  const record = await handlers.createRecord({ title: 'Plan', sessionID: 'parent' }, context)
  assert.ok((await handlers.requestApproval({ recordID: record.id, expectedRevision: 1, kind: 'plan' }, context)).pendingApproval)
  await tick()
  const snapshot = await handlers.getSnapshot({ recordID: record.id }, context)
  assert.equal(snapshot.revision, 1); assert.equal(snapshot.approvals.length, 0)
  assert.equal(snapshot.approvalResult.outcome, 'rejected'); assert.equal(snapshot.pendingApproval, undefined)
})
test('setup inert; persist precedes events; approval denial safe; probe exact input', async () => {
  const storage = memoryStorage(); const emitted: unknown[] = []; const sessions: unknown[] = []; const assertions: any[] = []
  let handlers: any; let hook: any
  const ctx = { storage, options: { enableProbe: true }, model: { list: async () => ({ data: [{ id: 'test-model', providerID: 'test', variants: [{ id: 'test-variant' }] }] }) }, location: { directory: '/project', project: { id: 'project' } },
    permission: { hook: async (name: string, fn: unknown) => { assert.equal(name, 'evaluate'); hook = fn; return { dispose: async () => {} } }, assert: async (input: unknown) => { assertions.push(input); throw { _tag: 'Tool.Error', message: 'denied' } } },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async (_: string, event: any) => { assert.ok([...storage.data.values()].some((record: any) => record.id === event.recordID && record.revision === event.revision)); emitted.push(event) } } } } },
    session: { create: async (input: unknown) => { sessions.push(input); return { id: 'child' } }, get: async (input: unknown) => ({ id: 'child', requested: input, projectID: 'project', location: { directory: '/project' } }) },
  } as unknown as Plugin.Context
  await setup(ctx); assert.equal(storage.data.size, 0); assert.equal(sessions.length, 0); assert.equal(typeof hook, 'function')
  const prompt = { sessionID: 'parent', action: 'relay.approve', resources: ['record@1'], effect: 'allow', metadata: {} }
  hook(prompt); assert.equal(prompt.effect, 'ask')
  const configurePrompt = { sessionID: 'parent', action: 'relay.configure', resources: ['relay-config'], effect: 'allow', metadata: { summary: 'Exact changes' }, message: '' }
  hook(configurePrompt); assert.equal(configurePrompt.effect, 'ask'); assert.match(configurePrompt.message, /Exact changes/)
  const context = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  const a = await handlers.createRecord({ title: 'Plan' }, context); assert.equal(emitted.length, 1)
  const denied = await handlers.requestApproval({ recordID: a.id, expectedRevision: 1, kind: 'plan', sessionID: 'parent' }, context)
  assert.ok(denied.pendingApproval); await tick(); assert.equal(emitted.length, 3)
  assert.equal((await handlers.getSnapshot({ recordID: a.id }, context)).approvalResult.outcome, 'rejected')
  assert.equal(assertions[0].action, approveAction); assert.deepEqual(assertions[0].resources, [`${a.id}@1`]); assert.equal('save' in assertions[0], false)
  const model = { id: 'test-model', providerID: 'test', variant: 'test-variant' }
  assert.equal((await handlers.probeWorkerSession({ parentSessionID: 'parent', model: { ...model, id: 'unknown' } }, context)).type, 'invalid_op')
  await handlers.probeWorkerSession({ parentSessionID: 'parent', model }, context)
  const input = sessions[0] as any; assert.deepEqual(input.model, model); assert.equal(input.parentID, 'parent')
  for (const action of ['edit', 'write', 'shell', approveAction]) assert.ok(input.permissions.some((rule: any) => rule.action === action && rule.resource === '*' && rule.effect === 'deny'))
  assert.equal(input.permissions.length, 16)
  assert.ok(input.permissions.some((rule: any) => rule.action === 'relay.verify' && rule.effect === 'deny'))
  for (const action of ['subagent', 'question', 'relay.signoff']) assert.ok(input.permissions.some((rule: any) => rule.action === action && rule.resource === '*' && rule.effect === 'deny'))
  assert.ok(input.permissions.some((rule: any) => rule.action === 'shell' && rule.resource === '*opencode*' && rule.effect === 'deny'))
  assert.equal((await handlers.probeWorkerSession({ parentSessionID: 'parent', model }, context)).type, 'invalid_op')
})
test('RPC approval rechecks prompt-time revision and persists only resolving permission', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  t.after(() => logs.mock.restore())
  const storage = memoryStorage(); let handlers: any; const events: any[] = []
  let permission: () => Promise<void> = async () => {}
  const ctx = { storage, session: { get: async () => ({ projectID: 'project', location: { directory: '/project' } }) }, location: { directory: '/project', project: { id: 'project' } },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => permission() },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async (_: string, data: unknown) => { events.push(data) } } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  const context = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  const record = await handlers.createRecord({ title: 'Plan' }, context)
  const controller = new AbortController()
  permission = async () => {
    assert.equal((await handlers.getSnapshot({ recordID: record.id }, context)).pendingApproval.revision, 1)
    controller.abort(); await createStore(storage, { directory: '/project', projectID: 'project' }).mutate(record.id, 1, { type: 'addTask', title: 'Concurrent change' })
    assert.equal((await handlers.getSnapshot({ recordID: record.id }, context)).pendingApproval, undefined)
  }
  const stale = await handlers.requestApproval({ recordID: record.id, expectedRevision: 1, kind: 'plan', sessionID: 'parent' }, { ...context, signal: controller.signal })
  assert.ok(stale.pendingApproval); await tick()
  assert.equal((await handlers.getSnapshot({ recordID: record.id }, context)).approvals.length, 0)
  assert.equal((await handlers.getSnapshot({ recordID: record.id }, context)).approvalResult.outcome, 'stale')
  assert.equal(approvalMessage(await handlers.getSnapshot({ recordID: record.id }, context)), 'Plan changed; approval not recorded')
  permission = async () => {}
  await handlers.requestApproval({ recordID: record.id, expectedRevision: 2, kind: 'plan', sessionID: 'parent' }, context)
  await tick()
  const approved = await handlers.getSnapshot({ recordID: record.id }, context)
  assert.equal(approved.revision, 3); assert.equal(approved.approvals[0].revision, 2)
  assert.deepEqual(events.map(event => event.revision), [1, 1, 2, 2, 3])
  assert.equal(logs.mock.callCount(), 2)
  assert.deepEqual(logs.mock.calls[0].arguments, ['Relay plan changed; approval not recorded', `${record.id}@1`])
})
test('failed persistence emits no event', async () => {
  const storage = memoryStorage(); let handlers: any; let emits = 0
  const ctx = { storage: { ...storage, set: async () => { throw Error('storage unavailable') } }, location: { directory: '/project', project: { id: 'project' } },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => { emits++ } } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  await assert.rejects(handlers.createRecord({ title: 'Plan' }, { error() {} }), /storage unavailable/)
  assert.equal(emits, 0)
})
test('failed settlement reread does not replace the original denial', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  t.after(() => logs.mock.restore())
  const storage = memoryStorage(); let handlers: any; let failRead = false
  const ctx = { storage: { ...storage, get: async (key: string) => { if (failRead) throw Error('settlement read failed'); return storage.get(key) } },
    location: { directory: '/project', project: { id: 'project' } }, session: { get: async () => ({ projectID: 'project', location: { directory: '/project' } }) },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => { failRead = true; throw { _tag: 'Permission.DeclinedError' } } },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  const context = { error: (type: string) => ({ type }) }
  const record = await handlers.createRecord({ title: 'Plan', sessionID: 'parent' }, context)
  assert.ok((await handlers.requestApproval({ recordID: record.id, expectedRevision: 1, kind: 'plan' }, context)).pendingApproval)
  await tick()
  assert.equal(logs.mock.callCount(), 2)
  assert.equal(logs.mock.calls[1].arguments[0], 'Relay settlement notification failed')
  assert.equal(logs.mock.calls[1].arguments[1], record.id)
  assert.equal((logs.mock.calls[1].arguments[2] as Error).message, 'settlement read failed')
})
test('session binding, prompt sanitization, dedupe, denial and unexpected failure', async () => {
  const storage = memoryStorage(); let handlers: any; let resolve!: () => void; let mode = 'wait'; let calls = 0; let prompt: any
  const ctx = { storage, options: {}, location: { directory: '/project', project: { id: 'project' } },
    session: { get: async ({ sessionID }: { sessionID: string }) => { if (sessionID === 'missing') throw Error('missing'); return { projectID: sessionID === 'foreign' ? 'elsewhere' : 'project', location: { directory: '/project' } } } },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async (input: unknown) => { calls++; prompt = input; if (mode === 'error') throw Error('transport failed'); await new Promise<void>(done => { resolve = done }) } },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  const context = { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  const title = 'A\n\u0000B'.repeat(40)
  const record = await handlers.createRecord({ title, sessionID: 'bound' }, context)
  const request = { recordID: record.id, expectedRevision: 1, kind: 'plan', sessionID: 'wrong' }
  assert.equal((await handlers.requestApproval(request, context)).type, 'invalid_op')
  const first = handlers.requestApproval({ ...request, sessionID: 'bound' }, context)
  await new Promise(done => setImmediate(done))
  assert.equal((await handlers.requestApproval({ ...request, sessionID: 'bound' }, context)).type, 'approval_pending')
  assert.equal(calls, 1); assert.equal(prompt.sessionID, 'bound'); assert.equal(prompt.metadata.title, promptTitle(title)); assert.ok(prompt.metadata.title.length <= 80); assert.doesNotMatch(prompt.metadata.title, /[\n\u0000]/)
  const evaluation = { action: approveAction, effect: 'allow' as 'allow' | 'ask', metadata: prompt.metadata, message: '' }; evaluateApproval(evaluation)
  assert.match(evaluation.message, /0 tasks, revision 1/)
  resolve(); await first; await tick()
  const unbound = await handlers.createRecord({ title: 'Unbound' }, context)
  for (const sessionID of [undefined, 'missing', 'foreign']) assert.equal((await handlers.requestApproval({ ...request, recordID: unbound.id, sessionID }, context)).type, 'invalid_op')
  mode = 'error'
  assert.ok((await handlers.requestApproval({ ...request, recordID: unbound.id, sessionID: 'bound' }, context)).pendingApproval)
  await tick()
  assert.equal((await handlers.getSnapshot({ recordID: unbound.id }, context)).approvals.length, 0)
  const controller = new AbortController(); controller.abort()
  assert.ok((await handlers.requestApproval({ ...request, recordID: unbound.id, sessionID: 'bound' }, { ...context, signal: controller.signal })).pendingApproval)
  await tick()
  assert.equal((await handlers.probeWorkerSession({ parentSessionID: 'bound', model: {} }, context)).type, 'invalid_op')
})
test('emit failure returns persisted record', async () => {
  const storage = memoryStorage(); let handlers: any; let logs = 0
  const ctx = { storage, location: { directory: '/project', project: { id: 'project' } }, permission: { hook: async () => ({ dispose: async () => {} }) }, rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => { throw Error('offline') } } } } } } as unknown as Plugin.Context
  await setup(ctx)
  const messages: unknown[][] = []
  const original = console.error; console.error = (...args) => { logs++; messages.push(args) }
  try { const result = await handlers.createRecord({ title: 'Saved' }, { error() {} }); assert.equal(result.revision, 1); assert.equal(storage.data.size, 1); assert.equal(logs, 1); assert.equal(messages[0][0], 'Relay change event failed after persistence'); assert.equal((messages[0][1] as Error).message, 'offline') } finally { console.error = original }
})
test('unicode prompt safety and absent metadata', () => {
  const title = promptTitle('😀'.repeat(90) + '\u200b\u202e\u2067')
  assert.equal(Array.from(title).length, 80)
  assert.equal(title, '😀'.repeat(77) + '...')
  assert.doesNotMatch(promptTitle('A\u200b\u200f\u202a\u202e\u2066\u2069B'), /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/)
  const input = { action: approveAction, effect: 'allow' as 'allow' | 'ask', message: '' }
  evaluateApproval(input); assert.equal(input.message, 'Approve plan?')
})
test('plan prompt lists bounded check commands/count and manual prompt includes task and note', () => {
  const command = 'npm test ' + 'x'.repeat(151)
  const input = { action: approveAction, effect: 'allow' as 'allow' | 'ask', message: '', metadata: { title: 'Plan', checkCount: 12, checks: Array.from({ length: 10 }, (_, i) => ({ name: `Check ${i}`, command })) } }
  evaluateApproval(input)
  assert.match(input.message, /Checks: 12/); assert.match(input.message, /Check 0: npm test/); assert.match(input.message, /\+2 more/)
  const finalPrompt = { action: approveAction, effect: 'allow' as 'allow' | 'ask', message: '', metadata: { title: 'Plan', checkCount: 1, checks: [{ name: 'E2E', command: 'npm test', scope: 'final' }] } }
  evaluateApproval(finalPrompt)
  assert.match(finalPrompt.message, /E2E \[final\]: npm test/)
  assert.ok(input.message.split('\n')[2].length <= 170)
  assert.equal(command.length, 160); assert.ok(input.message.includes(`Check 0: ${command}\n`))
  const manual = { action: 'relay.verify', effect: 'allow' as 'allow' | 'ask', message: '', metadata: { checkName: 'Browser', taskTitle: 'Task '.repeat(50), note: 'Opened dialog and closed it' } }
  evaluateApproval(manual); assert.match(manual.message, /task Task/); assert.match(manual.message, /Opened dialog and closed it/)
})
test('abort retains pending approval key until the host assert settles', async () => {
  const storage = memoryStorage(); let handlers: any; let settle!: () => void; let calls = 0
  const controller = new AbortController()
  const ctx = { storage, location: { directory: '/project', project: { id: 'project' } },
    session: { get: async () => ({ projectID: 'project', location: { directory: '/project' } }) },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => { calls++; await new Promise<void>(resolve => { settle = resolve }) } },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  const context = { signal: controller.signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  const record = await handlers.createRecord({ title: 'Plan', sessionID: 'parent' }, context)
  const request = { recordID: record.id, expectedRevision: 1, kind: 'plan' }
  const first = handlers.requestApproval(request, context)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  const waiting = await handlers.getSnapshot({ recordID: record.id }, context)
  assert.equal(waiting.pendingApproval.key, `${record.id}@1`)
  const second = await handlers.requestApproval(request, { ...context, signal: new AbortController().signal })
  assert.equal(second.type, 'approval_pending'); assert.equal(calls, 1)
  settle()
  await first
  await tick()
  const approved = await handlers.getSnapshot({ recordID: record.id }, context)
  assert.equal(approved.approvals.length, 1)
  assert.equal(approved.approvalResult.outcome, 'approved')
  assert.equal(approved.pendingApproval, undefined)
})
test('create validates session; post-prompt abort still approves; probe read failure retains marker', async () => {
  const storage = memoryStorage(); let handlers: any; let creates = 0
  const controller = new AbortController()
  const ctx = { storage, options: { enableProbe: true }, location: { directory: '/project', project: { id: 'project' } },
    model: { list: async () => ({ data: [{ id: 'model', providerID: 'test', variants: [{ id: 'known' }] }] }) },
    session: { get: async ({ sessionID }: { sessionID: string }) => { if (sessionID === 'child') throw Error('read failed'); return { projectID: sessionID === 'foreign' ? 'other' : 'project', location: { directory: '/project' } } }, create: async () => { creates++; return { id: 'child' } } },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => { controller.abort() } },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as unknown as Plugin.Context
  await setup(ctx)
  const context = { signal: controller.signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  assert.equal((await handlers.createRecord({ title: 'Wrong', sessionID: 'foreign' }, context)).type, 'invalid_op')
  assert.equal(storage.data.size, 0)
  const record = await handlers.createRecord({ title: 'Plan', sessionID: 'parent' }, context)
  await handlers.requestApproval({ recordID: record.id, expectedRevision: 1, kind: 'plan' }, context)
  await tick()
  assert.equal((await handlers.getSnapshot({ recordID: record.id }, context)).approvals.length, 1)
  const request = { parentSessionID: 'parent', model: { id: 'model', providerID: 'test', variant: 'unknown' } }
  assert.equal((await handlers.probeWorkerSession(request, context)).type, 'invalid_op')
  await assert.rejects(handlers.probeWorkerSession({ ...request, model: { id: 'model', providerID: 'test' } }, context), /child.*created/)
  assert.equal((await handlers.probeWorkerSession({ ...request, model: { id: 'model', providerID: 'test' } }, context)).type, 'invalid_op')
  assert.equal(creates, 1)
})
