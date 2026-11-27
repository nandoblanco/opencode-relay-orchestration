import { test } from 'node:test'
import { validateCheck } from '../src/store.ts'
test('check reason and screenshot directory reject control and format characters', () => {
  for (const field of ['reason', 'screenshotDir']) for (const value of ['bad\nvalue', 'bad\u202evalue', 'bad\u0000value']) {
    assert.throws(() => validateCheck({ id: 'check', name: 'Check', command: 'npm test', adapter: 'playwright', policy: 'manual-allowed', [field]: value }), /invalid_op/)
  }
})
import assert from 'node:assert/strict'
import { createStore, StoreError, isApproved, phases, type Op } from '../src/store.ts'
import { memoryStorage } from './helpers.ts'
const location = { directory: '/project', projectID: 'project' }
const verificationCheck = { id: 'check', name: 'Test', adapter: 'command' as const, command: 'npm test', policy: 'automated-required' as const }
test('check names are unique and the record check limit is twenty', async () => {
  const store = createStore(memoryStorage(), location); let r = await store.create('Checks')
  r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: verificationCheck })
  await assert.rejects(store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, id: 'duplicate-name' } }), /invalid_op/)
  for (let i = 1; i < 20; i++) r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, id: String(i), name: `Test ${i}` } })
  await assert.rejects(store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, id: 'extra', name: 'Extra' } }), /limit_exceeded/)
  assert.equal((await store.get(r.id)).checks.length, 20)
})
test('check command accepts 160 characters and rejects 161 without persisting', async () => {
  const store = createStore(memoryStorage(), location); let r = await store.create('Command limit')
  await assert.rejects(store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, command: 'x'.repeat(161) } }), /invalid_op/)
  r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, command: 'x'.repeat(160) } })
  assert.equal(r.checks[0].command.length, 160)
})
test('check names and commands reject invisible controls and accept ordinary shell syntax', async () => {
  const store = createStore(memoryStorage(), location); const r = await store.create('Visible commands')
  for (const character of ['\n', '\r', '\t', '\u001b', '\u202e', '\u200b', '\u009f', '\u00ad', '\u061c', '\u2060', '\u{e0001}']) {
    for (const field of ['name', 'command']) await assert.rejects(store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, [field]: `before${character}after` } }), /invalid_op/)
  }
  const command = 'node -e "console.log(\'ok\')" | findstr "ok" && echo done'
  const saved = await store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, name: 'Visible command', command } })
  assert.equal(saved.checks[0].command, command)
})
test('v2 migration is read-only and draft checks validate and invalidate plan revision', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  let r = await store.create('Checks'); const key = `relay/records/project/${r.id}`
  const { checks, ...old } = r; storage.data.set(key, { ...old, schemaVersion: 2 })
  assert.deepEqual((await store.get(r.id)).checks, []); assert.equal((storage.data.get(key) as any).schemaVersion, 2)
  for (const check of [{ ...verificationCheck, policy: 'not-applicable' }, { ...verificationCheck, name: 'x'.repeat(121) }, { ...verificationCheck, command: 'x'.repeat(1001) }, { ...verificationCheck, adapter: 'bad' }, { ...verificationCheck, policy: 'bad' }, { ...verificationCheck, adapter: 'playwright', screenshotDir: '../bad' }, { ...verificationCheck, adapter: 'playwright', screenshotDir: 'C:/bad' }, { ...verificationCheck, timeoutMs: 1800001 }]) await assert.rejects(store.mutate(r.id, r.revision, { type: 'addCheck', check } as Op), /invalid_op/)
  r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: verificationCheck }); assert.equal(r.planRevision, 2)
  r = await store.mutate(r.id, r.revision, { type: 'removeCheck', checkID: 'check' }); assert.equal(r.planRevision, 3)
  r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: verificationCheck })
  r = await store.approve(r.id, r.revision, async () => {})
  for (const phase of ['approved', 'running', 'interrupted', 'completed', 'cancelled']) {
    storage.data.set(key, { ...r, phase })
    for (const op of [{ type: 'addCheck', check: { ...verificationCheck, id: 'other' } }, { type: 'removeCheck', checkID: 'check' }] as Op[]) await assert.rejects(store.mutate(r.id, r.revision, op), /invalid_op/)
  }
})
test('manual evidence needs permission and full current evidence plus approving review gates sign-off', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  let r = await store.create('Manual'); r = await store.mutate(r.id, r.revision, { type: 'addTask', title: 'Task' })
  r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, policy: 'manual-allowed' } })
  r = await store.approve(r.id, r.revision, async () => {})
  r = await store.write(r.id, r.revision, next => { next.phase = 'interrupted'; next.interruptReason = 'manual verification required: Test'; next.tasks[0].status = 'running'; next.tasks[0].owner = { role: 'reviewer' } })
  const input = { recordID: r.id, taskID: r.tasks[0].id, stage: 'build' as const, role: 'builder' as const, model: { providerID: 'test', id: 'test' }, sessionID: 'worker', attempt: 1, status: 'reported' as const, startedAt: r.createdAt, report: { outcome: 'done' as const, summary: 'Done', checks: [] } }
  const build = await store.createRun(input)
  await store.createEvidence({ recordID: r.id, taskID: r.tasks[0].id, checkID: 'check', buildRunID: build.id, result: 'unverified', source: 'adapter', reason: 'unavailable', screenshots: [], startedAt: 1, endedAt: 1, durationMs: 0 })
  await assert.rejects(store.recordManual(r.id, r.revision, r.tasks[0].id, 'check', 'Checked', async () => { throw new StoreError('approval_denied') }), /approval_denied/)
  r = await store.recordManual(r.id, r.revision, r.tasks[0].id, 'check', 'Checked', async () => {})
  const evidence = (await store.listEvidence(r.id)).at(-1)!
  assert.equal(evidence.result, 'manually verified'); assert.equal(evidence.source, 'permission-assert')
  r = await store.write(r.id, r.revision, next => { next.phase = 'running'; next.tasks[0].status = 'completed' })
  await assert.rejects(store.signOff(r.id, r.revision, async () => {}), /verification_incomplete/)
  await store.createRun({ ...input, stage: 'review', role: 'reviewer', evidenceIDs: [evidence.id], report: { verdict: 'approve', summary: 'Reviewed', findings: [] } })
  await store.createRun({ ...input, attempt: 2, startedAt: new Date(Date.now() + 1).toISOString() })
  await assert.rejects(store.signOff(r.id, r.revision, async () => {}), /verification_incomplete/)
  const latestBuild = (await store.listRuns(r.id)).findLast(run => run.stage === 'build')!
  const fresh = await store.createEvidence({ ...evidence, buildRunID: latestBuild.id })
  await store.createRun({ ...input, stage: 'review', role: 'reviewer', attempt: 2, startedAt: new Date(Date.now() + 2).toISOString(), evidenceIDs: [fresh.id], report: { verdict: 'approve', summary: 'Reviewed', findings: [] } })
  assert.equal((await store.signOff(r.id, r.revision, async () => {})).phase, 'completed')
})
test('final-gate checks validate scope, skip intermediate tasks and require a fresh final approving review', async () => {
  assert.throws(() => validateCheck({ ...verificationCheck, scope: 'all' as any }), /invalid_op/)
  const store = createStore(memoryStorage(), location)
  let r = await store.create('Final gate')
  r = await store.mutate(r.id, r.revision, { type: 'addTask', title: 'UI edit' })
  r = await store.mutate(r.id, r.revision, { type: 'addTask', title: 'Update tests' })
  r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, id: 'lint', name: 'Lint', scope: 'task' } })
  r = await store.mutate(r.id, r.revision, { type: 'addCheck', check: { ...verificationCheck, id: 'e2e', name: 'E2E', scope: 'final' } })
  r = await store.approve(r.id, r.revision, async () => {})
  r = await store.write(r.id, r.revision, next => { next.phase = 'running'; next.tasks[0].status = 'completed'; next.tasks[1].status = 'completed' })
  const base = Date.now()
  const runInput = (taskID: string, stage: 'build' | 'review', offset: number, extra: Record<string, unknown> = {}) => ({
    recordID: r.id, taskID, stage, role: stage === 'build' ? 'builder' as const : 'reviewer' as const,
    model: { providerID: 'test', id: 'test' }, sessionID: 'worker', attempt: 1, status: 'reported' as const,
    startedAt: new Date(base + offset).toISOString(), endedAt: new Date(base + offset + 1).toISOString(),
    ...(stage === 'build' ? { report: { outcome: 'done' as const, summary: 'Done', checks: [] } } : { report: { verdict: 'approve' as const, summary: 'Ok', findings: [] } }),
    ...extra,
  })
  const b1 = await store.createRun(runInput(r.tasks[0].id, 'build', 10))
  const e1Lint = await store.createEvidence({ recordID: r.id, taskID: r.tasks[0].id, checkID: 'lint', buildRunID: b1.id, result: 'passed', source: 'adapter', screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 })
  await store.createRun(runInput(r.tasks[0].id, 'review', 20, { evidenceIDs: [e1Lint.id] }))
  const b2 = await store.createRun(runInput(r.tasks[1].id, 'build', 30))
  const e2Lint = await store.createEvidence({ recordID: r.id, taskID: r.tasks[1].id, checkID: 'lint', buildRunID: b2.id, result: 'passed', source: 'adapter', screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 })
  const e2Final = await store.createEvidence({ recordID: r.id, taskID: r.tasks[1].id, checkID: 'e2e', buildRunID: b2.id, result: 'passed', source: 'adapter', screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 })
  await store.createRun(runInput(r.tasks[1].id, 'review', 40, { evidenceIDs: [e2Lint.id] }))
  await assert.rejects(store.signOff(r.id, r.revision, async () => {}), /verification_incomplete/)
  await store.createRun(runInput(r.tasks[1].id, 'review', 50, { attempt: 2, evidenceIDs: [e2Lint.id, e2Final.id] }))
  // Rebuilding task 1 after task 2's final review invalidates the final gate until re-verified
  const b1Late = await store.createRun(runInput(r.tasks[0].id, 'build', 60, { attempt: 2 }))
  const e1LintLate = await store.createEvidence({ recordID: r.id, taskID: r.tasks[0].id, checkID: 'lint', buildRunID: b1Late.id, result: 'passed', source: 'adapter', screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 })
  await store.createRun(runInput(r.tasks[0].id, 'review', 70, { attempt: 2, evidenceIDs: [e1LintLate.id] }))
  await assert.rejects(store.signOff(r.id, r.revision, async () => {}), /verification_incomplete/)
  const e1FinalLate = await store.createEvidence({ recordID: r.id, taskID: r.tasks[0].id, checkID: 'e2e', buildRunID: b1Late.id, result: 'passed', source: 'adapter', screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 })
  await store.createRun(runInput(r.tasks[0].id, 'review', 80, { attempt: 3, evidenceIDs: [e1LintLate.id, e1FinalLate.id] }))
  assert.equal((await store.signOff(r.id, r.revision, async () => {})).phase, 'completed')
})
test('create, task, status, revisions and fresh instance persistence', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  const a = await store.create('Plan'); assert.equal(a.revision, 1)
  const b = await store.mutate(a.id, 1, { type: 'addTask', title: 'Build' })
  const c = await store.mutate(a.id, 2, { type: 'setTaskStatus', taskID: b.tasks[0].id, status: 'completed' })
  assert.equal(c.revision, 3); assert.equal(c.tasks[0].status, 'completed')
  assert.deepEqual(await createStore(storage, location).get(a.id), c)
  await assert.rejects(store.mutate(a.id, 1, { type: 'addTask', title: 'Stale' }), (error: StoreError) => error.code === 'stale_revision' && error.currentRevision === 3)
  await assert.rejects(createStore(storage, { ...location, projectID: 'other' }).get(a.id), /not_found/)
})
test('20 chained concurrent mutations serialize; shared revision has one winner', async () => {
  const store = createStore(memoryStorage(), location); const a = await store.create('Plan')
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.mutate(a.id, index + 1, { type: 'addTask', title: String(index) })))
  assert.equal((await store.get(a.id)).tasks.length, 20)
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.mutate(a.id, 21, { type: 'addTask', title: 'Race' })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'stale_revision').length, 19)
})
test('invalid operations and denied approval never persist; approvals bind original revision', async () => {
  const store = createStore(memoryStorage(), location); const a = await store.create('Plan')
  for (const op of [{ type: 'other' }, { type: 'addTask', title: '' }, { type: 'setTaskStatus', taskID: 'x', status: 'wrong' }]) await assert.rejects(store.mutate(a.id, 1, op as Op), /invalid_op/)
  await assert.rejects(store.approve(a.id, 1, async () => { throw new StoreError('approval_denied') }), /approval_denied/)
  assert.equal((await store.get(a.id)).approvals.length, 0)
  const approved = await store.approve(a.id, 1, async () => {})
  assert.equal(approved.approvals[0].revision, 1); assert.equal(approved.revision, 2)
})
test('approval validity and pagination', async () => {
  const store = createStore(memoryStorage(), location)
  const a = await store.create('Plan')
  assert.equal(isApproved(a, 'plan'), false)
  const b = await store.approve(a.id, 1, async () => {})
  assert.equal(isApproved(b, 'plan'), true)
  await assert.rejects(store.approve(a.id, 2, async () => {}), /invalid_op/)
  const d = await store.mutate(a.id, 2, { type: 'addTask', title: 'Change' })
  assert.equal(isApproved(d, 'plan'), false)
  for (let i = 0; i < 105; i++) await store.create(`Plan ${i}`)
  assert.equal((await store.list()).length, 106)
})
test('post-write mismatch is storage inconsistency', async () => {
  const storage = memoryStorage()
  const store = createStore({ ...storage, get: async key => { const value = await storage.get(key); return value ? { ...(value as object), revision: 999 } : undefined } }, location)
  await assert.rejects(store.create('Plan'), /storage_inconsistent/)
})
test('record title, task text and task count limits reject without revision changes', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  await assert.rejects(store.create('😀'.repeat(501)), /limit_exceeded/)
  const record = await store.create('Plan')
  await assert.rejects(store.mutate(record.id, 1, { type: 'addTask', title: 'x'.repeat(2001) }), /limit_exceeded/)
  const key = [...storage.data.keys()][0]
  storage.data.set(key, { ...record, tasks: Array.from({ length: 200 }, (_, i) => ({ id: String(i), title: 'Task', status: 'pending', updatedAt: record.updatedAt })) })
  await assert.rejects(store.mutate(record.id, 1, { type: 'addTask', title: 'Extra' }), /limit_exceeded/)
  assert.equal((await store.get(record.id)).revision, 1)
})
test('limits measure trimmed text and whitespace-only input is invalid', async () => {
  const store = createStore(memoryStorage(), location)
  await assert.rejects(store.create(' '.repeat(501)), /invalid_op/)
  const record = await store.create('  ' + 'x'.repeat(500) + '  ')
  assert.equal(record.title.length, 500)
  await assert.rejects(store.mutate(record.id, 1, { type: 'addTask', title: ' '.repeat(2001) }), /invalid_op/)
  const updated = await store.mutate(record.id, 1, { type: 'addTask', title: '  ' + 'x'.repeat(2000) + '  ' })
  assert.equal(updated.tasks[0].title.length, 2000)
})
test('revision changed during permission prompt stores no approval', async () => {
  const store = createStore(memoryStorage(), location); const a = await store.create('Plan')
  await assert.rejects(store.approve(a.id, 1, async () => { await store.mutate(a.id, 1, { type: 'addTask', title: 'Changed' }) }), /stale_revision/)
  assert.equal((await store.get(a.id)).approvals.length, 0)
})
test('every phase operation follows the explicit transition table', async () => {
  const allowed: Record<string, string[]> = { start: ['draft', 'approved'], interrupt: ['running'], resume: ['interrupted'], complete: ['running'], cancel: ['draft', 'approved', 'running', 'interrupted'] }
  for (const phase of phases) for (const type of Object.keys(allowed)) {
    const storage = memoryStorage(); const store = createStore(storage, location)
    const record = await store.approve((await store.create('Plan')).id, 1, async () => {})
    const key = [...storage.data.keys()][0]
    storage.data.set(key, { ...record, phase, tasks: [{ id: 'done', title: 'Done', status: 'completed', fixCycles: 0, updatedAt: record.updatedAt }] })
    const op = (type === 'interrupt' ? { type, reason: '  manual pause  ' } : { type }) as Op
    if (!allowed[type].includes(phase)) { await assert.rejects(store.mutate(record.id, record.revision, op), /invalid_op/); continue }
    if (type === 'complete') { await assert.rejects(store.mutate(record.id, record.revision, op), /approval_required/); continue }
    const result = await store.mutate(record.id, record.revision, op)
    assert.equal(result.phase, type === 'start' || type === 'resume' ? 'running' : type === 'interrupt' ? 'interrupted' : type === 'complete' ? 'completed' : 'cancelled')
    assert.equal(result.planRevision, record.planRevision); assert.equal(isApproved(result, 'plan'), true)
    if (type === 'interrupt') assert.equal(result.interruptReason, 'manual pause')
  }
})
test('approval gates, plan edits and interrupt reason validation', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  let record = await store.create('Plan')
  await assert.rejects(store.mutate(record.id, record.revision, { type: 'start' }), /approval_required/)
  const key = [...storage.data.keys()][0]
  storage.data.set(key, { ...record, phase: 'interrupted' })
  await assert.rejects(store.mutate(record.id, record.revision, { type: 'resume' }), /approval_required/)
  record = await store.mutate(record.id, record.revision, { type: 'addTask', title: 'Build' })
  assert.equal(record.phase, 'draft')
  record = await store.approve(record.id, record.revision, async () => {})
  record = await store.mutate(record.id, record.revision, { type: 'assignTask', taskID: record.tasks[0].id, owner: { role: 'builder', sessionID: 'worker' } })
  record = await store.mutate(record.id, record.revision, { type: 'setTaskStatus', taskID: record.tasks[0].id, status: 'blocked' })
  assert.equal(record.phase, 'approved'); assert.equal(isApproved(record, 'plan'), true)
  record = await store.mutate(record.id, record.revision, { type: 'addTask', title: 'Plan change' })
  assert.equal(record.phase, 'draft'); assert.equal(isApproved(record, 'plan'), false)
  await assert.rejects(store.mutate(record.id, record.revision, { type: 'start' }), /approval_required/)
  record = await store.approve(record.id, record.revision, async () => {})
  record = await store.mutate(record.id, record.revision, { type: 'start' })
  for (const reason of ['', '   ']) await assert.rejects(store.mutate(record.id, record.revision, { type: 'interrupt', reason }), /invalid_op/)
  await assert.rejects(store.mutate(record.id, record.revision, { type: 'interrupt', reason: '😀'.repeat(501) }), /limit_exceeded/)
  record = await store.mutate(record.id, record.revision, { type: 'interrupt', reason: '😀'.repeat(500) })
  assert.equal(Array.from(record.interruptReason!).length, 500)
  for (const phase of phases) {
    storage.data.set(key, { ...record, phase })
    if (['draft', 'approved', 'interrupted'].includes(phase)) assert.equal((await store.mutate(record.id, record.revision, { type: 'addTask', title: 'Edit' })).phase, 'draft')
    else await assert.rejects(store.mutate(record.id, record.revision, { type: 'addTask', title: 'Edit' }), /invalid_op/)
  }
})
test('owned running tasks enforce scheduling and fix-cycle limits without invalidating approval', async () => {
  for (const limits of [{}, { maxRunningTasks: 2, maxFixCycles: 0 }, { maxRunningTasks: '9', maxFixCycles: -1 }]) {
    const store = createStore(memoryStorage(), location, limits)
    let r = await store.create('Plan')
    for (const title of ['Build', 'Review']) r = await store.mutate(r.id, r.revision, { type: 'addTask', title })
    const [a, b] = r.tasks
    await assert.rejects(store.mutate(r.id, r.revision, { type: 'setTaskStatus', taskID: a.id, status: 'running' }), /invalid_op/)
    r = await store.approve(r.id, r.revision, async () => {})
    r = await store.mutate(r.id, r.revision, { type: 'start' })
    await assert.rejects(store.mutate(r.id, r.revision, { type: 'setTaskStatus', taskID: a.id, status: 'running' }), /invalid_op/)
    const internal = (op: Op) => store.write(r.id, r.revision, current => {
      const task = current.tasks.find(task => 'taskID' in op && task.id === op.taskID)!
      if (op.type === 'assignTask') task.owner = op.owner
      if (op.type === 'setTaskStatus') {
        if (op.status === 'running' && current.tasks.filter(task => task.status === 'running').length >= (limits.maxRunningTasks === 2 ? 2 : 1)) throw new Error('limit_exceeded')
        if (task.status === 'running' && op.status === 'pending') {
          if (task.fixCycles >= (limits.maxFixCycles === 0 ? 0 : 2)) throw new Error('limit_exceeded')
          task.fixCycles++
        }
        task.status = op.status
      }
    })
    for (const task of [a, b]) {
      await assert.rejects(store.mutate(r.id, r.revision, { type: 'assignTask', taskID: task.id, owner: { role: 'builder' } }), /invalid_op/)
      r = await internal({ type: 'assignTask', taskID: task.id, owner: { role: 'builder' } })
    }
    r = await internal({ type: 'setTaskStatus', taskID: a.id, status: 'running' })
    await assert.rejects(store.mutate(r.id, r.revision, { type: 'setTaskStatus', taskID: a.id, status: 'running' }), /invalid_op/)
    await assert.rejects(store.mutate(r.id, r.revision, { type: 'assignTask', taskID: a.id, owner: { role: 'reviewer' } }), /invalid_op/)
    if (limits.maxRunningTasks === 2) r = await internal({ type: 'setTaskStatus', taskID: b.id, status: 'running' })
    else await assert.rejects(internal({ type: 'setTaskStatus', taskID: b.id, status: 'running' }), /limit_exceeded/)
    const max = limits.maxFixCycles === 0 ? 0 : 2
    for (let i = 0; i < max; i++) {
      r = await internal({ type: 'setTaskStatus', taskID: a.id, status: 'pending' })
      assert.equal(r.tasks[0].fixCycles, i + 1)
      r = await internal({ type: 'setTaskStatus', taskID: a.id, status: 'running' })
    }
    await assert.rejects(internal({ type: 'setTaskStatus', taskID: a.id, status: 'pending' }), /limit_exceeded/)
    assert.equal(isApproved(r, 'plan'), true)
  }
})
test('v1 read and list migration preserve bytes until next write, including current and stale approvals', async () => {
  for (const approved of [true, false]) {
    const storage = memoryStorage(); const store = createStore(storage, location)
    const v1 = { schemaVersion: 1, id: 'old', revision: approved ? 3 : 4, title: 'Legacy', location, createdAt: '2026-01-01', updatedAt: '2026-01-01', tasks: [{ id: 'task', title: 'Build', status: 'pending', updatedAt: '2026-01-01' }], approvals: [{ kind: 'plan', revision: 2, approvedAt: '2026-01-01', source: 'permission-assert' }] }
    const key = 'relay/records/project/old'; storage.data.set(key, v1)
    const bytes = JSON.stringify(storage.data.get(key))
    const read = await store.get('old')
    assert.equal(read.schemaVersion, 3); assert.deepEqual(read.checks, []); assert.equal(read.phase, approved ? 'approved' : 'draft'); assert.equal(isApproved(read, 'plan'), approved)
    assert.deepEqual(await store.list(), [read]); assert.equal(JSON.stringify(storage.data.get(key)), bytes)
    const written = await store.mutate('old', read.revision, { type: 'assignTask', taskID: 'task', owner: { role: 'planner' } })
    assert.equal((storage.data.get(key) as any).schemaVersion, 3); assert.equal(isApproved(written, 'plan'), approved)
  }
})
test('startup reconciliation queues revision-checked interruption and is idempotent without auto-restart', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  let r = await store.create('Plan'); r = await store.approve(r.id, r.revision, async () => {}); r = await store.mutate(r.id, r.revision, { type: 'start' })
  const result = await createStore(storage, location).reconcile()
  assert.equal(result.length, 1); assert.equal(result[0].phase, 'interrupted'); assert.equal(result[0].interruptReason, 'server_restart'); assert.equal(result[0].revision, r.revision + 1)
  assert.deepEqual(await store.reconcile(), []); assert.equal((await store.get(r.id)).phase, 'interrupted')
  assert.equal((await store.mutate(r.id, result[0].revision, { type: 'resume' })).phase, 'running')
})
test('status and owner changes during an open prompt preserve the approved plan revision', async () => {
  const store = createStore(memoryStorage(), location)
  let r = await store.create('Plan'); r = await store.mutate(r.id, r.revision, { type: 'addTask', title: 'Build' })
  const approved = await store.approve(r.id, r.revision, async () => {
    r = await store.mutate(r.id, r.revision, { type: 'assignTask', taskID: r.tasks[0].id, owner: { role: 'builder' } })
    r = await store.mutate(r.id, r.revision, { type: 'setTaskStatus', taskID: r.tasks[0].id, status: 'completed' })
  })
  assert.equal(isApproved(approved, 'plan'), true); assert.equal(approved.phase, 'approved'); assert.equal(approved.revision, r.revision + 1)
})
test('terminal records reject edits and approval before permission; complete requires nonempty finished tasks', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  let r = await store.create('Plan'); r = await store.mutate(r.id, r.revision, { type: 'addTask', title: 'Task' })
  const key = [...storage.data.keys()][0]; let prompts = 0
  for (const phase of ['approved', 'running', 'interrupted', 'completed', 'cancelled'] as const) {
    storage.data.set(key, { ...r, phase })
    await assert.rejects(store.approve(r.id, r.revision, async () => { prompts++ }), /invalid_op/)
  }
  assert.equal(prompts, 0)
  for (const phase of ['completed', 'cancelled'] as const) {
    storage.data.set(key, { ...r, phase })
    for (const op of [{ type: 'addTask', title: 'No' }, { type: 'assignTask', taskID: r.tasks[0].id, owner: { role: 'builder' } }, { type: 'setTaskStatus', taskID: r.tasks[0].id, status: 'completed' }] as Op[]) await assert.rejects(store.mutate(r.id, r.revision, op), /invalid_op/)
  }
  for (const tasks of [[], r.tasks]) {
    storage.data.set(key, { ...r, phase: 'running', tasks })
    await assert.rejects(store.mutate(r.id, r.revision, { type: 'complete' }), /invalid_op/)
  }
  storage.data.set(key, { ...r, phase: 'running', tasks: r.tasks.map(task => ({ ...task, status: 'completed' })) })
  await assert.rejects(store.mutate(r.id, r.revision, { type: 'complete' }), /approval_required/)
  assert.equal((await store.signOff(r.id, r.revision, async () => {})).phase, 'completed')
})
test('owner session IDs are trimmed and capped; legacy running-to-pending consumes a fix cycle', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  let r = await store.create('Plan'); r = await store.mutate(r.id, r.revision, { type: 'addTask', title: 'Task' })
  r = await store.mutate(r.id, r.revision, { type: 'assignTask', taskID: r.tasks[0].id, owner: { role: 'builder', sessionID: ' worker ' } })
  assert.equal(r.tasks[0].owner?.sessionID, 'worker')
  await assert.rejects(store.mutate(r.id, r.revision, { type: 'assignTask', taskID: r.tasks[0].id, owner: { role: 'builder', sessionID: 'x'.repeat(201) } }), /limit_exceeded/)
  const key = [...storage.data.keys()][0]
  storage.data.set(key, { ...r, schemaVersion: 1, tasks: r.tasks.map(task => ({ ...task, status: 'running' })) })
  assert.equal((await store.mutate(r.id, r.revision, { type: 'setTaskStatus', taskID: r.tasks[0].id, status: 'pending' })).tasks[0].fixCycles, 1)
})
test('reconcile skips a record changed between scan and queued write and remains idempotent', async () => {
  const storage = memoryStorage(); const store = createStore(storage, location)
  let r = await store.create('Race'); r = await store.approve(r.id, r.revision, async () => {}); r = await store.mutate(r.id, r.revision, { type: 'start' })
  let race = true
  const raced = createStore({ ...storage, scan: async options => { const page = await storage.scan(options); if (race) { race = false; await store.mutate(r.id, r.revision, { type: 'interrupt', reason: 'Other instance' }) }; return page } }, location)
  assert.deepEqual(await raced.reconcile(), []); assert.deepEqual(await raced.reconcile(), [])
  assert.equal((await store.get(r.id)).interruptReason, 'Other instance')
})
test('reconcile logs one failed record and still interrupts a later record', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  const storage = memoryStorage(); const store = createStore(storage, location)
  const records = []
  for (let i = 0; i < 2; i++) { let r = await store.create(`Plan ${i}`); r = await store.approve(r.id, r.revision, async () => {}); records.push(await store.mutate(r.id, r.revision, { type: 'start' })) }
  const first = (await store.list())[0]
  const failing = createStore({ ...storage, set: async (key, value) => { if (key.endsWith(first.id)) throw Error('write failed'); await storage.set(key, value) } }, location)
  assert.equal((await failing.reconcile()).length, 1); assert.equal(logs.mock.callCount(), 1)
  assert.equal((await store.get(first.id)).phase, 'running'); assert.equal((await store.list()).filter(r => r.phase === 'interrupted').length, 1)
})
