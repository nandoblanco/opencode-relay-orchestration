import { test } from 'node:test'
test('screenshot inspection escalation explains exact-name recovery', () => {
  assert.equal(interruptionMessage('escalated: screenshot inspection incomplete'), 'Screenshot inspection incomplete. The reviewer must inspect and list every attached screenshot by its exact name. Resolve the blocked task, then resume.')
})
import assert from 'node:assert/strict'
import { recordView, renderStatus, approvalMessage, visibleError, failureMessage, tokenTotals, signOffMessage, signOffError } from '../src/view.ts'
import type { RunInfo } from '../src/model.ts'
import { createStore } from '../src/store.ts'
import { memoryStorage } from './helpers.ts'
import { checkView, evidenceView, canRecordManual, interruptionMessage } from '../src/view.ts'
import { evidenceTitle } from '../src/view.ts'
test('cancel reason is optional for legacy records and failed builder attempts are counted', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Reasons')
  record.phase = 'cancelled'
  assert.equal(recordView(record).reason, '')
  record.cancelReason = 'Already implemented'
  assert.equal(recordView(record).reason, 'Cancelled: Already implemented')
  assert.match(renderStatus(record), /Cancelled: Already implemented/)
  record.tasks = [{ id: 'task', title: 'Task', status: 'completed', fixCycles: 0, updatedAt: record.updatedAt }]
  const run: RunInfo = { id: 'build', recordID: record.id, taskID: 'task', stage: 'build', role: 'builder', model: { providerID: 'test', id: 'build' }, sessionID: 'child', attempt: 1, status: 'reported', startedAt: record.createdAt, report: { outcome: 'done', summary: 'Done', checks: [{ command: 'test', result: 'failed' }, { command: 'test', result: 'passed' }, { command: 'lint', result: 'passed' }] } }
  assert.equal(recordView(record, [run]).tasks[0].checks, 'Builder self-checks: 2 passed, 1 failed (self-reported, unverified)')
  if (run.report && 'checks' in run.report) run.report.checks.shift()
  assert.equal(recordView(record, [run]).tasks[0].checks, '2 builder checks (self-reported, unverified)')
})
test('planner session token delta and legacy rendering', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Tokens')
  assert.doesNotMatch(renderStatus(record), /Planner session tokens/)
  record.plannerSession = { tokensAtStart: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } }
  assert.match(renderStatus(record), /Planner session tokens: tracking/)
  record.plannerSession.tokensAtEnd = { input: 110, output: 22, reasoning: 6, cache: { read: 43, write: 0 } }
  assert.equal(recordView(record).plannerTokens, 'Planner session tokens: input +100, output +20, reasoning +5, cache read +40')
  assert.match(renderStatus(record), /input \+100, output \+20, reasoning \+5, cache read \+40/)
})
test('terminal planner records without end totals render unavailable', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Unavailable')
  record.plannerSession = { tokensAtStart: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 1 } } }
  for (const phase of ['completed', 'cancelled'] as const) {
    record.phase = phase
    assert.equal(recordView(record).plannerTokens, 'Planner session tokens: unavailable')
    assert.doesNotMatch(renderStatus(record), /tracking/)
  }
})
test('any decreased session token total makes the delta unavailable', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Decreased')
  const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 1 } }
  for (const field of ['input', 'output', 'reasoning', 'read', 'write'] as const) {
    const end = structuredClone(tokens)
    if (field === 'read' || field === 'write') end.cache[field]--
    else end[field]--
    record.plannerSession = { tokensAtStart: tokens, tokensAtEnd: end }
    assert.equal(recordView(record).plannerTokens, 'Planner session tokens: unavailable (session total decreased)')
    assert.doesNotMatch(renderStatus(record), /\+-/)
  }
})
test('verification display caps task titles and commands and explains image recovery', async () => {
  assert.equal(evidenceTitle('Task.'), 'Task'); assert.ok(Array.from(evidenceTitle('Task '.repeat(40))).length <= 40)
  const r = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Checks')
  r.checks = [{ id: 'check', name: 'Browser', adapter: 'command', command: 'npm test ' + 'x'.repeat(151), policy: 'automated-required' }]
  r.tasks = [{ id: 'task', title: 'Task.', status: 'pending', fixCycles: 0, updatedAt: r.updatedAt }]
  const text = renderStatus(r)
  assert.ok(text.includes(`Command: ${r.checks[0].command}\n`))
  assert.match(text, /Command: npm test/); assert.match(text, /Task: Unverified/); assert.doesNotMatch(text, /Task\.:|0 screenshot/)
  r.checks[0].policy = 'not-applicable'; r.checks[0].reason = 'No browser'
  assert.equal(renderStatus(r).split('No browser').length - 1, 1)
  assert.match(interruptionMessage('escalated: screenshot review unavailable'), /reviewer model with image input/)
  assert.match(interruptionMessage('escalated: screenshot changed after check'), /Restore the verification output/)
})
import type { Check, Evidence } from '../src/model.ts'
test('legacy review without inspected renders through shared panel and text views', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Legacy review')
  record.tasks = [{ id: 'task', title: 'Reviewed task', status: 'completed', fixCycles: 0, updatedAt: record.updatedAt }]
  const run: RunInfo = { id: 'review', recordID: record.id, taskID: 'task', stage: 'review', role: 'reviewer', model: { providerID: 'test', id: 'review' }, sessionID: 'worker', attempt: 1, status: 'reported', startedAt: record.createdAt, report: { verdict: 'approve', summary: 'Legacy readable summary', findings: [] } }
  assert.equal(recordView(record, [run]).tasks[0].summary, 'Legacy readable summary')
  assert.match(renderStatus(record, [run]), /Legacy readable summary/)
})
test('verification views distinguish plugin, user, unavailable, not applicable and stale evidence', async () => {
  const r = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Checks')
  const check: Check = { id: 'check', name: 'Browser', adapter: 'playwright', command: 'npm test', policy: 'manual-allowed' }
  const evidence: Evidence = { id: 'evidence', recordID: r.id, taskID: 'task', checkID: check.id, buildRunID: 'build', result: 'passed', source: 'adapter', screenshots: [{ path: 'image.png', sha256: 'hash', bytes: 1 }], startedAt: 1, endedAt: 2, durationMs: 1 }
  const run: RunInfo = { id: 'build', recordID: r.id, taskID: 'task', stage: 'build', role: 'builder', model: { providerID: 'test', id: 'test' }, sessionID: 'worker', attempt: 1, status: 'reported', startedAt: r.createdAt }
  assert.equal(evidenceView(check, evidence, [run]).label, 'Passed (plugin-run)')
  assert.equal(evidenceView(check, evidence, [run]).screenshots, '1 screenshot(s)')
  assert.equal(evidenceView(check, { ...evidence, result: 'failed' }, [run]).label, 'Failed (plugin-run)')
  assert.equal(evidenceView(check, { ...evidence, result: 'unverified', reason: 'unavailable' }, [run]).label, 'Unverified: unavailable')
  assert.equal(evidenceView(check, { ...evidence, result: 'manually verified', note: 'Checked' }, [run]).label, 'Manually verified by user: Checked')
  assert.equal(evidenceView(check, evidence, []).label, 'Passed (plugin-run) (stale)')
  assert.equal(checkView({ ...check, policy: 'not-applicable', reason: 'No browser' }).label, 'Not applicable: No browser')
  assert.equal(checkView({ ...check, scope: 'final' }).label, 'Browser (manual-allowed, final gate)')
  assert.equal(evidenceView({ ...check, scope: 'final' }, undefined, [], true).label, 'Deferred to final gate')
  assert.equal(evidenceView({ ...check, policy: 'not-applicable', reason: 'No browser' }, undefined, []).label, 'Not applicable: No browser')
  r.phase = 'interrupted'; r.interruptReason = 'manual verification required: Browser'; r.tasks = [{ id: 'task', title: 'Task', status: 'running', owner: { role: 'reviewer' }, fixCycles: 0, updatedAt: r.updatedAt }]
  assert.equal(canRecordManual(r, 'task', check, [{ ...evidence, result: 'unverified' }], [run]), true)
  assert.equal(canRecordManual(r, 'task', check, [{ ...evidence, result: 'failed' }], [run]), false)
  assert.match(interruptionMessage(r.interruptReason), /Record your verification/)
  assert.match(interruptionMessage('verification unavailable: Browser'), /Configure the environment/)
  assert.match(failureMessage('verification_incomplete'), /Verification is incomplete/)
})
test('TUI, GUI and text share view fields', async () => {
  const store = createStore(memoryStorage(), { directory: '/project', projectID: 'project' })
  const a = await store.create('Plan'); const b = await store.mutate(a.id, 1, { type: 'addTask', title: 'Build' })
  const view = recordView(b); const text = renderStatus(b)
  for (const field of [view.title, view.revision, view.location, view.tasks[0].title, view.tasks[0].label]) assert.ok(text.includes(field))
  assert.equal(text, 'Plan\nRevision 2\n/project\nPhase: draft\nTokens: input 0, output 0, reasoning 0, cache read 0, cache write 0\n\nTasks\n1 pending\npending: Build\n  Pending\n\nActions:\nrelay-cancel')
  assert.deepEqual(view.tasks.map(({ title, label }) => ({ title, label })), [{ title: 'Build', label: 'pending' }])
  assert.equal(approvalMessage({ ...b, phase: 'approved', revision: 3, approvals: [{ kind: 'plan', revision: 2, planRevision: b.planRevision, approvedAt: b.updatedAt, source: 'permission-assert' }], approvalResult: { revision: 2, outcome: 'approved', at: b.updatedAt } }), 'Plan approved for revision 2')
  assert.equal(approvalMessage({ ...b, revision: 4, approvalResult: { revision: 2, outcome: 'approved', at: b.updatedAt } }), '')
  assert.equal(approvalMessage({ ...b, revision: 3, pendingApproval: { key: `${b.id}@3`, revision: 3 }, approvalResult: { revision: 2, outcome: 'approved', at: b.updatedAt } }), '')
  assert.equal(approvalMessage({ ...b, revision: 3, approvalResult: { revision: 2, outcome: 'rejected', at: b.updatedAt } }), '')
  assert.equal(approvalMessage({ ...b, approvalResult: { revision: 2, outcome: 'rejected', at: b.updatedAt } }), 'Approval rejected')
  assert.equal(approvalMessage({ ...b, approvalResult: { revision: 2, outcome: 'stale', at: b.updatedAt } }), 'Plan changed; approval not recorded')
})
test('approval outcomes replace only matching approval error banners', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Plan')
  const stale = { ...record, approvalResult: { revision: record.revision, outcome: 'stale' as const, at: record.updatedAt } }
  const rejected = { ...record, approvalResult: { revision: record.revision, outcome: 'rejected' as const, at: record.updatedAt } }
  const approved = { ...record, revision: record.revision + 1, approvalResult: { revision: record.revision, outcome: 'approved' as const, at: record.updatedAt } }
  assert.equal(visibleError({ type: 'stale_revision' }, stale, true), '')
  assert.equal(visibleError(Error('approval_denied'), rejected, true), '')
  for (const [snapshot, code] of [[stale, 'stale_revision'], [rejected, 'approval_denied']] as const) {
    const pending = { ...snapshot, pendingApproval: { key: `${record.id}@${record.revision}`, revision: record.revision } }
    assert.equal(approvalMessage(pending), '')
    assert.equal(visibleError(code, pending, true), failureMessage(code))
  }
  assert.match(visibleError({ type: 'stale_revision' }, approved), /This record changed/)
  assert.match(visibleError({ type: 'stale_revision' }, stale), /This record changed/)
  assert.match(visibleError({ type: 'stale_revision' }, rejected, true), /This record changed/)
  assert.match(visibleError({ type: 'approval_denied' }, stale, true), /was denied/)
  assert.match(visibleError({ type: 'stale_revision' }, approved, true), /This record changed/)
  assert.equal(visibleError({ type: 'invalid_op' }, stale), 'This action is not available for the selected record or session.')
  assert.equal(visibleError({ type: 'approval_pending' }, rejected), 'An approval request is already waiting in the session prompt.')
  assert.match(visibleError({ type: 'stale_revision' }, record), /This record changed/)
  assert.match(visibleError({ type: 'approval_denied' }, record), /was denied/)
})
test('shared approval history keeps the last three and counts earlier entries', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Plan')
  assert.deepEqual(recordView(record).approvals, [])
   for (let revision = 1; revision <= 5; revision++) record.approvals.push({ kind: 'plan', revision, planRevision: revision, approvedAt: record.updatedAt, source: 'permission-assert' })
  const view = recordView(record)
  assert.equal(view.approvals.length, 4)
  assert.equal(view.approvals[0], '(2 earlier)')
  assert.deepEqual(view.approvals.slice(1).map(line => line.match(/revision (\d+)/)![1]), ['3', '4', '5'])
  assert.equal(renderStatus(record), ['Plan\nRevision 1\n/project\nPhase: draft\n' + recordView(record).tokens, 'Tasks\nNo tasks yet', ['Approvals', ...view.approvals].join('\n'), 'Actions:\nrelay-cancel'].join('\n\n'))
  record.approvals = record.approvals.slice(-4)
  assert.equal(recordView(record).approvals[0], '(1 earlier)')
  assert.equal(recordView(record).approvals.length, 4)
  record.approvals = record.approvals.slice(-3)
  assert.equal(recordView(record).approvals.length, 3)
  assert.equal(recordView(record).approvals.some(line => line.includes('earlier')), false)
})
test('all store errors have the same readable message across failure shapes', () => {
  const messages = {
    stale_revision: 'This record changed. Review the refreshed snapshot and retry.',
    not_found: 'This record could not be found. Refresh to choose another.',
    approval_denied: 'The approval request was denied.',
    invalid_op: 'This action is not available for the selected record or session.',
    approval_pending: 'An approval request is already waiting in the session prompt.',
    storage_inconsistent: 'Storage verification failed. Stop making changes and check the server.',
    limit_exceeded: 'A record limit was exceeded. Check title, task text, owner session and interrupt reason lengths, task count, running tasks and fix cycles.',
  }
  for (const [code, message] of Object.entries(messages)) {
    for (const failure of [code, Error(code), { type: code }]) assert.equal(failureMessage(failure), message)
  }
  for (const failure of ['unknown_code', Error('unknown_code'), { type: 'unknown_code', message: 'unknown_code' }]) {
    assert.equal(failureMessage(failure), 'This action could not be completed. Refresh and try again.')
    assert.doesNotMatch(failureMessage(failure), /unknown_code/)
  }
  for (const code of ['constructor', '__proto__', 'toString']) assert.equal(failureMessage(code), 'This action could not be completed. Refresh and try again.')
})
test('status text caps tasks and counts every status in store order', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Dense')
  assert.equal(renderStatus(record), 'Dense\nRevision 1\n/project\nPhase: draft\n' + recordView(record).tokens + '\n\nTasks\nNo tasks yet\n\nActions:\nrelay-cancel')
  assert.equal(renderStatus(), 'No relay record\n\nTasks\nNo tasks yet')
  record.tasks = Array.from({ length: 15 }, (_, i) => ({ id: String(i), title: `Task ${i + 1}`, fixCycles: 0, updatedAt: record.updatedAt, status: i < 11 ? 'pending' : i === 11 ? 'running' : i === 12 ? 'blocked' : i === 13 ? 'awaiting_approval' : 'completed' }))
  assert.equal(renderStatus(record), ['Dense\nRevision 1\n/project\nPhase: draft\n' + recordView(record).tokens, ['Tasks', '11 pending, 1 running, 1 blocked, 1 awaiting approval, 1 completed', ...record.tasks.slice(0, 12).map(task => `${task.status}: ${task.title}\n  ${task.status === 'running' ? 'Building' : 'Pending'}`), '(+3 more tasks)'].join('\n'), 'Actions:\nrelay-cancel'].join('\n\n'))
})
test('phase and interruption reason render with only available transition commands', async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Paused')
  const interrupted = { ...record, phase: 'interrupted' as const, interruptReason: 'server_restart' }
  assert.match(renderStatus(interrupted), /Phase: interrupted\nInterrupted: server restarted/)
  assert.deepEqual(recordView(interrupted).actions, ['cancel'])
  interrupted.approvals.push({ kind: 'plan', revision: 1, planRevision: record.planRevision, approvedAt: record.updatedAt, source: 'permission-assert' })
  assert.deepEqual(recordView(interrupted).actions, ['resume', 'cancel'])
  assert.deepEqual(recordView({ ...record, phase: 'running' }).actions, ['interrupt', 'cancel'])
  for (const phase of ['completed', 'cancelled'] as const) assert.deepEqual(recordView({ ...record, phase }).actions, [])
  for (const failure of ['approval_required', Error('approval_required'), { type: 'approval_required' }]) assert.equal(failureMessage(failure), 'Approve the current plan before starting or resuming work.')
})
test('v2 approval confirmation follows plan revision after concurrent status or owner changes; v1 follows record revision', async () => {
  const r = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Plan')
  const approved = { ...r, phase: 'approved' as const, revision: 5, approvalResult: { revision: 1, outcome: 'approved' as const, at: r.updatedAt }, approvals: [{ kind: 'plan' as const, revision: 1, planRevision: 1, approvedAt: r.updatedAt, source: 'permission-assert' as const }] }
  assert.equal(approvalMessage(approved), 'Plan approved for revision 1')
  assert.equal(approvalMessage({ ...approved, planRevision: 2 }), '')
  for (const phase of ['running', 'interrupted', 'completed', 'cancelled'] as const) assert.equal(approvalMessage({ ...approved, phase }), '')
  assert.equal(approvalMessage({ ...approved, schemaVersion: 1 } as any), '')
  assert.equal(approvalMessage({ ...approved, schemaVersion: 1, revision: 2 } as any), 'Plan approved for revision 1')
})
test('run formatting derives stages, findings, checks, bounded summaries, escalation and token totals', async () => {
  const r = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Workers')
  r.phase = 'running'; r.tasks = [{ id: 'task', title: 'Build it', status: 'running', owner: { role: 'builder' }, fixCycles: 1, updatedAt: r.updatedAt }]
  const run: RunInfo = { id: 'build', recordID: r.id, taskID: 'task', stage: 'build', role: 'builder', model: { providerID: 'test', id: 'model' }, sessionID: 'worker', attempt: 2, status: 'reported', startedAt: r.createdAt, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } }, report: { outcome: 'done', summary: 'Long summary '.repeat(100), checks: [{ command: 'test', result: 'passed' }] } }
  const review: RunInfo = { ...run, id: 'review', stage: 'review', role: 'reviewer', attempt: 1, report: { verdict: 'changes', summary: 'Fix the edge case', findings: [{ severity: 'major', text: 'Missing assertion' }, { severity: 'minor', text: 'Label' }] } }
  const runs = [run, review]
  assert.deepEqual(tokenTotals(runs), { input: 20, output: 10, reasoning: 4, cache: { read: 6, write: 8 } })
  assert.equal(recordView(r, runs).tasks[0].stage, 'Building')
  r.tasks[0].owner = { role: 'reviewer' }
  const task = recordView(r, runs).tasks[0]
  assert.equal(task.stage, 'Reviewing'); assert.equal(task.attempt, 1); assert.equal(task.findings, '2 findings (1 major)')
  assert.equal(task.checks, '1 builder check (self-reported, unverified)')
  assert.equal(recordView(r, runs).canEdit, false)
  assert.match(renderStatus(r, runs), /Reviewing, attempt 1/); assert.match(renderStatus(r, runs), /Tokens: input 20, output 10/)
  assert.ok(renderStatus(r, [run]).split('\n').some(line => line.endsWith('...') && line.length <= 162))
  r.tasks[0].status = 'blocked'; r.phase = 'interrupted'; r.interruptReason = 'escalated: no report'
  assert.equal(recordView(r, runs).tasks[0].stage, 'Blocked'); assert.equal(recordView(r).canEdit, true)
  assert.match(recordView(r).reason, /Needs your attention: no report/); assert.doesNotMatch(recordView(r).reason, /escalated:/)
  r.tasks[0].status = 'completed'; r.phase = 'running'
  assert.equal(recordView(r).tasks[0].stage, 'Done'); assert.equal(recordView(r).canSignOff, true)
  assert.match(renderStatus(r), /relay-signoff/); assert.doesNotMatch(renderStatus(r), /relay-complete/)
  assert.equal(signOffMessage(42), 'Waiting for sign-off of revision 42')
  for (const failure of ['approval_denied', Error('approval_denied'), { type: 'approval_denied' }]) assert.equal(signOffError(failure), 'Sign-off was denied. The record is still running.')
})
test('equal timestamp runs sort by attempt, build before review, then id and select the latest report', async () => {
  const storage = memoryStorage(); const store = createStore(storage, { directory: '/project', projectID: 'project' })
  const r = await store.create('Tied runs')
  r.tasks = [{ id: 'task', title: 'Task', status: 'completed', fixCycles: 1, updatedAt: r.updatedAt }]
  for (const [id, attempt, stage] of [['z', 2, 'review'], ['b', 1, 'review'], ['a', 1, 'build'], ['c', 2, 'build']] as const) {
    await storage.set(`relay/runs/project/${r.id}/${id}`, { id, recordID: r.id, taskID: 'task', stage, role: stage === 'build' ? 'builder' : 'reviewer', model: { providerID: 'test', id: 'model' }, sessionID: id, attempt, status: 'reported', startedAt: '2026-11-21T12:00:00.000Z', report: stage === 'build' ? { outcome: 'done', summary: id, checks: [] } : { verdict: 'approve', summary: id, findings: [] } })
  }
  const runs = await store.listRuns(r.id)
  assert.deepEqual(runs.map(run => run.attempt), [1, 1, 2, 2])
  assert.deepEqual(runs.map(run => run.id), ['a', 'b', 'c', 'z'])
  assert.equal(recordView(r, runs).tasks[0].summary, 'z')
  assert.equal(recordView(r, runs).tasks[0].attempt, 2)
})
test('one finding is singular and terminal summaries avoid four dots or split owner brackets', async () => {
  const r = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Summary')
  r.tasks = [{ id: 'task', title: 'Task', status: 'completed', owner: { role: 'reviewer' }, fixCycles: 0, updatedAt: r.updatedAt }]
  const run: RunInfo = { id: 'run', recordID: r.id, taskID: 'task', stage: 'review', role: 'reviewer', model: { providerID: 'test', id: 'model' }, sessionID: 'worker', attempt: 1, status: 'reported', startedAt: r.createdAt, report: { verdict: 'approve', summary: 'x'.repeat(156) + '. More text.', findings: [{ severity: 'minor', text: 'Note' }] } }
  assert.equal(recordView(r, [run]).tasks[0].findings, '1 finding (0 major)')
  const output = renderStatus(r, [run])
  assert.ok(output.includes('x'.repeat(156) + '...'))
  assert.doesNotMatch(output, /\.{4}|\[reviewer\]/)
  assert.match(output, /Done, attempt 1, owner reviewer/)
})
