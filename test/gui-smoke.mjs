import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const root = join(import.meta.dirname, '..')
mkdirSync(join(root, '.screenshots'), { recursive: true })
let browser
try { browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--unsafely-treat-insecure-origin-as-secure=http://relay.test'] }) }
catch { browser = await chromium.launch({ headless: true, args: ['--unsafely-treat-insecure-origin-as-secure=http://relay.test'] }) }
const errors = []
let screenshotCount = 0
const manifest = []
const statuses = ['pending', 'running', 'blocked', 'awaiting_approval', 'completed']
const record = { schemaVersion: 2, planRevision: 7, phase: 'draft', id: 'record-1', revision: 7, title: 'Compatibility milestone', location: { directory: '/example/project', projectID: 'example' }, sessionID: 'session-1', createdAt: '2026-11-19T12:00:00Z', updatedAt: '2026-11-19T12:00:00Z', tasks: statuses.map((status, index) => ({ id: `task-${index}`, title: ['Confirm persistent storage', 'Compare terminal and desktop snapshots', 'Verify model selection', 'Review the proposed plan', 'Register the typed RPC contract'][index], status, fixCycles: 0, updatedAt: '2026-11-19T12:00:00Z' })), approvals: [{ kind: 'plan', revision: 6, planRevision: 6, approvedAt: '2026-11-19T12:00:00Z', source: 'permission-assert' }] }
try {
  for (const width of [320, 480, 280]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.route('http://relay.test/**', route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/solid.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(root, 'node_modules/solid-js/dist/solid.js'), 'utf8') })
      if (path === '/web.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(root, 'node_modules/solid-js/web/dist/web.js'), 'utf8') })
      if (path === '/plugin.cjs') return route.fulfill({ body: readFileSync(join(root, 'dist/gui-experimental.cjs'), 'utf8') })
      return route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Relay verification</title><script type="importmap">{"imports":{"solid-js":"/solid.js"}}</script><style>body{margin:0;background:#17191c}#panel{width:100%}</style></head><body><main id="panel"></main></body></html>' })
    })
    await page.goto('http://relay.test/')
    await page.evaluate(async () => {
      const solid = await import('/solid.js'); const web = await import('/web.js')
      const registrations = []; const listeners = new Set()
      const [session, setSession] = solid.createSignal(undefined)
      const [mode, setMode] = solid.createSignal('dark')
      const state = { records: [], runs: [], stale: false, calls: [], snapshotCount: 0, listeners, setSession, setMode, pending: false, release: null, refreshFails: false, mutationPending: false, config: { roles: ['planner', 'builder', 'reviewer'].map(role => ({ role, exists: false, enabled: false, variant: false, tools: false, image: 'not configured', errors: [] })), errors: [], limits: { maxRunningTasks: 1, maxFixCycles: 2 }, enableProbe: false } }
      const api = {
        exportReport: async ({ recordID }) => { if (state.writeFails) throw { type: 'invalid_op', message: 'Could not write report file.' }; if (state.exportFails) throw Error('export failed'); state.exportedRecord = recordID; return { name: 'relay-abcd1234.md', markdown: '# Relay audit\n' } },
        validateConfig: async () => { if (state.configFails) throw Error('offline'); return structuredClone(state.config) },
        probeImage: async () => { const reviewer = state.config.roles[2]; if (!state.config.enableProbe || reviewer.errors.length) throw { type: 'invalid_op' }; reviewer.image = 'verified'; reviewer.probe = { status: 'verified', sessionID: 'mock-child', answer: 'red', tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, at: '2026-11-20T12:00:00Z' }; return structuredClone(state.config) },
        listRecords: async (_, options) => { state.calls.push(['list', options]); if (state.refreshFails) throw Error('offline'); for (const record of state.records) { record.checks ??= []; record.schemaVersion = 3 }; return structuredClone(state.records) },
        getSnapshot: async ({ recordID }) => { state.snapshotCount++; return structuredClone({ checks: [], ...state.records.find(item => item.id === recordID) }) },
        listEvidence: async () => structuredClone(state.evidence ?? []),
        withdrawApproval: async ({ recordID, key }) => { const record = state.records.find(item => item.id === recordID); if (record.pendingApproval?.key !== key) throw { type: 'invalid_op' }; delete record.pendingApproval; record.approvalResult = { revision: record.revision, outcome: 'withdrawn', at: new Date().toISOString() }; return structuredClone(record) },
        recordManual: async input => { state.manualInput = input; const record = state.records.find(item => item.id === input.id); state.evidence = state.evidence.map(item => item.checkID === input.checkID && item.taskID === input.taskID ? { ...item, result: 'manually verified', source: 'permission-assert', note: input.note } : item); record.revision++; return structuredClone(record) },
        listRuns: async ({ recordID }) => { if (state.runsFail) throw Error('runs unavailable'); return structuredClone(state.runs.filter(run => run.recordID === recordID)) },
        createRecord: async (input, options) => { state.calls.push(['create', options]); const now = new Date().toISOString(); const record = { schemaVersion: 3, checks: [], planRevision: 1, phase: 'draft', id: 'new', revision: 1, title: input.title, sessionID: input.sessionID, location: { directory: '/example/project', projectID: 'example' }, createdAt: now, updatedAt: now, tasks: [], approvals: [] }; state.records = [record]; return structuredClone(record) },
        signOff: async (input, options) => { state.calls.push(['signOff', options]); if (state.verificationIncomplete) throw { type: 'verification_incomplete' }; const record = state.records.find(item => item.id === input.recordID); if (record.phase !== 'running' || !record.tasks.length || !record.tasks.every(task => task.status === 'completed')) throw { type: 'invalid_op' }; if (record.revision !== input.expectedRevision) throw { type: 'stale_revision' }; if (state.signoffPending) await new Promise((resolve, reject) => { state.signoffRelease = resolve; state.signoffReject = reject }); if (record.revision !== input.expectedRevision) throw { type: 'stale_revision' }; record.phase = 'completed'; record.revision++; return structuredClone(record) },
        mutate: async (input, options) => {
          state.calls.push(['mutate', options]); if (state.mutationPending) await new Promise(resolve => { state.releaseMutation = resolve }); if (state.stale) { state.stale = false; const record = state.records.find(item => item.id === input.recordID); record.revision++; record.planRevision++; record.phase = 'draft'; record.tasks.push({ id: `external-${record.revision}`, title: 'Change from another client', status: 'pending', fixCycles: 0, updatedAt: '2026-11-19T12:00:00Z' }); throw { type: 'stale_revision', message: 'stale_revision', data: { currentRevision: record.revision } } }
          const record = state.records.find(item => item.id === input.recordID)
          if (input.op.type === 'addCheck') { record.checks ??= []; record.checks.push(input.op.check); record.revision++; record.planRevision++; return structuredClone(record) }
          if (input.op.type === 'removeCheck') { record.checks = record.checks.filter(check => check.id !== input.op.checkID); record.revision++; record.planRevision++; return structuredClone(record) }
          if (['completed', 'cancelled'].includes(record.phase)) throw { type: 'invalid_op' }
          if (record.revision !== input.expectedRevision) throw { type: 'stale_revision', data: { currentRevision: record.revision } }
          if (record.phase === 'running' && ['setTaskStatus', 'assignTask'].includes(input.op.type)) throw { type: 'invalid_op' }
          const task = record.tasks.find(task => task.id === input.op.taskID)
          if (input.op.type === 'addTask' && !['draft', 'approved', 'interrupted'].includes(record.phase)) throw { type: 'invalid_op' }
          if (input.op.type === 'setTaskStatus') {
            if (!task || input.op.status === 'running' && (record.phase !== 'running' || !task.owner || task.status === 'running')) throw { type: 'invalid_op' }
            if (input.op.status === 'running' && record.tasks.filter(task => task.status === 'running').length >= 1) throw { type: 'limit_exceeded' }
            if (task.status === 'running' && input.op.status === 'pending') { if (task.fixCycles >= 2) throw { type: 'limit_exceeded' }; task.fixCycles++ }
          }
          if (input.op.type === 'assignTask' && (!task || task.status === 'running')) throw { type: 'invalid_op' }
          const transitions = { start: ['draft', 'approved'], interrupt: ['running'], resume: ['interrupted'], complete: ['running'], cancel: ['draft', 'approved', 'running', 'interrupted'] }
          if (input.op.type in transitions) {
            if (!transitions[input.op.type].includes(record.phase)) throw { type: 'invalid_op' }
            if (['start', 'resume'].includes(input.op.type) && record.approvals.at(-1)?.planRevision !== record.planRevision) throw { type: 'approval_required' }
            if (input.op.type === 'complete' && (!record.tasks.length || !record.tasks.every(task => task.status === 'completed'))) throw { type: 'invalid_op' }
            if (input.op.type === 'interrupt' && (!input.op.reason.trim() || Array.from(input.op.reason.trim()).length > 500)) throw { type: 'invalid_op' }
          }
          if (input.op.type === 'addTask') { record.tasks.push({ id: `added-${record.tasks.length}`, title: input.op.title, ...(input.op.allowedPaths?.length ? { allowedPaths: input.op.allowedPaths } : {}), status: 'pending', fixCycles: 0, updatedAt: '2026-11-19T12:00:00Z' }); record.planRevision++; record.phase = 'draft' }
          else if (input.op.type === 'setTaskStatus') record.tasks.find(task => task.id === input.op.taskID).status = input.op.status
          else if (input.op.type === 'assignTask') record.tasks.find(task => task.id === input.op.taskID).owner = input.op.owner
          else { record.phase = input.op.type === 'start' || input.op.type === 'resume' ? 'running' : input.op.type === 'interrupt' ? 'interrupted' : input.op.type === 'complete' ? 'completed' : 'cancelled'; if (input.op.type === 'interrupt') record.interruptReason = input.op.reason; else delete record.interruptReason }
          record.revision++; return structuredClone(record)
        },
        requestApproval: async (input, options) => { state.calls.push(['approve', options]); if (state.invalidCheck) throw { type: 'invalid_op', message: 'Check "Legacy browser" contains unsupported characters or settings; remove and re-add it.' }; const record = state.records.find(record => record.id === input.recordID); if (record.phase !== 'draft') throw { type: 'invalid_op' }; const planRevision = record.planRevision; if (state.pending) await new Promise((resolve, reject) => { state.release = resolve; state.rejectRelease = reject }); if (record.phase !== 'draft' || record.planRevision !== planRevision) throw { type: 'stale_revision' }; record.approvals.push({ kind: 'plan', revision: input.expectedRevision, planRevision, approvedAt: '2026-11-19T12:00:00Z', source: 'permission-assert' }); record.phase = 'approved'; record.revision++; return structuredClone(record) },
        events: { on: (_, handler) => { listeners.add(handler); return () => listeners.delete(handler) } },
      }
      const server = { id: 'test', connected: true, client: { rpc: () => api } }
      const active = { id: 'session-1', key: 'test\nsession-1', server, location: { directory: '/example/project' } }
      setSession(active)
      const ctx = { id: 'opencode-relay-orchestration', system: { save: async file => { state.savedFile = file; return state.saveCancelled ? false : true }, copy: async text => { state.copied = text } }, appearance: { mode }, sessions: { current: session }, layout: { open() {} }, add: (kind, value) => { registrations.push({ kind, value }); if (kind === 'Style') { const style = document.createElement('style'); style.textContent = value; document.head.append(style) } } }
      const exports = {}; const code = await (await fetch('/plugin.cjs')).text()
      const host = { Plugin: { define: value => value }, Panel: 'Panel', Command: 'Command', Style: 'Style' }
      new Function('exports', 'require', code)(exports, name => { if (name === 'solid-js') return solid; if (name === 'solid-js/web') return web; if (name === '@opencode/plugin/rpc') return { Rpc: { define: value => value } }; if (name === '@opencode/plugin/gui') return host; throw Error(`Unexpected GUI dependency: ${name}`) })
      solid.createRoot(() => { exports.default.setup(ctx); web.render(() => registrations.find(item => item.kind === 'Panel').value.render(), document.querySelector('#panel')) })
      Object.assign(window, { smoke: state, active })
    })
    async function capture(state) {
      assert.equal(await page.locator('#panel').evaluate(element => element.scrollWidth > element.clientWidth), false, `${state} panel overflow at ${width}`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (state.startsWith('m4-') && !process.env.RELAY_PRESERVE_CAPTURES) await page.locator('.relay-verification').screenshot({ path: join(root, `.screenshots/${state}-${width}.png`) })
      // Existing captures are preserved; their assertions still run.
      screenshotCount++
      manifest.push({ file: `gui-panel-${state}-${width}.png`, state, width })
    }
    await page.getByText('No relay record', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Validate config', exact: true }).click()
    await page.getByText(/planner: not configured/).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Run image probe' }).count(), 0)
    await capture('roles-not-configured')
    for (const state of ['declared', 'verified', 'failed', 'error', 'invalid']) {
      await page.evaluate(state => { window.smoke.config.enableProbe = true; window.smoke.config.roles = ['planner', 'builder', 'reviewer'].map(role => ({ role, model: { providerID: 'test', id: `${role}-model`, variant: 'high' }, exists: true, enabled: state !== 'invalid', variant: state !== 'invalid', tools: state !== 'invalid', image: role === 'reviewer' ? state === 'invalid' ? 'unavailable' : state : 'not required', errors: state === 'invalid' ? ['Model is disabled', 'Variant not found', 'Tools are required'] : [], ...(role === 'reviewer' && ['verified', 'failed', 'error'].includes(state) ? { probe: { status: state, sessionID: 'mock-child', answer: state === 'error' ? 'The host could not complete the image probe. No vision verdict was recorded.' : state === 'verified' ? 'red' : 'blue', tokens: { input: state === 'error' ? 0 : 4, output: state === 'error' ? 0 : 1, reasoning: 0, cache: { read: 0, write: 0 } }, at: '2026-11-20T12:00:00Z' } } : {}) })) }, state)
      await page.getByRole('button', { name: 'Validate config', exact: true }).click()
      await page.getByText(/Model: reviewer-model/).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Run image probe' }).count(), state === 'invalid' ? 0 : 1)
      if (['verified', 'failed', 'error'].includes(state)) await page.getByText(/Probe tokens: input/).waitFor()
      if (state === 'error') await page.getByText(/Probe error \(not cached\): The host could not complete/).waitFor()
      assert.ok(await page.evaluate(() => window.smoke.config.roles.every(role => !role.errors.length || !['verified', 'failed', 'error'].includes(role.image))))
      await capture(`roles-${state}`)
    }
    await page.evaluate(() => { for (const role of window.smoke.config.roles) { role.errors = []; role.enabled = true; role.variant = true; role.tools = true; role.image = role.role === 'reviewer' ? 'declared' : 'not required'; delete role.probe } })
    await page.getByRole('button', { name: 'Validate config', exact: true }).click()
    await page.getByRole('button', { name: 'Run image probe' }).click()
    await page.getByText(/image: verified/).waitFor()
    await page.evaluate(() => { window.smoke.config.enableProbe = false })
    await page.getByRole('button', { name: 'Validate config', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Run image probe' }).count(), 0)
    await capture('roles-probe-hidden')
    if (width !== 280) await capture('empty')
    await page.getByText('New record', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Record title' }).fill('Explicitly created plan')
    await page.getByRole('button', { name: 'Create record' }).click()
    await page.getByRole('heading', { name: 'Explicitly created plan' }).waitFor()
    if (width === 320) {
      const audit = page.locator('details.relay-audit')
      assert.equal(await audit.getAttribute('open'), null)
      await page.setViewportSize({ width: 1280, height: 1000 })
      await page.screenshot({ path: join(root, '.screenshots/m6-audit-collapsed-1280.png'), fullPage: true })
      await audit.locator('summary').click()
      await audit.getByText(/Explicitly created plan: draft; 0 runs/).waitFor()
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: join(root, `.screenshots/m6-audit-expanded-${captureWidth}.png`), fullPage: true })
      }
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        await audit.getByRole('button', { name: 'Export Markdown', exact: true }).click()
        await audit.getByText('Report saved', { exact: true }).waitFor()
        assert.deepEqual(await page.evaluate(() => window.smoke.savedFile), { name: 'relay-abcd1234.md', content: '# Relay audit\n' })
        await page.screenshot({ path: join(root, `.screenshots/m6-export-done-${captureWidth}.png`), fullPage: true })
        await audit.getByRole('button', { name: 'Copy', exact: true }).click()
        await audit.getByText('Copied', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => window.smoke.copied), '# Relay audit\n')
      }
      await page.evaluate(() => { window.smoke.saveCancelled = true })
      await audit.getByRole('button', { name: 'Export Markdown', exact: true }).click()
      await audit.getByText('Save cancelled', { exact: true }).waitFor()
      await page.evaluate(() => { window.smoke.saveCancelled = false; window.smoke.exportFails = true })
      await audit.getByRole('button', { name: 'Export Markdown', exact: true }).click()
      await audit.getByRole('alert').filter({ hasText: 'Could not export report.' }).waitFor()
      await page.evaluate(() => { window.smoke.exportFails = false; window.smoke.writeFails = true })
      await audit.getByRole('button', { name: 'Export Markdown', exact: true }).click()
      await audit.getByRole('alert').filter({ hasText: 'Could not write report file.' }).waitFor()
      await page.evaluate(() => { window.smoke.writeFails = false })
      await page.evaluate(() => { window.smoke.exportFails = false })
      await audit.getByRole('button', { name: 'Copy', exact: true }).click()
      await audit.getByText('Copied', { exact: true }).waitFor()
      await audit.locator('summary').click()
      await page.evaluate(() => {
        const record = window.smoke.records[0]
        record.phase = 'completed'
        window.smoke.runs = [{ id: 'audit-review', recordID: record.id, taskID: 'audit-task', stage: 'review', role: 'reviewer', model: { providerID: 'test', id: 'review' }, sessionID: 'child', attempt: 1, status: 'reported', startedAt: record.createdAt, tokens: { input: 1200, output: 80, reasoning: 10, cache: { read: 600, write: 0 } }, report: { verdict: 'approve', summary: 'Reviewed', findings: [], inspected: [] } }]
      })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await audit.locator('summary').click()
      await audit.getByText(/completed; 1 run; Tokens: input 1200, output 80.*review approve/).waitFor()
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: join(root, `.screenshots/m6-audit-populated-${captureWidth}.png`), fullPage: true })
      }
      await audit.locator('summary').click()
      await page.evaluate(() => { window.smoke.runs = [] })
      await page.evaluate(() => { window.smoke.records[0].phase = 'cancelled'; window.smoke.records[0].cancelReason = 'Already implemented. Existing behavior satisfies this request.' })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('Cancelled: Already implemented. Existing behavior satisfies this request.', { exact: true }).waitFor()
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: join(root, `.screenshots/m6-cancel-reason-${captureWidth}.png`), fullPage: true })
      }
      await page.evaluate(() => {
        const record = window.smoke.records[0]
        record.tasks = [{ id: 'selfcheck-task', title: 'Verify the status list', status: 'completed', fixCycles: 0, updatedAt: record.updatedAt }]
        window.smoke.runs = [{ id: 'selfcheck-build', recordID: record.id, taskID: 'selfcheck-task', stage: 'build', role: 'builder', model: { providerID: 'test', id: 'builder' }, sessionID: 'child', attempt: 1, status: 'reported', startedAt: record.createdAt, report: { outcome: 'done', summary: 'Fixed the assertion and reran checks.', checks: [{ command: 'npm test', result: 'failed' }, { command: 'npm test', result: 'passed' }, { command: 'npm run lint', result: 'passed' }] } }]
      })
      await page.setViewportSize({ width: 1280, height: 1000 })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('Builder self-checks: 2 passed, 1 failed (self-reported, unverified)', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: join(root, '.screenshots/m6-selfcheck-failed-1280.png'), fullPage: true })
      await page.evaluate(() => { const record = window.smoke.records[0]; record.phase = 'draft'; delete record.cancelReason; record.tasks = []; window.smoke.runs = [] })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.evaluate(() => { window.smoke.config.summary = 'Relay config: saved 2026-11-23T22:00:00Z; fixes 2; widths 1280, 390; auto-start off; parallel 1; explorer on' })
      await page.getByRole('button', { name: 'Validate config', exact: true }).click()
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        await page.getByText('Relay config: saved', { exact: false }).waitFor()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: join(root, `.screenshots/m6-config-summary-${captureWidth}.png`), fullPage: true })
      }
      await page.evaluate(() => { delete window.smoke.config.summary })
      await page.getByRole('button', { name: 'Validate config', exact: true }).click()
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        await page.evaluate(({ completed }) => {
          const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } }
          window.smoke.records[0].plannerSession = { model: { providerID: 'test', id: 'planner' }, tokensAtStart: tokens, ...(completed ? { tokensAtEnd: { input: 110, output: 22, reasoning: 6, cache: { read: 43, write: 0 } } } : {}) }
          window.smoke.records[0].phase = completed ? 'cancelled' : 'draft'
        }, { completed: captureWidth === 390 })
        await page.getByRole('button', { name: 'Refresh', exact: true }).click()
        await page.getByText(captureWidth === 1280 ? 'Planner session tokens: tracking' : 'Planner session tokens: input +100, output +20, reasoning +5, cache read +40', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        if (!process.env.RELAY_PRESERVE_CAPTURES) await page.screenshot({ path: join(root, `.screenshots/m6-planner-tokens-${captureWidth}.png`), fullPage: true })
      }
      await page.evaluate(() => { delete window.smoke.records[0].plannerSession.tokensAtEnd })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('Planner session tokens: unavailable', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: join(root, '.screenshots/m6-planner-tokens-unavailable-390.png'), fullPage: true })
      await page.evaluate(() => { delete window.smoke.records[0].plannerSession; window.smoke.records[0].phase = 'draft' })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      assert.equal(await page.getByText('Planner session tokens:', { exact: false }).count(), 0)
      await page.setViewportSize({ width: 1280, height: 1000 })
      await page.evaluate(() => { window.smoke.invalidCheck = true })
      await page.getByRole('button', { name: 'Request plan approval' }).click()
      await page.getByRole('alert').filter({ hasText: 'Check "Legacy browser" contains unsupported characters or settings; remove and re-add it.' }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (!process.env.RELAY_PRESERVE_CAPTURES) await page.screenshot({ path: join(root, '.screenshots/m5-check-invalid-1280.png'), fullPage: true })
      await page.evaluate(() => { window.smoke.invalidCheck = false })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.evaluate(() => { window.smoke.records[0].phase = 'interrupted'; window.smoke.records[0].interruptReason = 'escalated: screenshot inspection incomplete' })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('Screenshot inspection incomplete. The reviewer must inspect and list every attached screenshot by its exact name. Resolve the blocked task, then resume.', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (!process.env.RELAY_PRESERVE_CAPTURES) await page.screenshot({ path: join(root, '.screenshots/m5-review-incomplete-1280.png'), fullPage: true })
      await page.evaluate(() => { window.smoke.records[0].phase = 'draft'; delete window.smoke.records[0].interruptReason })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.setViewportSize({ width, height: 1000 })
    }
    if (width === 320 && !process.env.RELAY_PRESERVE_CAPTURES) {
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        await page.evaluate(() => { const record = window.smoke.records[0]; record.pendingApproval = { key: `${record.id}@${record.revision}`, revision: record.revision }; delete record.approvalResult })
        await page.getByRole('button', { name: 'Refresh', exact: true }).click()
        await page.getByRole('button', { name: 'Withdraw approval request', exact: true }).waitFor()
        assert.equal(await page.getByRole('button', { name: 'Request plan approval' }).isDisabled(), true)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: join(root, `.screenshots/m5-withdraw-pending-${captureWidth}.png`), fullPage: true })
        await page.getByRole('button', { name: 'Withdraw approval request', exact: true }).click()
        await page.getByText('Approval request withdrawn', { exact: true }).waitFor()
        assert.equal(await page.getByRole('button', { name: 'Withdraw approval request', exact: true }).count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Request plan approval' }).isEnabled(), true)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: join(root, `.screenshots/m5-withdraw-done-${captureWidth}.png`), fullPage: true })
      }
      await page.evaluate(() => { delete window.smoke.records[0].approvalResult })
      await page.setViewportSize({ width, height: 1000 })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    }
    assert.equal(await page.locator('details').filter({ has: page.locator('summary', { hasText: 'New record' }) }).getAttribute('open'), null)
    assert.equal(await page.getByRole('textbox', { name: 'Task title' }).inputValue(), '')
    await page.getByRole('textbox', { name: 'Task title' }).fill('Interactive task')
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    await page.getByText('Interactive task', { exact: true }).waitFor()
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('completed')
    await page.getByRole('button', { name: 'Request plan approval' }).click()
    await page.getByText(/Plan approved for revision 3/).waitFor()
    await page.getByText('New record', { exact: true }).click()
    if (width !== 280) await capture('interactive')
    await page.evaluate(record => { window.smoke.records = [record]; for (const listener of window.smoke.listeners) listener({ location: { directory: '/example/project' }, data: { recordID: record.id, revision: record.revision } }) }, record)
    await page.getByRole('heading', { name: 'Compatibility milestone' }).waitFor()
    await page.getByText('New record', { exact: true }).click()
    await capture('phase-draft')
    await page.getByRole('combobox', { name: 'Owner role', exact: true }).first().selectOption('builder')
    await page.waitForFunction(() => !document.querySelector('button[disabled]'))
    assert.equal(await page.getByRole('combobox', { name: 'Owner role', exact: true }).first().inputValue(), 'builder')
    await capture('owner-assignment')
    await page.getByRole('button', { name: 'Request plan approval', exact: true }).click()
    await page.getByText('Phase: approved', { exact: true }).waitFor()
    await page.getByText('Plan approved. Choose Start in the panel or TUI to begin work.', { exact: true }).waitFor()
    if (width === 320) {
      for (const captureWidth of [1280, 390]) {
        await page.setViewportSize({ width: captureWidth, height: 1000 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: join(root, `.screenshots/m6-config-manual-start-${captureWidth}.png`), fullPage: true })
      }
      await page.setViewportSize({ width, height: 1000 })
    }
    await capture('phase-approved')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.getByText('Phase: running', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Add task', exact: true }).count(), 0)
    await capture('phase-running')
    await page.getByRole('textbox', { name: 'Interrupt reason', exact: true }).fill('Waiting for explicit human review')
    await page.getByRole('button', { name: 'Interrupt', exact: true }).click()
    await page.getByText('Phase: interrupted', { exact: true }).waitFor()
    await page.getByText('Interrupted: Waiting for explicit human review', { exact: true }).waitFor()
    await capture('phase-interrupted')
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.getByText('Phase: running', { exact: true }).waitFor()
    await page.evaluate(() => { const r = window.smoke.records[0]; r.tasks.forEach(task => { task.status = 'completed' }); r.revision++; for (const listener of window.smoke.listeners) listener({ location: { directory: '/example/project' } }) })
    await page.getByRole('button', { name: 'Sign off', exact: true }).click()
    await page.getByText('Phase: completed', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Add task', exact: true }).count(), 0)
    await capture('phase-completed')
    await page.evaluate(record => { window.smoke.records = [structuredClone(record)] }, record)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Phase: draft', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByText('Phase: cancelled', { exact: true }).waitFor()
    await capture('phase-cancelled')
    for (const phase of ['running', 'completed', 'cancelled']) {
      await page.evaluate(({ record, phase }) => { const r = structuredClone(record); r.phase = phase; r.tasks = [{ ...r.tasks[0], status: phase === 'running' ? 'running' : 'completed', owner: { role: 'builder', sessionID: 'worker-verification' }, fixCycles: 1 }]; r.approvals = [{ kind: 'plan', revision: 6, planRevision: r.planRevision, approvedAt: r.updatedAt, source: 'permission-assert' }]; window.smoke.records = [r] }, { record, phase })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText(`Phase: ${phase}`, { exact: true }).waitFor()
      assert.equal(await page.getByRole('combobox', { name: 'Owner role', exact: true }).inputValue(), 'builder')
      assert.equal(await page.getByRole('combobox', { name: 'Owner role', exact: true }).isDisabled(), true)
      await page.getByText('Owner session: worker-verification', { exact: true }).waitFor()
      await page.getByText('Fix cycles: 1', { exact: true }).waitFor()
      if (phase === 'running') {
        await page.getByText('Owner is locked while the task is running', { exact: true }).waitFor()
        assert.equal(await page.getByRole('button', { name: 'Sign off', exact: true }).count(), 0)
        await page.getByRole('textbox', { name: 'Interrupt reason' }).fill('   ')
        assert.equal(await page.getByRole('button', { name: 'Interrupt', exact: true }).isDisabled(), true)
        assert.equal(await page.getByRole('textbox', { name: 'Interrupt reason' }).getAttribute('maxlength'), '500')
      } else {
        assert.equal(await page.getByRole('combobox', { name: 'Status', exact: true }).isDisabled(), true)
        assert.equal(await page.getByRole('button', { name: 'Request plan approval' }).count(), 0)
      }
      await capture(`v2-${phase}`)
    }
    await page.evaluate(record => { window.smoke.records = [structuredClone(record)] }, record)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Phase: draft', { exact: true }).waitFor()
    if (width === 280) await capture('narrow')
    for (const theme of [
      { name: 'dark', mode: 'dark', bg: '#17191c' },
      { name: 'light', mode: 'light', bg: '#ffffff' },
      { name: 'nord', mode: 'dark', bg: '#191e29', base: '#e5e9f0', strong: '#fcfdfe' },
      { name: 'dracula', mode: 'dark', bg: '#0f1019', base: '#f8f8f2', strong: '#fefefe' },
    ]) {
      await page.evaluate(theme => { window.smoke.setMode(theme.mode); document.body.style.background = theme.bg; for (const [key, value] of [['--background-base', theme.strong ? theme.bg : null], ['--text-base', theme.base], ['--text-strong', theme.strong]]) { if (value) document.documentElement.style.setProperty(key, value); else document.documentElement.style.removeProperty(key) } }, theme)
      assert.equal(await page.locator('.relay-panel').evaluate(e => getComputedStyle(e).colorScheme), theme.mode)
      await capture(theme.name)
      await page.evaluate(() => { window.smoke.mutationPending = true })
      await page.getByRole('combobox', { name: 'Status', exact: true }).first().selectOption('pending')
      await page.waitForFunction(() => typeof window.smoke.releaseMutation === 'function')
      assert.equal(await page.locator('.relay-panel').getAttribute('aria-busy'), 'true')
      for (const control of [page.getByRole('button', { name: 'Add task', exact: true }), page.getByRole('combobox', { name: 'Status', exact: true }).first()]) assert.equal(await control.evaluate(e => getComputedStyle(e).cursor), 'wait')
      await capture(`disabled-${theme.name}`)
      await page.evaluate(() => { window.smoke.mutationPending = false; window.smoke.releaseMutation(); window.smoke.releaseMutation = null })
      await page.waitForFunction(() => !document.querySelector('button[disabled]'))
    }
    await page.evaluate(() => { for (const key of ['--background-base', '--text-base', '--text-strong']) document.documentElement.style.removeProperty(key); window.smoke.setMode('dark'); document.body.style.background = '#17191c' })
    await page.evaluate(() => { window.smoke.mutationPending = true })
    await page.getByRole('textbox', { name: 'Task title' }).fill('Delayed normal action')
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    await page.waitForFunction(() => typeof window.smoke.releaseMutation === 'function')
    assert.equal(await page.getByRole('combobox', { name: 'Status', exact: true }).first().isDisabled(), true)
    await capture('disabled')
    await page.evaluate(() => { window.smoke.mutationPending = false; window.smoke.releaseMutation() })
    await page.getByText('Delayed normal action', { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('button[disabled]'))
    await capture('tasks')
    await page.evaluate(() => { const r = structuredClone(window.smoke.records[0]); r.id = 'record-2'; r.title = 'Second review plan'; window.smoke.records.push(r) })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('combobox', { name: 'Record', exact: true }).waitFor()
    await capture('picker')
    await page.getByRole('combobox', { name: 'Record', exact: true }).selectOption('record-2')
    await page.getByRole('heading', { name: 'Second review plan' }).waitFor()
    await page.getByRole('combobox', { name: 'Record', exact: true }).selectOption('record-1')
    await page.getByRole('heading', { name: 'Compatibility milestone' }).waitFor()
    await page.evaluate(() => { window.smoke.pending = true })
    await page.getByRole('button', { name: 'Request plan approval' }).click()
    await page.evaluate(() => { window.smoke.records[0].pendingApproval = { key: 'record-1@7', revision: 7 }; for (const listener of window.smoke.listeners) listener({ location: { directory: '/example/project' }, data: { recordID: 'record-1', revision: 7 } }) })
    await page.getByRole('status').filter({ hasText: 'Waiting for approval' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Add task', exact: true }).isDisabled(), false)
    assert.equal(await page.getByRole('textbox', { name: 'Task title' }).isEnabled(), true)
    assert.equal(await page.getByRole('combobox', { name: 'Status', exact: true }).first().isEnabled(), true)
    await page.getByRole('textbox', { name: 'Task title' }).fill('Added during approval')
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    await page.getByText('Added during approval', { exact: true }).waitFor()
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(e => e.textContent === 'Add task').disabled)
    assert.equal(await page.getByRole('button', { name: 'Request plan approval' }).isDisabled(), true)
    assert.equal(await page.locator('.relay-panel').getAttribute('aria-busy'), 'false')
    assert.equal(await page.getByRole('button', { name: 'Request plan approval' }).evaluate(e => getComputedStyle(e).cursor), 'not-allowed')
    await capture('pending')
    await page.evaluate(() => { window.smoke.records[0].pendingApproval = { key: 'record-1@7', revision: 7 }; window.smoke.setSession({ ...window.active, server: { ...window.active.server, connected: false } }) })
    await page.getByRole('alert').waitFor()
    await page.evaluate(() => { window.smoke.setSession({ ...window.active }) })
    await page.getByRole('status').filter({ hasText: 'Waiting for approval' }).waitFor()
    await capture('pending-after-reconnect')
    await page.evaluate(() => { delete window.smoke.records[0].pendingApproval })
    await page.evaluate(() => { window.smoke.pending = false; window.smoke.release() })
    await page.getByRole('button', { name: 'Request plan approval' }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(element => element.textContent.includes('Waiting for approval')))
    // Foreign locations must not trigger a fetch. Revision gaps always fetch a full snapshot.
    const before = await page.evaluate(() => window.smoke.snapshotCount)
    await page.evaluate(() => { for (const listener of window.smoke.listeners) listener({ location: { directory: '/elsewhere' }, data: { recordID: 'foreign', revision: 100 } }) })
    assert.equal(await page.evaluate(() => window.smoke.snapshotCount), before)
    await page.evaluate(() => { window.smoke.records[0].revision = 20; for (const listener of window.smoke.listeners) listener({ location: { directory: '/example/project' }, data: { recordID: 'record-1', revision: 20 } }) })
    await page.getByText('Revision 20', { exact: true }).waitFor()
    await page.evaluate(() => { window.smoke.stale = true })
    await page.getByRole('textbox', { name: 'Task title' }).fill('Conflicting update')
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'This record changed' }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Task title' }).inputValue(), 'Conflicting update')
    await capture('stale')
    await page.getByText('Revision 21', { exact: true }).waitFor()
    await page.evaluate(() => { for (const listener of window.smoke.listeners) listener({ location: { directory: '/example/project' }, data: { recordID: 'record-1', revision: 21 } }) })
    await page.getByRole('alert').filter({ hasText: 'This record changed' }).waitFor()
    await page.evaluate(() => { window.smoke.stale = true; window.smoke.refreshFails = true })
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Could not refresh. Use Refresh to retry.' }).waitFor()
    assert.match(await page.getByRole('alert').innerText(), /This record changed/)
    await capture('action-error-reconnect')
    await page.evaluate(() => { window.smoke.refreshFails = false })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'))
    for (const outcome of ['approved', 'stale']) {
      await page.evaluate(outcome => { const r = window.smoke.records[0]; r.phase = outcome === 'approved' ? 'approved' : 'draft'; r.approvalResult = { revision: r.revision - (outcome === 'approved' ? 1 : 0), outcome, at: '2026-11-19T12:00:00Z' }; if (outcome === 'approved') r.approvals.push({ kind: 'plan', revision: r.revision - 1, planRevision: r.planRevision, approvedAt: r.updatedAt, source: 'permission-assert' }); window.smoke.stale = true }, outcome)
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('status').filter({ hasText: outcome === 'approved' ? /^Plan approved for revision/ : /^Plan changed; approval not recorded$/ }).waitFor()
      await page.getByRole('button', { name: 'Add task', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'This record changed' }).waitFor()
      assert.equal(await page.getByRole('status').filter({ hasText: /^(Plan approved for revision|Plan changed; approval not recorded)/ }).count(), 0)
      await capture(`stale-mutation-${outcome}`)
    }
    for (const outcome of ['stale', 'rejected']) {
      await page.evaluate(() => { window.smoke.pending = true })
      await page.getByRole('button', { name: 'Request plan approval' }).click()
      await page.waitForFunction(() => typeof window.smoke.rejectRelease === 'function')
      await page.evaluate(outcome => {
        const r = window.smoke.records[0]
        if (outcome === 'stale') r.revision++
        r.approvalResult = { revision: r.revision, outcome, at: '2026-11-19T12:00:00Z' }
        for (const listener of window.smoke.listeners) listener({ location: { directory: '/example/project' }, data: { recordID: r.id, revision: r.revision } })
        window.smoke.pending = false
        window.smoke.rejectRelease({ type: outcome === 'stale' ? 'stale_revision' : 'approval_denied' })
        window.smoke.rejectRelease = null
      }, outcome)
      await page.getByRole('status').filter({ hasText: outcome === 'stale' ? 'Plan changed; approval not recorded' : 'Approval rejected' }).waitFor()
      await page.waitForFunction(() => !document.querySelector('button[disabled]'))
      assert.equal(await page.getByRole('alert').count(), 0)
      assert.equal(await page.getByRole('status').count(), 1)
      await capture(`single-${outcome}`)
    }
    await page.evaluate(() => {
      const r = window.smoke.records[0]
      r.approvals = Array.from({ length: 6 }, (_, index) => ({ kind: 'plan', revision: index + 1, planRevision: index + 1, approvedAt: '2026-11-19T12:00:00Z', source: 'permission-assert' }))
    })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('(3 earlier)', { exact: true }).waitFor()
    assert.equal(await page.locator('li').filter({ hasText: /Plan approved for revision/ }).count(), 3)
    await capture('capped')
    await page.evaluate(() => { window.smoke.setSession({ ...window.active, server: { ...window.active.server, connected: false } }) })
    await page.getByRole('alert').filter({ hasText: 'Select a connected session' }).waitFor()
    await capture('disconnected')
    await page.evaluate(() => { window.smoke.records[0].title = 'Reconnected'; window.smoke.setSession({ ...window.active }) })
    await page.getByRole('heading', { name: 'Reconnected', exact: true }).waitFor()
    await page.evaluate(() => { const r = window.smoke.records[0]; r.title = 'VeryLongUnbrokenRecordTitle'.repeat(9); r.tasks[0].title = 'VeryLongUnbrokenTaskTitle'.repeat(12) })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('heading', { name: /VeryLongUnbrokenRecordTitle/ }).waitFor()
    await capture('long')
    for (const outcome of ['approved', 'rejected', 'stale']) {
      await page.evaluate(outcome => { const r = window.smoke.records[0]; r.phase = outcome === 'approved' ? 'approved' : 'draft'; if (outcome === 'stale') r.revision++; r.approvalResult = { revision: r.revision - (outcome === 'approved' ? 1 : 0), outcome, at: '2026-11-19T12:00:00Z' }; if (outcome === 'approved') r.approvals.push({ kind: 'plan', revision: r.revision - 1, planRevision: r.planRevision, approvedAt: r.updatedAt, source: 'permission-assert' }) }, outcome)
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('status').filter({ hasText: /^(Plan approved for revision|Approval rejected|Plan changed; approval not recorded)/ }).waitFor()
      await capture(`result-${outcome}`)
    }
    await page.evaluate(() => { delete window.smoke.records[0].approvalResult })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('textbox', { name: 'Task title' }).fill('Session A task draft')
    await page.getByText('New record', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Record title' }).fill('Session A record draft')
    await page.evaluate(() => { window.smoke.pending = true })
    await page.getByRole('button', { name: 'Request plan approval' }).click()
    await page.evaluate(() => { const r = window.smoke.records[0]; r.pendingApproval = { key: `${r.id}@${r.revision}`, revision: r.revision }; for (const listener of window.smoke.listeners) listener({ location: { directory: '/example/project' }, data: { recordID: r.id, revision: r.revision } }) })
    await page.getByRole('status').waitFor()
    await page.evaluate(() => { delete window.smoke.records[0].pendingApproval; window.smoke.setSession({ ...window.active, id: 'session-2', key: 'test\nsession-2' }) })
    await page.waitForFunction(() => !document.querySelector('[role="status"]'))
    assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), false)
    assert.equal(await page.getByRole('textbox', { name: 'Task title' }).inputValue(), '')
    assert.equal(await page.getByRole('textbox', { name: 'Record title' }).inputValue(), '')
    await page.evaluate(() => { window.smoke.pending = false; window.smoke.rejectRelease(Error('Old session request failed')) })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.ok(await page.evaluate(() => window.smoke.calls.every(call => call[1].location.directory === '/example/project')))
    // Startup loads retry quietly while the server reloads plugins, then report persistent failures.
    await page.evaluate(() => { window.smoke.refreshFails = true; window.smoke.configFails = true; window.smoke.setSession({ ...window.active }) })
    await page.waitForTimeout(1200)
    assert.equal(await page.getByRole('alert').count(), 0)
    await page.evaluate(() => { window.smoke.refreshFails = false; window.smoke.configFails = false })
    await page.getByRole('heading', { name: /VeryLongUnbrokenRecordTitle/ }).waitFor()
    await page.getByText(/Model: reviewer-model/).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    await capture('startup-retry-recovered')
    const listsBefore = await page.evaluate(() => window.smoke.calls.filter(call => call[0] === 'list').length)
    await page.evaluate(() => { window.smoke.refreshFails = true; window.smoke.configFails = true; window.smoke.setSession({ ...window.active }) })
    await page.getByRole('alert').filter({ hasText: 'Could not refresh. Use Refresh to retry.' }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'Could not validate role configuration' }).waitFor()
    assert.equal(await page.evaluate(() => window.smoke.calls.filter(call => call[0] === 'list').length) - listsBefore, 4)
    await capture('startup-retry-failed')
    await page.evaluate(() => { window.smoke.refreshFails = false; window.smoke.configFails = false })
    await page.getByRole('button', { name: 'Validate config', exact: true }).click()
    for (const state of ['building', 'reviewing', 'findings', 'escalated', 'ready-for-signoff', 'tokens-totals', 'running-controls-locked', 'long-summaries']) {
      await page.evaluate(({ record, state }) => {
        const r = structuredClone(record); r.title = 'Worker progress'; r.revision = 40; r.phase = state === 'escalated' ? 'interrupted' : 'running'; delete r.approvalResult
        r.tasks = [{ ...r.tasks[0], status: state === 'ready-for-signoff' ? 'completed' : state === 'escalated' ? 'blocked' : 'running', fixCycles: state === 'findings' ? 1 : 0, owner: { role: ['reviewing', 'long-summaries', 'ready-for-signoff'].includes(state) ? 'reviewer' : 'builder', sessionID: 'worker-current' } }]
        r.approvals = [{ kind: 'plan', revision: 8, planRevision: r.planRevision, approvedAt: r.updatedAt, source: 'permission-assert' }]
        if (state === 'escalated') { r.interruptReason = 'escalated: fix cycles exhausted'; r.tasks[0].fixCycles = 2; r.tasks[0].owner = { role: 'reviewer', sessionID: 'worker-6' } }
        const run = (id, stage, status, attempt, report) => ({ id, recordID: r.id, taskID: r.tasks[0].id, stage, role: stage === 'build' ? 'builder' : 'reviewer', sessionID: status === 'active' ? 'worker-current' : `worker-${id}`, attempt, status, model: { providerID: 'test', id: stage }, startedAt: `2026-11-21T12:00:0${id}Z`, ...(status !== 'active' ? { endedAt: `2026-11-21T12:00:1${id}Z`, durationMs: 10000, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } } : {}), ...(report ? { report } : {}) })
        const built = { outcome: 'done', summary: 'Built the requested change and ran the checks.', checks: [{ command: 'npm test', result: 'passed' }] }
        const reviewed = { verdict: state === 'ready-for-signoff' ? 'approve' : 'changes', summary: 'Add an explicit assertion for the missing edge case.', findings: state === 'ready-for-signoff' ? [] : [{ severity: 'major', text: 'Missing assertion' }, { severity: 'minor', text: 'Clarify the label' }] }
        window.smoke.runs = state === 'building' || state === 'running-controls-locked' ? [run('1', 'build', 'active', 1)] : [run('1', 'build', 'reported', 1, built), run('2', 'review', ['ready-for-signoff', 'findings', 'escalated', 'tokens-totals'].includes(state) ? 'reported' : 'active', 1, ['ready-for-signoff', 'findings', 'escalated', 'tokens-totals'].includes(state) ? reviewed : undefined)]
        if (['findings', 'tokens-totals'].includes(state)) { window.smoke.runs.push(run('3', 'build', 'active', 2)); r.tasks[0].fixCycles = 1 }
        if (state === 'escalated') window.smoke.runs = [run('1', 'build', 'reported', 1, built), run('2', 'review', 'reported', 1, reviewed), run('3', 'build', 'reported', 2, built), run('4', 'review', 'reported', 2, reviewed), run('5', 'build', 'reported', 3, built), run('6', 'review', 'reported', 3, reviewed)]
        if (state === 'long-summaries') window.smoke.runs[0].report.summary = 'A very long reviewer-facing build report with verified-by-worker details that remain self-reported. '.repeat(40)
        window.smoke.records = [r]; window.smoke.signoffPending = false
      }, { record, state })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('heading', { name: 'Worker progress', exact: true }).waitFor()
      if (state === 'escalated') { await page.getByText(/Needs your attention: fix cycles exhausted/).waitFor(); assert.equal(await page.getByRole('combobox', { name: 'Status', exact: true }).isEnabled(), true) }
      else { assert.equal(await page.getByRole('combobox', { name: 'Status', exact: true }).isDisabled(), true); assert.equal(await page.getByRole('combobox', { name: 'Owner role', exact: true }).isDisabled(), true) }
      if (state === 'findings') await page.getByText('2 findings (1 major)', { exact: true }).waitFor()
      if (state === 'tokens-totals') await page.getByText('Tokens: input 20, output 10, reasoning 4, cache read 6, cache write 8', { exact: true }).waitFor()
      if (state === 'long-summaries') assert.ok(await page.locator('.relay-report').evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1))
      await capture(`m3-${state}`)
      if (state === 'ready-for-signoff') {
        await page.evaluate(() => { window.smoke.signoffPending = true })
        await page.getByRole('button', { name: 'Sign off', exact: true }).click()
        await page.getByText('Waiting for sign-off of revision 40', { exact: true }).waitFor()
        assert.equal(await page.getByRole('button', { name: 'Sign off', exact: true }).isDisabled(), true)
        assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), true)
        await capture('m3-signoff-pending')
        await page.evaluate(() => { window.smoke.signoffPending = false; window.smoke.signoffReject({ type: 'approval_denied' }) })
        await page.getByRole('alert').filter({ hasText: 'Sign-off was denied. The record is still running.' }).waitFor()
        await capture('m3-signoff-denied')
      }
    }
    if (width !== 320) for (const state of ['empty', 'draft', 'passed', 'failed', 'unverified', 'manual', 'not-applicable', 'stale', 'manual-form', 'verification-incomplete', ...(width === 280 ? ['long-title'] : [])]) {
      await page.evaluate(({ state, record }) => {
        const check = { id: 'browser', name: 'Browser smoke', adapter: 'playwright', command: 'npx playwright test', policy: ['manual', 'manual-form'].includes(state) ? 'manual-allowed' : state === 'not-applicable' ? 'not-applicable' : 'automated-required', ...(state === 'not-applicable' ? { reason: 'No browser surface' } : {}) }
        const task = { id: 'task', title: state === 'long-title' ? 'Update heading and preserve every other part of this deliberately long task title.' : 'Update heading.', status: state === 'manual-form' ? 'running' : 'completed', owner: { role: 'reviewer' }, fixCycles: 0, updatedAt: record.updatedAt }
        window.smoke.records = [{ ...record, schemaVersion: 3, phase: ['empty', 'draft'].includes(state) ? 'draft' : state === 'manual-form' ? 'interrupted' : 'running', interruptReason: state === 'manual-form' ? 'manual verification required: Browser smoke' : undefined, tasks: [task], checks: state === 'empty' ? [] : [check] }]
        window.smoke.runs = [{ id: state === 'stale' ? 'new-build' : 'build', recordID: record.id, taskID: task.id, stage: 'build', status: 'reported', attempt: 1, startedAt: record.createdAt }]
        window.smoke.evidence = ['empty', 'draft', 'not-applicable'].includes(state) ? [] : [{ id: 'evidence', recordID: record.id, taskID: task.id, checkID: check.id, buildRunID: 'build', result: state === 'failed' ? 'failed' : state === 'manual' ? 'manually verified' : ['unverified', 'manual-form'].includes(state) ? 'unverified' : 'passed', source: state === 'manual' ? 'permission-assert' : 'adapter', reason: 'Playwright package unavailable', note: 'Opened the page and exercised the interaction', screenshots: ['passed', 'stale'].includes(state) ? [{ path: 'page.png', sha256: 'abc', bytes: 10 }] : [], startedAt: 1, endedAt: 2, durationMs: 1 }]
        window.smoke.verificationIncomplete = state === 'verification-incomplete'
      }, { state, record })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.locator('.relay-verification').waitFor()
      if (state === 'draft') {
        await page.getByLabel('Check name', { exact: true }).fill('Unit tests')
        await page.getByLabel('Check command', { exact: true }).fill('npm test')
        await page.getByRole('button', { name: 'Add check', exact: true }).click()
        await page.getByRole('button', { name: 'Remove Unit tests', exact: true }).waitFor()
        await page.getByRole('button', { name: 'Remove Unit tests', exact: true }).click()
        assert.equal(await page.getByRole('button', { name: 'Remove Unit tests', exact: true }).count(), 0)
      }
      if (state === 'manual') assert.equal(await page.locator('.relay-evidence-manual').count(), 1)
      if (state === 'manual-form') await page.getByLabel('Manual verification note').fill('Verified by the fixture user')
      if (state === 'verification-incomplete') {
        await page.getByRole('button', { name: 'Sign off', exact: true }).click()
        await page.getByRole('alert').filter({ hasText: 'Verification is incomplete' }).waitFor()
        assert.equal(await page.getByRole('alert').evaluate(el => el === document.activeElement && el.getBoundingClientRect().top >= 0), true)
        if (!process.env.RELAY_PRESERVE_CAPTURES) await page.screenshot({ path: join(root, `.screenshots/m4-verification-incomplete-${width}.png`), fullPage: true })
      } else if (state !== 'empty') await capture(`m4-${state}`)
      if (state === 'long-title') assert.ok((await page.locator('.relay-evidence p').first().innerText()).length < 100)
      assert.equal(await page.getByText('0 screenshot(s)', { exact: true }).count(), 0)
      assert.equal(await page.locator('.relay-verification').evaluate(el => [...el.querySelectorAll('*')].some(node => node.scrollWidth > node.clientWidth + 1)), false)
      if (state === 'manual-form') {
        await page.getByRole('button', { name: 'Record manual verification', exact: true }).click()
        await page.getByText(/Manually verified by user: Verified by the fixture user/).waitFor()
      }
    }
    if (width === 280 || width === 480) {
      await page.evaluate(record => {
        window.smoke.records = [{
          ...record,
          schemaVersion: 3,
          phase: 'draft',
          tasks: [
            { id: 't1', title: 'Update footer CSS', allowedPaths: ['src/styles/**'], status: 'pending', fixCycles: 0, updatedAt: record.updatedAt },
            { id: 't2', title: 'Run end-to-end visual check', status: 'pending', fixCycles: 0, updatedAt: record.updatedAt },
          ],
          checks: [
            { id: 'final-pw', name: 'Final browser check', adapter: 'playwright', command: 'npx playwright test', policy: 'automated-required', scope: 'final' },
          ],
        }]
        window.smoke.runs = []
        window.smoke.evidence = []
      }, record)
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('Scope: src/styles/**', { exact: true }).waitFor()
      await page.getByText('Policy: automated-required · Final gate', { exact: true }).waitFor()
      await page.getByText(/Deferred to final gate/).first().waitFor()
      await page.getByLabel('Task title', { exact: true }).fill('Tighten report escaping')
      await page.getByLabel('Allowed paths (optional)', { exact: true }).fill('src/report.ts, test/report.test.ts')
      await page.getByRole('button', { name: 'Add task', exact: true }).click()
      await page.getByText('Scope: src/report.ts, test/report.test.ts', { exact: true }).waitFor()
      await page.getByLabel('Check name', { exact: true }).fill('Unit suite')
      await page.getByLabel('Check command', { exact: true }).fill('npm test')
      await page.getByRole('combobox', { name: 'Check scope', exact: true }).selectOption('final')
      await page.getByRole('button', { name: 'Add check', exact: true }).click()
      await page.getByRole('button', { name: 'Remove Unit suite', exact: true }).waitFor()
      assert.equal(await page.locator('.relay-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
      await page.screenshot({ path: join(root, `.screenshots/m7-scope-final-${width}.png`), fullPage: true })
    }
    await page.evaluate(() => {
      window.smoke.records[0].phase = 'draft'
      window.smoke.records[0].checks = [{ id: 'scroll-check', name: 'Scroll check', adapter: 'command', command: 'npm test', policy: 'automated-required' }]
      window.smoke.verificationIncomplete = false
      Object.assign(document.querySelector('#panel').style, { height: '600px', display: 'flex', flexDirection: 'column', overflow: 'hidden' })
    })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Policy: automated-required', { exact: true }).waitFor()
    assert.equal(await page.getByText('Scroll check (automated-required)', { exact: true }).count(), 0)
    const constrained = await page.locator('.relay-panel').evaluate(el => {
      const button = [...el.querySelectorAll('button')].find(node => node.textContent === 'Request plan approval')
      button.scrollIntoView({ block: 'center' })
      const outer = el.getBoundingClientRect(); const inner = button.getBoundingClientRect()
      return {
        scrollable: el.scrollHeight > el.clientHeight,
        scrolled: el.scrollTop > 0,
        visible: inner.top >= outer.top && inner.bottom <= outer.bottom,
        enabled: !button.disabled,
        noOverflow: el.scrollWidth <= el.clientWidth,
        scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        outerTop: outer.top, outerBottom: outer.bottom, innerTop: inner.top, innerBottom: inner.bottom,
      }
    })
    assert.equal(constrained.scrollable && constrained.scrolled && constrained.visible && constrained.enabled && constrained.noOverflow, true, `Approval must be reachable in constrained host at ${width}: ${JSON.stringify(constrained)}`)
    await page.close()
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(root, '.screenshots/m4-gui-manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`PASS: built GUI bundle, 280/320/480px, ${screenshotCount} screenshots; themes, disabled controls, interactive pending approval, action plus refresh errors, advancing stale mutation, all existing states; no errors or overflow.`)
} finally { await browser.close() }
