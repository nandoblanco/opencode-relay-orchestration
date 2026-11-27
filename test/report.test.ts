import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditMarkdown, auditSummary } from '../src/report.ts'
import { createStore } from '../src/store.ts'
import { memoryStorage } from './helpers.ts'
import type { RunInfo, Evidence } from '../src/model.ts'

for (const phase of ['completed', 'cancelled', 'draft'] as const) test(`audit Markdown ${phase} escapes text and supports legacy fields`, async () => {
  const record = await createStore(memoryStorage(), { directory: '/project', projectID: 'project' }).create('Title | `unsafe`\nnext\u202e')
  record.phase = phase
  record.approvals = [{ kind: 'plan', revision: 1, planRevision: 1, approvedAt: record.createdAt, source: 'permission-assert' }]
  if (phase !== 'draft') record.plannerSession = { tokensAtStart: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, tokensAtEnd: { input: 11, output: 3, reasoning: 1, cache: { read: 3, write: 0 } } }
  if (phase === 'cancelled') record.cancelReason = 'Already | done'
  record.tasks = [{ id: 'task', title: 'Task\nnext', status: 'completed', owner: { role: 'builder', sessionID: 'child' }, fixCycles: 1, updatedAt: record.updatedAt }]
  record.checks = [{ id: 'check', name: 'Browser', adapter: 'playwright', policy: 'automated-required', command: 'npm test' }]
  const run: RunInfo = { id: 'run', recordID: record.id, taskID: 'task', stage: 'review', role: 'reviewer', model: { providerID: 'test', id: 'review', variant: 'high' }, sessionID: 'child', attempt: 1, status: 'reported', durationMs: 25, startedAt: record.createdAt, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } }, report: { verdict: 'approve', summary: 'Checked | `all`', findings: [{ severity: 'minor', text: 'One\nline' }], ...(phase === 'draft' ? {} : { inspected: ['page.png hash'] }) } }
  const evidence: Evidence = { id: 'evidence', recordID: record.id, taskID: 'task', checkID: 'check', buildRunID: 'build', result: 'passed', source: 'adapter', screenshots: [{ path: 'C:\\private\\shots\\page.png', sha256: 'abc123', bytes: 10 }], startedAt: 1, endedAt: 2, durationMs: 1 }
  const markdown = auditMarkdown(record, [run], [evidence])
  assert.match(markdown, /Title &#124; &#96;unsafe&#96; next/)
  assert.match(markdown, /test\/review\/high/); assert.match(markdown, /page.png; sha256 abc123/)
  assert.doesNotMatch(markdown, /C:|private|cost|\u202e/)
  assert.match(markdown, /fix cycles 1/); assert.match(markdown, /Tokens: input 10/)
  assert.equal(markdown.includes('Cancelled:'), phase === 'cancelled')
  assert.equal(markdown.includes('Inspected:'), phase !== 'draft')
  if (phase === 'draft') assert.doesNotMatch(markdown, /Planner session tokens/)
  else assert.match(markdown, /Planner session tokens: input \+10, output \+2/)
  assert.match(markdown, /plan; revision 1; permission-assert/)
  assert.match(auditSummary(record, [run]), /1 run;.*review approve/)
})
test('audit redacts delimited absolute paths everywhere except location and preserves URLs', async () => {
  const record = await createStore(memoryStorage(), { directory: '/allowed/project', projectID: 'project' }).create('Paths')
  const paths = '`C:\\workspace\\x\\y.png` "/home/user/a.png" [C:/workspace/x] =/Users/person/a.png ,/home/user/b.png :C:\\workspace\\z https://example.com/a/b'
  record.cancelReason = paths
  record.tasks = [{ id: 'task', title: 'Task', status: 'completed', owner: { role: 'reviewer', sessionID: 'ses_hidden' }, fixCycles: 0, updatedAt: record.updatedAt }]
  record.checks = [{ id: 'check', name: paths, command: paths, adapter: 'command', policy: 'manual-allowed' }]
  const run: RunInfo = { id: 'run', recordID: record.id, taskID: 'task', stage: 'review', role: 'reviewer', model: { providerID: 'test', id: 'review' }, sessionID: 'child', attempt: 2, status: 'reported', startedAt: record.createdAt, report: { verdict: 'approve', summary: paths, findings: [{ severity: 'minor', text: paths }], inspected: [paths] } }
  const evidence: Evidence = { id: 'evidence', recordID: record.id, taskID: 'task', checkID: 'check', buildRunID: 'build', result: 'manually verified', source: 'permission-assert', note: paths, exitCode: 0, screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 }
  const markdown = auditMarkdown(record, [run], [evidence])
  assert.doesNotMatch(markdown, /C:|workspace|\/home|\/Users|ses_hidden/)
  assert.match(markdown, /https:\/\/example.com\/a\/b/)
  assert.match(markdown, /- Location: \/allowed\/project/)
  assert.match(markdown, /Task; attempt 2; approve/)
  assert.match(markdown, /Task:.*note:.*exit code: 0/)
  assert.match(markdown, /\n- Phase:/); assert.match(markdown, /\n- Tokens:/)
})
test('audit redacts file URLs, doubled drive slashes, UNC and home paths without altering safe text', async () => {
  const record = await createStore(memoryStorage(), { directory: '/allowed/project', projectID: 'project' }).create('Paths')
  for (const path of ['file:///C:/private/x.png', 'C://private/x', '\\\\server\\share\\x', '~/proj/x', '~\\proj']) {
    record.cancelReason = path
    const markdown = auditMarkdown(record, [], [])
    assert.match(markdown, /- Cancelled: \\\[path\\\]/)
    assert.ok(!markdown.includes(path))
  }
  const safe = '11/23/2026 1/2 and/or input/output relative/path ./local/path https://example.com/a/b http://example.com/a/b'
  record.cancelReason = safe
  assert.ok(auditMarkdown(record, [], []).includes(`- Cancelled: ${safe}`))
})
test('audit preserves closing HTML/XML tags while redacting angle-bracketed paths and compacts long task titles', async () => {
  const record = await createStore(memoryStorage(), { directory: '/allowed/project', projectID: 'project' }).create('Tags')
  const longTitle = 'Update footer element and verify responsive breakpoints across desktop and mobile viewports with zero overflow'
  record.cancelReason = 'Keep </footer> </h2 > </svg:path> but redact </etc/passwd> <C:\\secret\\a.txt> and /footer>'
  record.tasks = [{ id: 'task', title: longTitle, status: 'completed', fixCycles: 0, updatedAt: record.updatedAt }]
  record.checks = [{ id: 'check', name: 'Browser', adapter: 'playwright', policy: 'automated-required', command: 'npm test' }]
  const run: RunInfo = { id: 'run', recordID: record.id, taskID: 'task', stage: 'review', role: 'reviewer', model: { providerID: 'test', id: 'review' }, sessionID: 'child', attempt: 1, status: 'reported', startedAt: record.createdAt, report: { verdict: 'approve', summary: 'Checked </footer>', findings: [] } }
  const evidence: Evidence = { id: 'evidence', recordID: record.id, taskID: 'task', checkID: 'check', buildRunID: 'build', result: 'passed', source: 'adapter', screenshots: [], startedAt: 1, endedAt: 2, durationMs: 1 }
  const markdown = auditMarkdown(record, [run], [evidence])
  assert.ok(markdown.includes('&lt;/footer&gt; &lt;/h2 &gt; &lt;/svg:path&gt;'))
  assert.ok(markdown.includes('redact &lt;\\[path\\]&gt; &lt;\\[path\\]&gt; and \\[path\\]&gt;'))
  assert.doesNotMatch(markdown, /\/etc\/passwd|secret/)
  assert.ok(markdown.includes(`- ${longTitle}; completed`))
  assert.ok(markdown.includes('## Evidence\n- Update footer element and verify responsive breakpoints across desktop…: Browser'))
  assert.ok(markdown.includes('## Reviews\n- Update footer element and verify responsive breakpoints across desktop…; attempt 1; approve: Checked &lt;/footer&gt;'))
  record.checks = [{ id: 'check', name: 'Browser', adapter: 'playwright', policy: 'automated-required', scope: 'final', command: 'npm test' }]
  record.tasks = [{ id: 'task', title: longTitle, status: 'completed', fixCycles: 0, updatedAt: record.updatedAt, allowedPaths: ['src/footer.ts', 'src/styles/'] }]
  const finalMd = auditMarkdown(record, [run], [evidence])
  assert.ok(finalMd.includes('## Checks\n- Browser; playwright; automated-required; final gate; command: npm test'))
  assert.ok(finalMd.includes(`- ${longTitle}; completed; owner unassigned; fix cycles 0; scope: src/footer.ts, src/styles/`))
})
