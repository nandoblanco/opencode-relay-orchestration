import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Plugin } from '@opencode/plugin'
import { Tool } from '@opencode/schema/tool'
import { setup, evaluateApproval } from '../src/server.ts'
import { createStore } from '../src/store.ts'
import { memoryStorage } from './helpers.ts'
import { preflight, runCheck } from '../src/verify.ts'
import type { Check } from '../src/model.ts'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const done = { outcome: 'done', summary: 'Built', checks: [{ command: 'npm test', result: 'passed' }] }
const approve = { verdict: 'approve', summary: 'Reviewed', findings: [], inspected: [] }
const changes = { verdict: 'changes', summary: 'Fix needed', findings: [{ severity: 'major', text: 'Add the missing assertion' }] }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await tick() }
  assert.fail('Orchestration did not reach the expected state')
}
async function harness(options: object = {}, storage = memoryStorage(), adapter = { preflight, runCheck }) {
  const created: any[] = []; const prompts: any[] = []; const interrupts: string[] = []; const assertions: any[] = []; const events: any[] = []
  const waits = new Map<string, () => void>()
  let handlers: any; let tool: any; let evaluateHook: any; let deny = false; let promptFailure = false; let hangingInterrupt = false; let hangingGet = false; let workerGets = 0
  let hold = false; let allow: () => void = () => {}
  const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } }
  const ctx = { storage, location: { directory: '/project', project: { id: 'project' } }, options: { roles: { builder: { providerID: 'test', id: 'build', variant: 'medium' }, reviewer: { providerID: 'test', id: 'review', variant: 'high' } }, ...options },
    model: { list: async () => ({ data: [{ id: 'review', providerID: 'test', capabilities: { input: ['text'] } }] }) },
    command: { transform: async () => ({ dispose: async () => {} }) },
    tool: { transform: async (edit: any) => { edit({ add: (value: any) => { if (value.name === 'relay_report') tool = value } }); return { dispose: async () => {} } } },
    permission: { hook: async (_: string, fn: any) => { evaluateHook = fn; return { dispose: async () => {} } }, list: async () => [], reply: async () => {}, assert: async (input: any) => { assertions.push(input); if (deny) throw { _tag: 'Permission.DeclinedError' }; if (hold) await new Promise<void>(resolve => { allow = resolve }) } },
    rpc: { register: async (_: unknown, value: any) => { handlers = value; return { dispose: async () => {}, events: { emit: async (_: string, event: any) => { events.push(event) } } } } },
    session: {
      update: async () => {},
      create: async (input: any) => { const id = `worker-${created.length + 1}`; created.push({ ...input, id }); return { id } },
      get: async ({ sessionID }: { sessionID: string }) => { if (sessionID.startsWith('worker-')) { workerGets++; if (hangingGet) await new Promise(() => {}) }; return { projectID: 'project', location: { directory: '/project' }, tokens } },
      prompt: async (input: any) => { prompts.push(input); if (promptFailure) throw Error('expected prompt failure') },
      wait: async ({ sessionID }: any) => new Promise<void>(resolve => { waits.set(sessionID, resolve) }),
      interrupt: async ({ sessionID }: any) => { interrupts.push(sessionID); if (hangingInterrupt) await new Promise(() => {}); waits.get(sessionID)?.(); return { interrupted: true } },
    },
  } as unknown as Plugin.Context
  const dispose = await setup(ctx, adapter)
  const context = { error: (type: string, message: string, data: object) => ({ type, message, data }) }
  const call = (method: string, input: object) => handlers[method](input, context)
  const store = createStore(storage, { directory: '/project', projectID: 'project' })
  async function plan(count = 1, checks: Check[] = []) {
    let record = await call('createRecord', { title: 'Plan', sessionID: 'parent' })
    for (let i = 0; i < count; i++) record = await call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'addTask', title: `Task ${i + 1}` } })
    for (const check of checks) record = await call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'addCheck', check } })
    await call('requestApproval', { recordID: record.id, expectedRevision: record.revision, kind: 'plan' })
    await until(async () => (await store.get(record.id)).phase === 'approved')
    return store.get(record.id)
  }
  const mutate = async (id: string, op: object) => call('mutate', { recordID: id, expectedRevision: (await store.get(id)).revision, op })
  const report = (sessionID: string, input: unknown) => tool.execute(input, { sessionID })
  async function finish(index: number, reportInput?: unknown) {
    const id = created[index].id
    await until(async () => waits.has(id))
    if (reportInput) await report(id, reportInput)
    waits.get(id)!()
    await tick()
  }
  return { store, storage, call, plan, mutate, report, finish, created, prompts, interrupts, assertions, events, tokens, dispose, evaluate: (event: any) => evaluateHook(event), hold: () => { hold = true }, allow: () => allow(), deny: () => { deny = true }, failPrompt: () => { promptFailure = true }, hangInterrupt: () => { hangingInterrupt = true }, hangGet: () => { hangingGet = true }, workerGets: () => workerGets }
}

const requiredCheck: Check = { id: 'check', name: 'Browser', adapter: 'playwright', command: 'npm test', policy: 'automated-required' }
test('builder includes earlier failed attempts and reviewer reads effective widths at launch', async () => {
  const h = await harness()
  const record = await h.plan()
  await h.mutate(record.id, { type: 'start' })
  assert.match(h.prompts[0].text, /every check attempt.*including earlier failures.*maximum 20/)
  await h.storage.set('relay/config', { version: 1, widths: [480, 1600], updatedAt: 'now' })
  await h.finish(0, done)
  await until(async () => h.prompts.length === 2)
  assert.match(h.prompts[1].text, /effective screenshot widths are 480, 1600/)
  assert.match(h.prompts[1].text, /Raise a major finding when an affected width has no attached screenshot/)
  await h.mutate(record.id, { type: 'cancel' })
})
const passed = { result: 'passed' as const, source: 'adapter' as const, output: 'Passed', exitCode: 0, screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 }
test('withdraw prevents late sign-off and manual evidence; unbound manual accepts a validated input session', async () => {
  for (const manual of [false, true]) {
    const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: false, checks: checks.map(check => ({ checkID: check.id, available: false, reason: 'child_process unavailable' })) }), runCheck: async () => passed }
    const h = await harness({}, memoryStorage(), adapter)
    const p = await h.plan(1, manual ? [{ ...requiredCheck, policy: 'manual-allowed' }] : [])
    await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
    if (manual) await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
    else { await h.finish(1, approve); await until(async () => (await h.store.get(p.id)).tasks.every(task => task.status === 'completed')) }
    let record = await h.store.get(p.id)
    if (manual) record = await h.store.write(record.id, record.revision, current => { delete current.sessionID })
    h.hold()
    const input = { id: record.id, revision: record.revision, taskID: record.tasks[0].id, checkID: 'check', note: 'Checked', sessionID: 'parent' }
    const work = manual ? h.call('recordManual', input) : h.call('signOff', { recordID: record.id, expectedRevision: record.revision })
    await until(async () => Boolean((await h.call('getSnapshot', { recordID: record.id })).pendingApproval))
    await tick()
    const pending = await h.call('getSnapshot', { recordID: record.id })
    const blocker = await h.store.create('Queue blocker')
    let release!: () => void
    const blocked = h.store.write(blocker.id, blocker.revision, async () => { await new Promise<void>(resolve => { release = resolve }) })
    await tick(); h.allow(); await tick()
    await h.call('withdrawApproval', { recordID: record.id, key: pending.pendingApproval.key })
    release(); await blocked
    assert.equal((await work).type, 'approval_withdrawn')
    assert.deepEqual(await h.store.get(record.id), record)
    if (manual) assert.equal((await h.store.listEvidence(record.id)).some(item => item.result === 'manually verified'), false)
  }
})
for (const action of ['interrupt', 'cancel']) test(`${action} aborts a check, discards its evidence and interrupt can resume`, async () => {
  let signal: AbortSignal | undefined; let calls = 0
  const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(check => ({ checkID: check.id, available: true })) }), runCheck: async (_: string, __: Check, value?: AbortSignal) => {
    calls++; signal = value
    if (calls > 1) return passed
    return new Promise<typeof passed>((_, reject) => value!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  } }
  const h = await harness({}, memoryStorage(), adapter); const p = await h.plan(1, [requiredCheck]); await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
  await until(async () => Boolean(signal))
  await h.mutate(p.id, action === 'interrupt' ? { type: action, reason: 'Pause' } : { type: action })
  assert.equal(signal!.aborted, true); await tick(); assert.equal((await h.store.listEvidence(p.id)).length, 0)
  if (action === 'interrupt') { await h.mutate(p.id, { type: 'resume' }); await until(async () => h.created.length === 2); assert.equal(calls, 2); await h.mutate(p.id, { type: 'cancel' }) }
})
for (const missing of [false, true]) test(`screenshot ${missing ? 'missing' : 'hash mismatch'} blocks attachment`, async () => {
  const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(check => ({ checkID: check.id, available: true })) }), runCheck: async () => ({ ...passed, screenshots: [{ path: missing ? 'missing-screenshot.png' : 'package.json', sha256: 'wrong', bytes: 1 }] }) }
  const h = await harness({}, memoryStorage(), adapter)
  await h.storage.set('relay/image-probes/' + encodeURIComponent(JSON.stringify(['test', 'review', 'high'])), { status: 'verified' })
  const p = await h.plan(1, [requiredCheck]); await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
  await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal((await h.store.get(p.id)).interruptReason, 'escalated: screenshot changed after check'); assert.equal(h.created.length, 1)
})
for (const reason of ['child_process unavailable', 'Playwright package unavailable']) test(`required ${reason} pauses before reviewer and resumes with plugin evidence`, async () => {
  let available = false
  const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: reason !== 'child_process unavailable' || available, checks: checks.map(check => ({ checkID: check.id, available, reason })) }), runCheck: async () => ({ ...passed, startedAt: Date.now(), endedAt: Date.now() + 1 }) }
  const h = await harness({}, memoryStorage(), adapter); const p = await h.plan(1, [requiredCheck])
  await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
  await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal(h.created.length, 1); assert.equal((await h.store.get(p.id)).interruptReason, 'verification unavailable: Browser')
  assert.deepEqual((await h.call('listEvidence', { id: p.id })).map((item: any) => item.result), ['unverified'])
  available = true; await h.mutate(p.id, { type: 'resume' }); await until(async () => h.created.length === 2)
  assert.match(h.prompts[1].text, /plugin-run/); assert.match(h.prompts[1].text, /do not prove interactions or accessibility/)
  const runs = await h.store.listRuns(p.id); assert.equal(runs[1].evidenceIDs?.length, 1)
  await h.finish(1, approve); await until(async () => (await h.store.get(p.id)).tasks[0].status === 'completed')
  const r = await h.store.get(p.id)
  assert.equal((await h.call('signOff', { recordID: r.id, expectedRevision: r.revision })).phase, 'completed')
})
test('manual unavailable pauses, denied permission writes nothing, and accepted manual stays distinct', async () => {
  const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: false, checks: checks.map(check => ({ checkID: check.id, available: false, reason: 'child_process unavailable' })) }), runCheck: async () => passed }
  const h = await harness({}, memoryStorage(), adapter); const p = await h.plan(1, [{ ...requiredCheck, policy: 'manual-allowed' }])
  assert.equal(h.assertions[0].metadata.checkCount, 1)
  assert.deepEqual(h.assertions[0].metadata.checks, [{ name: 'Browser', command: 'npm test' }])
  await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
  await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  let r = await h.store.get(p.id)
  assert.equal(r.interruptReason, 'manual verification required: Browser')
  r = await h.call('recordManual', { id: p.id, revision: r.revision, taskID: p.tasks[0].id, checkID: 'check', note: 'Exercised interactions' })
  assert.equal(h.assertions.at(-1).action, 'relay.verify')
  assert.equal(h.assertions.at(-1).metadata.taskTitle, 'Task 1')
  assert.equal(h.assertions.at(-1).metadata.note, 'Exercised interactions')
  assert.deepEqual(h.assertions.at(-1).resources, [`${p.id}@${r.revision - 1}:${p.tasks[0].id}:check`])
  const evaluation = { action: 'relay.verify', effect: 'allow' as 'allow' | 'ask', message: '' }; evaluateApproval(evaluation); assert.equal(evaluation.effect, 'ask')
  await h.mutate(p.id, { type: 'resume' }); await until(async () => h.created.length === 2)
  assert.match(h.prompts[1].text, /manually verified by user/)
  assert.equal((await h.store.listEvidence(p.id)).at(-1)!.result, 'manually verified')
  await h.mutate(p.id, { type: 'cancel' })
  const denied = await harness({}, memoryStorage(), adapter); const d = await denied.plan(1, [{ ...requiredCheck, policy: 'manual-allowed' }])
  await denied.mutate(d.id, { type: 'start' }); await denied.finish(0, done)
  await until(async () => (await denied.store.get(d.id)).phase === 'interrupted'); denied.deny()
  const before = await denied.store.get(d.id)
  assert.equal((await denied.call('recordManual', { id: d.id, revision: before.revision, taskID: d.tasks[0].id, checkID: 'check', note: 'Checked' })).type, 'approval_denied')
  assert.deepEqual(await denied.store.get(d.id), before); assert.equal((await denied.store.listEvidence(d.id)).length, 1)
})
test('failed checks consume a fix cycle, include output and never offer manual; exhaustion escalates', async () => {
  const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(check => ({ checkID: check.id, available: true })) }), runCheck: async () => ({ ...passed, result: 'failed' as const, output: 'x'.repeat(2100) + 'Assertion failed', exitCode: 1 }) }
  const h = await harness({ limits: { maxFixCycles: 1 } }, memoryStorage(), adapter); const p = await h.plan(1, [{ ...requiredCheck, policy: 'manual-allowed' }])
  await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
  await until(async () => h.created.length === 2)
  assert.equal(h.created[1].title, 'Relay build: Task 1'); assert.match(h.prompts[1].text, /Failed check Browser/); assert.match(h.prompts[1].text, /Assertion failed/)
  assert.equal((await h.store.get(p.id)).tasks[0].fixCycles, 1)
  await h.finish(1, done); await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal((await h.store.get(p.id)).interruptReason, 'escalated: fix cycles exhausted')
})
test('screenshots with unavailable reviewer image input escalate instead of launching review', async () => {
  const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(check => ({ checkID: check.id, available: true })) }), runCheck: async () => ({ ...passed, screenshots: [{ path: 'not-read.png', sha256: 'hash', bytes: 1 }] }) }
  const h = await harness({}, memoryStorage(), adapter); const p = await h.plan(1, [requiredCheck])
  await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
  await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal((await h.store.get(p.id)).interruptReason, 'escalated: screenshot review unavailable'); assert.equal(h.created.length, 1)
})
for (const inspected of ['all', 'missing', 'absent', 'many', 'no-report']) test(`review receives every screenshot and ${inspected} inspected names enforce completion`, async () => {
  await mkdir('.screenshots', { recursive: true })
  const directory = await mkdtemp(resolve('.screenshots', 'm4-inline-'))
  try {
    const path = join(directory, 'page.png'); await writeFile(path, Buffer.from('png'))
    const hash = createHash('sha256').update('png').digest('hex')
    const images = [{ path, sha256: hash, bytes: 3 }]
    if (inspected === 'many') for (let index = 0; index < 11; index++) { const extra = join(directory, `page-${index}.png`); await writeFile(extra, Buffer.from('png')); images.push({ path: extra, sha256: hash, bytes: 3 }) }
    const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(check => ({ checkID: check.id, available: true })) }), runCheck: async () => ({ ...passed, screenshots: images }) }
    const h = await harness({}, memoryStorage(), adapter)
    await h.storage.set('relay/image-probes/' + encodeURIComponent(JSON.stringify(['test', 'review', 'high'])), { status: 'verified' })
    const p = await h.plan(1, [requiredCheck]); await h.mutate(p.id, { type: 'start' }); await h.finish(0, done)
    for (let attempt = 0; attempt < 200 && h.prompts.length !== 2; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(h.prompts.length, 2)
    assert.equal(h.prompts[1].files.length, images.length)
    assert.deepEqual(h.prompts[1].files[0], { uri: 'data:image/png;base64,cG5n', source: { type: 'inline' }, name: `page.png ${hash}` })
    assert.match(h.prompts[1].text, /Inspect every attached screenshot/)
    assert.deepEqual((await h.store.listRuns(p.id))[1].evidenceIDs, (await h.store.listEvidence(p.id)).map(item => item.id))
    const complete = ['all', 'many'].includes(inspected)
    const report = { ...approve, inspected: complete ? h.prompts[1].files.map((file: any) => file.name).concat('extra ignored') : [] } as { inspected?: string[] }
    if (inspected === 'absent') delete report.inspected
    await h.finish(1, inspected === 'no-report' ? undefined : report)
    await until(async () => { const record = await h.store.get(p.id); return record.tasks[0].status === (complete ? 'completed' : 'blocked') })
    const record = await h.store.get(p.id)
    if (!complete) { assert.equal(record.phase, 'interrupted'); assert.equal(record.interruptReason, inspected === 'no-report' ? 'escalated: no report' : 'escalated: screenshot inspection incomplete') }
    await h.mutate(p.id, { type: 'cancel' })
  } finally { await rm(directory, { recursive: true }) }
})
test('run-time unverified pauses and a long-running adapter leaves interrupt queue free', async () => {
  let finish!: (value: any) => void
  const adapter = { preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(check => ({ checkID: check.id, available: true })) }), runCheck: async () => new Promise<typeof passed>(resolve => { finish = resolve }) }
  const h = await harness({}, memoryStorage(), adapter); const p = await h.plan(1, [requiredCheck])
  await h.mutate(p.id, { type: 'start' }); await h.finish(0, done); await until(async () => Boolean(finish))
  assert.equal((await h.mutate(p.id, { type: 'interrupt', reason: 'Pause during check' })).phase, 'interrupted')
  finish(passed); await tick(); await tick()
  assert.equal((await h.store.listEvidence(p.id)).length, 0); assert.equal(h.created.length, 1)
  const empty = { ...adapter, runCheck: async () => ({ ...passed, result: 'unverified' as const, reason: 'no screenshots produced' }) }
  const second = await harness({}, memoryStorage(), empty); const plan = await second.plan(1, [requiredCheck])
  await second.mutate(plan.id, { type: 'start' }); await second.finish(0, done)
  await until(async () => (await second.store.get(plan.id)).phase === 'interrupted')
  assert.equal((await second.store.get(plan.id)).interruptReason, 'verification unavailable: Browser')
})

test('successful build/review records audit tokens and requires explicit permission sign-off', async () => {
  const h = await harness(); const plan = await h.plan()
  await h.mutate(plan.id, { type: 'start' })
  await h.finish(0, done)
  await until(async () => h.created.length === 2)
  assert.equal(h.created[0].parentID, 'parent'); assert.deepEqual(h.created[0].location, { directory: '/project' })
  assert.equal(h.created[0].title, 'Relay build: Task 1')
  for (const [index, role] of ['builder', 'reviewer'].entries()) {
    const input = h.created[index]
    assert.deepEqual(input.model, { providerID: 'test', id: index ? 'review' : 'build', variant: index ? 'high' : 'medium' })
    assert.deepEqual(input.permissions, [
      ...['subagent', 'question', 'relay.approve', 'relay.signoff', 'relay.verify', 'relay.configure', 'relay_config_set', 'relay_plan_add', 'relay_plan_submit', 'relay_plan_cancel', 'relay_status', 'relay_explore'].map(action => ({ action, resource: '*', effect: 'deny' })),
      { action: 'shell', resource: '*opencode*', effect: 'deny' },
      ...(role === 'reviewer' ? ['edit', 'write', 'shell'].map(action => ({ action, resource: '*', effect: 'deny' })) : []),
    ])
  }
  assert.match(h.prompts[1].text, /self-reported, unverified/)
  await h.finish(1, approve)
  await until(async () => (await h.store.get(plan.id)).tasks[0].status === 'completed')
  let record = await h.store.get(plan.id)
  assert.equal(record.phase, 'running'); assert.equal(record.approvals.length, 1)
  assert.equal((await h.mutate(record.id, { type: 'complete' })).type, 'approval_required')
  const runs = await h.call('listRuns', { recordID: record.id })
  assert.equal(runs.length, 2)
  for (const run of runs) {
    assert.equal(run.status, 'reported'); assert.deepEqual(run.tokens, h.tokens); assert.ok(run.endedAt); assert.ok(run.durationMs >= 0); assert.equal(run.attempt, 1)
    assert.ok([...h.storage.data.keys()].some(key => key === `relay/runs/project/${record.id}/${run.id}`))
  }
  record = await h.call('signOff', { recordID: record.id, expectedRevision: record.revision })
  assert.equal(record.phase, 'completed'); assert.equal(h.assertions.at(-1).action, 'relay.signoff')
  assert.deepEqual(h.assertions.at(-1).resources, [`${record.id}@${record.revision - 1}`])
  assert.equal(record.approvals.length, 1)
  const evaluated = { action: 'relay.signoff', effect: 'allow' as 'allow' | 'ask', metadata: h.assertions.at(-1).metadata, message: '' }
  evaluateApproval(evaluated); assert.equal(evaluated.effect, 'ask'); assert.match(evaluated.message, /^Sign off Plan\? 1 tasks completed, revision \d+\.$/)
  await h.dispose()
})
test('review findings carry into the next build prompt and consume exactly one fix cycle', async () => {
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' })
  await h.finish(0, done); await until(async () => h.created.length === 2)
  await h.finish(1, changes); await until(async () => h.created.length === 3)
  assert.match(h.prompts[2].text, /Add the missing assertion/)
  assert.equal((await h.store.get(p.id)).tasks[0].fixCycles, 1)
  await h.finish(2, done); await until(async () => h.created.length === 4)
  await h.finish(3, approve); await until(async () => (await h.store.get(p.id)).tasks[0].status === 'completed')
  assert.deepEqual((await h.store.listRuns(p.id)).map(run => run.attempt), [1, 1, 2, 2])
})
test('exhausted fixes escalate; user unblocks while interrupted and repeated failure escalates again', async () => {
  const h = await harness({ limits: { maxFixCycles: 0 } }); const p = await h.plan(); await h.mutate(p.id, { type: 'start' })
  await h.finish(0, done); await until(async () => h.created.length === 2)
  await h.finish(1, changes); await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal((await h.store.get(p.id)).interruptReason, 'escalated: fix cycles exhausted')
  await h.mutate(p.id, { type: 'setTaskStatus', taskID: p.tasks[0].id, status: 'pending' })
  await h.mutate(p.id, { type: 'resume' }); await h.finish(2, { ...done, outcome: 'blocked' })
  await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal((await h.store.get(p.id)).interruptReason, 'escalated: builder blocked')
  assert.equal((await h.store.get(p.id)).tasks[0].fixCycles, 0)
})
test('no report escalates and manual status/owner edits while running are rejected unchanged', async () => {
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' })
  const before = await h.store.get(p.id)
  for (const op of [{ type: 'setTaskStatus', taskID: p.tasks[0].id, status: 'completed' }, { type: 'assignTask', taskID: p.tasks[0].id, owner: { role: 'reviewer' } }]) assert.equal((await h.mutate(p.id, op)).type, 'invalid_op')
  assert.deepEqual(await h.store.get(p.id), before)
  await h.finish(0); await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal((await h.store.get(p.id)).interruptReason, 'escalated: no report')
  assert.equal((await h.store.get(p.id)).tasks[0].status, 'blocked')
  assert.equal((await h.store.listRuns(p.id))[0].status, 'failed')
})
test('maxRunningTasks keeps slots through review and schedules pending work after completion', async () => {
  const h = await harness({ limits: { maxRunningTasks: 2 } }); const p = await h.plan(3); await h.mutate(p.id, { type: 'start' })
  assert.equal(h.created.length, 2)
  await h.finish(0, done); await until(async () => h.created.length === 3)
  assert.equal((await h.store.get(p.id)).tasks.filter(task => task.status === 'running').length, 2)
  await h.finish(2, approve); await until(async () => h.created.length === 4)
  assert.equal((await h.store.get(p.id)).tasks.filter(task => task.status === 'running').length, 2)
  await h.mutate(p.id, { type: 'cancel' })
})
for (const action of ['interrupt', 'cancel']) test(`${action} interrupts active sessions, rejects late reports and resume starts fresh attempts`, async () => {
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' })
  await until(async () => h.prompts.length === 1)
  await h.mutate(p.id, action === 'interrupt' ? { type: action, reason: 'Pause' } : { type: action })
  assert.deepEqual(h.interrupts, ['worker-1'])
  await assert.rejects(h.report('worker-1', done), /invalid_op/)
  const run = (await h.store.listRuns(p.id))[0]
  assert.equal(run.status, action === 'cancel' ? 'cancelled' : 'interrupted'); assert.ok(run.endedAt)
  if (action === 'interrupt') {
    await h.mutate(p.id, { type: 'resume' }); assert.equal(h.created.length, 2)
    assert.equal((await h.store.listRuns(p.id))[1].attempt, 2); assert.equal((await h.store.get(p.id)).tasks[0].fixCycles, 0)
    await h.mutate(p.id, { type: 'cancel' })
  }
})
test('sign-off denial leaves the entire persisted record unchanged and never prompts before eligibility', async () => {
  const h = await harness(); const p = await h.plan(); const calls = h.assertions.length
  assert.equal((await h.call('signOff', { recordID: p.id, expectedRevision: p.revision })).type, 'invalid_op'); assert.equal(h.assertions.length, calls)
  await h.mutate(p.id, { type: 'start' }); await h.finish(0, done); await until(async () => h.created.length === 2); await h.finish(1, approve)
  await until(async () => (await h.store.get(p.id)).tasks[0].status === 'completed')
  const before = await h.store.get(p.id); h.deny()
  assert.equal((await h.call('signOff', { recordID: p.id, expectedRevision: before.revision })).type, 'approval_denied')
  assert.deepEqual(await h.store.get(p.id), before)
})
test('report tool rejects nonworkers, wrong role, malformed, extra authority fields and duplicate reports', async () => {
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' })
  for (const [session, input] of [['parent', done], ['worker-1', approve], ['worker-1', { ...done, approval: true }], ['worker-1', { ...done, summary: 1 }], ['worker-1', { ...done, checks: [{ command: 'x', result: 'unknown' }] }]] as const) await assert.rejects(h.report(session, input), /invalid_op/)
  assert.equal((await h.store.listRuns(p.id))[0].report, undefined)
  await assert.rejects(h.report('worker-1', { ...done, inspected: [] }), /invalid_op/)
  await h.report('worker-1', done); await assert.rejects(h.report('worker-1', done), /invalid_op/)
  assert.equal((await h.store.get(p.id)).phase, 'running'); assert.equal((await h.store.get(p.id)).approvals.length, 1)
  await h.finish(0); await until(async () => h.created.length === 2)
  await assert.rejects(h.report('worker-2', done), /invalid_op/)
  await h.mutate(p.id, { type: 'cancel' })
})
test('registered relay_report wrapper rejects a non-worker with SDK Tool.Error', async () => {
  const h = await harness(); const p = await h.plan(); const before = await h.store.get(p.id)
  await assert.rejects(h.report('not-a-worker', done), (failure: unknown) => failure instanceof Tool.Error && failure._tag === 'Tool.Error' && failure.message === 'invalid_op')
  assert.deepEqual(await h.store.get(p.id), before)
  assert.deepEqual(await h.store.listRuns(p.id), [])
  await h.dispose()
})
test('a never-resolving host interrupt releases the record queue after ten seconds', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' }); h.hangInterrupt()
  let settled = false
  const cancelling = h.mutate(p.id, { type: 'cancel' }).then(result => { settled = true; return result })
  await until(async () => h.interrupts.length === 1)
  assert.equal((await h.store.listRuns(p.id))[0].status, 'cancelled')
  t.mock.timers.tick(9999); await tick(); assert.equal(settled, false)
  t.mock.timers.tick(1)
  assert.equal((await cancelling).phase, 'cancelled')
  await assert.rejects(h.report('worker-1', done), (failure: unknown) => failure instanceof Tool.Error && failure.message === 'invalid_op')
  assert.equal((await h.store.listRuns(p.id))[0].report, undefined)
  assert.equal(logs.mock.callCount(), 1)
  assert.equal(logs.mock.calls[0].arguments[0], 'Relay worker interrupt failed')
  assert.equal((logs.mock.calls[0].arguments[2] as Error).message, 'Worker interrupt timed out after 10 seconds')
  await h.dispose()
})
test('launch storage failure cannot wedge the queue on a never-resolving cleanup interrupt', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const storage = memoryStorage()
  const h = await harness({}, { ...storage, set: async (key, value) => { if (key.startsWith('relay/runs/')) throw Error('expected run storage failure'); await storage.set(key, value) } })
  const p = await h.plan(); h.hangInterrupt()
  let settled = false
  const starting = h.mutate(p.id, { type: 'start' }).then(result => { settled = true; return result })
  await until(async () => h.interrupts.length === 1)
  t.mock.timers.tick(9999); await tick(); assert.equal(settled, false)
  t.mock.timers.tick(1)
  assert.equal((await starting).interruptReason, 'escalated: worker launch failed')
  assert.equal((await h.mutate(p.id, { type: 'setTaskStatus', taskID: p.tasks[0].id, status: 'pending' })).tasks[0].status, 'pending')
  assert.equal((await h.mutate(p.id, { type: 'cancel' })).phase, 'cancelled')
  assert.equal(logs.mock.callCount(), 2)
  assert.equal(logs.mock.calls[0].arguments[0], 'Relay unstarted worker interrupt failed')
  assert.equal(logs.mock.calls[1].arguments[0], 'Relay worker launch failed')
  assert.deepEqual(await h.store.listRuns(p.id), [])
  await h.dispose()
})
test('a never-resolving end-session get finishes without tokens and releases the queue', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' }); h.hangGet()
  await h.finish(0, { ...done, outcome: 'blocked' })
  await until(async () => h.workerGets() === 1)
  t.mock.timers.tick(9999); await tick()
  assert.equal((await h.store.listRuns(p.id))[0].status, 'active')
  t.mock.timers.tick(1)
  await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  const run = (await h.store.listRuns(p.id))[0]
  assert.equal(run.status, 'reported'); assert.equal(run.tokens, undefined); assert.ok(run.endedAt)
  assert.equal((await h.mutate(p.id, { type: 'cancel' })).phase, 'cancelled')
  assert.equal(logs.mock.callCount(), 1)
  assert.equal(logs.mock.calls[0].arguments[0], 'Relay worker tokens unavailable')
  assert.equal((logs.mock.calls[0].arguments[2] as Error).message, 'Worker tokens timed out after 10 seconds')
  await h.dispose()
})
test('reports truncate Unicode text and item counts within caps', async () => {
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' })
  await h.report('worker-1', { ...done, summary: '😀'.repeat(5000), checks: Array.from({ length: 30 }, () => ({ command: '😀'.repeat(600), result: 'passed' })) })
  const report = (await h.store.listRuns(p.id))[0].report!
  assert.equal(Array.from(report.summary).length, 4000); assert.match(report.summary, / \(truncated\)$/)
  assert.ok('checks' in report); assert.equal(report.checks.length, 20); assert.equal(Array.from(report.checks[0].command).length, 500)
  await h.finish(0); await until(async () => h.created.length === 2)
  await h.report('worker-2', { ...changes, summary: '😀'.repeat(5000), findings: Array.from({ length: 30 }, () => ({ text: '😀'.repeat(600), severity: 'major' })), inspected: Array.from({ length: 60 }, () => '😀'.repeat(400)) })
  const review = (await h.store.listRuns(p.id))[1].report!
  assert.equal(Array.from(review.summary).length, 4000); assert.ok('findings' in review); assert.equal(review.findings.length, 20)
  assert.equal(Array.from(review.findings[0].text).length, 500); assert.match(review.findings[0].text, / \(truncated\)$/)
  assert.equal(review.inspected?.length, 50); assert.equal(Array.from(review.inspected![0]).length, 300); assert.match(review.inspected![0], / \(truncated\)$/)
  await h.mutate(p.id, { type: 'cancel' })
})
test('resume retains review stage and does not consume a fix cycle', async () => {
  const h = await harness(); const p = await h.plan(); await h.mutate(p.id, { type: 'start' })
  await h.finish(0, done); await until(async () => h.created.length === 2)
  await h.mutate(p.id, { type: 'interrupt', reason: 'Review pause' })
  await h.mutate(p.id, { type: 'resume' })
  const run = (await h.store.listRuns(p.id))[2]
  assert.equal(run.stage, 'review'); assert.equal(run.role, 'reviewer'); assert.equal(run.attempt, 2)
  assert.equal((await h.store.get(p.id)).tasks[0].fixCycles, 0)
  await h.mutate(p.id, { type: 'cancel' })
})
test('startup interrupts stored active workers without launching anything; explicit resume increments attempt', async () => {
  const first = await harness(); const p = await first.plan(); await first.mutate(p.id, { type: 'start' })
  const h = await harness({}, first.storage)
  assert.equal(h.created.length, 0); assert.deepEqual(h.interrupts, ['worker-1'])
  assert.equal((await h.store.get(p.id)).interruptReason, 'server_restart'); assert.equal((await h.store.listRuns(p.id))[0].status, 'interrupted')
  await tick(); assert.equal(h.created.length, 0)
  await h.mutate(p.id, { type: 'resume' }); assert.equal(h.created.length, 1)
  assert.equal((await h.store.listRuns(p.id))[1].attempt, 2)
  await h.mutate(p.id, { type: 'cancel' })
})
test('worker prompt failure is logged once and escalated with clean expected stderr', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  const h = await harness(); const p = await h.plan(); h.failPrompt(); await h.mutate(p.id, { type: 'start' })
  await until(async () => (await h.store.get(p.id)).phase === 'interrupted')
  assert.equal((await h.store.get(p.id)).interruptReason, 'escalated: worker failed')
  assert.equal(logs.mock.callCount(), 1); assert.equal(logs.mock.calls[0].arguments[0], 'Relay worker failed')
})
test('reviewer escalates when combined screenshots exceed per-review count or byte caps', async () => {
  await mkdir('.screenshots', { recursive: true })
  const directory = await mkdtemp(resolve('.screenshots', 'm7-review-cap-'))
  try {
    const png = Buffer.from('png')
    const pngHash = createHash('sha256').update(png).digest('hex')
    const smallFile = join(directory, 'small.png')
    await writeFile(smallFile, png)
    const big = Buffer.alloc(9 * 1024 * 1024)
    const bigHash = createHash('sha256').update(big).digest('hex')
    const bigFile = join(directory, 'big.png')
    await writeFile(bigFile, big)

    const countAdapter = {
      preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(c => ({ checkID: c.id, available: true })) }),
      runCheck: async () => ({ ...passed, screenshots: Array.from({ length: 7 }, () => ({ path: smallFile, sha256: pngHash, bytes: png.length })) }),
    }
    const h1 = await harness({}, memoryStorage(), countAdapter)
    await h1.storage.set('relay/image-probes/' + encodeURIComponent(JSON.stringify(['test', 'review', 'high'])), { status: 'verified' })
    const p1 = await h1.plan(1, [
      { id: 'c1', name: 'Browser 1', adapter: 'playwright', command: 'npm test', policy: 'automated-required' },
      { id: 'c2', name: 'Browser 2', adapter: 'playwright', command: 'npm test', policy: 'automated-required' },
    ])
    await h1.mutate(p1.id, { type: 'start' }); await h1.finish(0, done)
    await until(async () => (await h1.store.get(p1.id)).phase === 'interrupted')
    assert.match((await h1.store.get(p1.id)).interruptReason ?? '', /escalated: screenshot cap exceeded: 14 files exceeds limit 12/)

    const byteAdapter = {
      preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(c => ({ checkID: c.id, available: true })) }),
      runCheck: async () => ({ ...passed, screenshots: [{ path: bigFile, sha256: bigHash, bytes: big.length }] }),
    }
    const h2 = await harness({}, memoryStorage(), byteAdapter)
    await h2.storage.set('relay/image-probes/' + encodeURIComponent(JSON.stringify(['test', 'review', 'high'])), { status: 'verified' })
    const p2 = await h2.plan(1, [
      { id: 'c1', name: 'Browser 1', adapter: 'playwright', command: 'npm test', policy: 'automated-required' },
      { id: 'c2', name: 'Browser 2', adapter: 'playwright', command: 'npm test', policy: 'automated-required' },
    ])
    await h2.mutate(p2.id, { type: 'start' }); await h2.finish(0, done)
    for (let i = 0; i < 200 && (await h2.store.get(p2.id)).phase !== 'interrupted'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.match((await h2.store.get(p2.id)).interruptReason ?? '', /escalated: screenshot cap exceeded: .* bytes exceeds limit/)
  } finally { await rm(directory, { recursive: true }) }
})
test('final-gate checks skip intermediate tasks, serialize parallel final review and pass sign-off', async () => {
  const ran: string[] = []
  const adapter = {
    preflight: async (_: string, checks: Check[]) => ({ childProcess: true, checks: checks.map(c => ({ checkID: c.id, available: true })) }),
    runCheck: async (_dir: string, check: Check) => { ran.push(check.id); return { ...passed } },
  }
  const h = await harness({ limits: { maxRunningTasks: 2 } }, memoryStorage(), adapter)
  const p = await h.plan(2, [
    { id: 'unit', name: 'Unit', adapter: 'command', command: 'npm test', policy: 'automated-required', scope: 'task' },
    { id: 'final', name: 'Final', adapter: 'command', command: 'npm run e2e', policy: 'automated-required', scope: 'final' },
  ])
  await h.mutate(p.id, { type: 'start' })
  // Both builders start in parallel (worker-1, worker-2)
  await until(async () => h.created.length === 2)
  // Task 1 finishes build and enters review (worker-3) with only 'unit' check
  await h.finish(0, done)
  await until(async () => h.created.length === 3)
  assert.deepEqual(ran, ['unit'])
  // Task 2 finishes build while task 1 is still reviewing; task 2's review must defer until task 1 completes
  await h.finish(1, done)
  await tick()
  assert.equal(h.created.length, 3)
  assert.deepEqual(ran, ['unit'])
  // Task 1 approves and completes -> task 2 becomes final task, runs both 'unit' and 'final', enters review (worker-4)
  await h.finish(2, approve)
  await until(async () => h.created.length === 4)
  assert.deepEqual(ran, ['unit', 'unit', 'final'])
  await h.finish(3, approve)
  await until(async () => (await h.store.get(p.id)).tasks.every(task => task.status === 'completed'))
  const current = await h.store.get(p.id)
  const completed = await h.store.signOff(current.id, current.revision, async () => {})
  assert.equal(completed.phase, 'completed')
})
test('builder file-scope gate enforces allowedPaths in permission hook, notifies prompts and clears on finish', async () => {
  const h = await harness()
  let record = await h.call('createRecord', { title: 'Scoped plan', sessionID: 'parent' })
  record = await h.call('mutate', { recordID: record.id, expectedRevision: record.revision, op: { type: 'addTask', title: 'Update styles', allowedPaths: ['src/styles/', 'src/app.ts'] } })
  await h.call('requestApproval', { recordID: record.id, expectedRevision: record.revision, kind: 'plan' })
  await until(async () => (await h.store.get(record.id)).phase === 'approved')
  await h.mutate(record.id, { type: 'start' })
  await until(async () => h.created.length === 1)
  const builderID = h.created[0].id
  assert.match(h.prompts[0].text, /File scope restriction: only modify files matching src\/styles\/, src\/app\.ts\./)

  const ok = { sessionID: builderID, action: 'edit', resources: ['/project/src/styles/main.css'], effect: 'allow' as string, message: '' }
  h.evaluate(ok); assert.equal(ok.effect, 'allow')

  const denied = { sessionID: builderID, action: 'write', resources: ['/project/src/other.ts'], effect: 'allow' as string, message: '' }
  h.evaluate(denied); assert.equal(denied.effect, 'deny'); assert.match(denied.message, /Out-of-scope file edit blocked/)

  const escape = { sessionID: builderID, action: 'patch', resources: ['../outside.ts'], effect: 'allow' as string, message: '' }
  h.evaluate(escape); assert.equal(escape.effect, 'deny')

  const missing = { sessionID: builderID, action: 'edit', resources: [], effect: 'allow' as string, message: '' }
  h.evaluate(missing); assert.equal(missing.effect, 'deny')

  const read = { sessionID: builderID, action: 'read', resources: ['/project/package.json'], effect: 'allow' as string, message: '' }
  h.evaluate(read); assert.equal(read.effect, 'allow')

  const otherSession = { sessionID: 'parent', action: 'edit', resources: ['/project/src/other.ts'], effect: 'allow' as string, message: '' }
  h.evaluate(otherSession); assert.equal(otherSession.effect, 'allow')

  await h.finish(0, done)
  await until(async () => h.created.length === 2)
  assert.match(h.prompts[1].text, /Task file scope: src\/styles\/, src\/app\.ts\. Flag any file modified outside these paths as a major finding\./)

  // Builder scope map entry is cleaned up once the builder session finishes
  const afterFinish = { sessionID: builderID, action: 'edit', resources: ['/project/src/other.ts'], effect: 'allow' as string, message: '' }
  h.evaluate(afterFinish); assert.equal(afterFinish.effect, 'allow')
})
