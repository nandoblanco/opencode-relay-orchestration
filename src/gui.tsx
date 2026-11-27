import { Plugin, Panel, Command, Style, type Context as PluginContext } from '@opencode/plugin/gui'
import { createEffect, createSignal, createMemo, onCleanup, untrack, For, Show } from 'solid-js'
import { RelayRpc, type RelayApi } from './rpc.ts'
import { isFinalTask, checkScope, type RecordInfo, type Status, type Op, type Owner, type RunInfo, type Check, type Evidence } from './model.ts'
import { recordView, visibleError, approvalMessage, pendingMessage, signOffMessage, signOffError } from './view.ts'
import css from './gui.css?inline'
import { type ConfigReport, type RoleCheck } from './config.ts'
import { checkView, evidenceView, canRecordManual, evidenceTitle } from './view.ts'
import { auditSummary } from './report.ts'

function roleState(role: RoleCheck) {
  if (role.errors.length || role.image === 'failed' || role.image === 'error') return 'invalid'
  if (!role.model) return 'missing'
  return 'valid'
}

function evidenceState(label: string, manual?: boolean) {
  if (manual) return 'manual'
  if (label.startsWith('Passed')) return 'passed'
  if (label.startsWith('Failed')) return 'failed'
  if (label.startsWith('Deferred') || label.startsWith('Not applicable')) return 'deferred'
  return 'unverified'
}

export function RelayPanel(props: { ctx: PluginContext }) {
  const [record, setRecord] = createSignal<RecordInfo>()
  const [runs, setRuns] = createSignal<RunInfo[]>([])
  const [evidence, setEvidence] = createSignal<Evidence[]>([])
  const [checkName, setCheckName] = createSignal('')
  const [checkCommand, setCheckCommand] = createSignal('')
  const [checkAdapter, setCheckAdapter] = createSignal<Check['adapter']>('command')
  const [checkPolicy, setCheckPolicy] = createSignal<Check['policy']>('automated-required')
  const [checkScopeValue, setCheckScopeValue] = createSignal<'task' | 'final'>('task')
  const [checkReason, setCheckReason] = createSignal('')
  const [signing, setSigning] = createSignal(false)
  const [signingRevision, setSigningRevision] = createSignal(0)
  const [records, setRecords] = createSignal<RecordInfo[]>([])
  const [error, setError] = createSignal('')
  let errorBanner: HTMLDivElement | undefined
  const [refreshError, setRefreshError] = createSignal('')
  createEffect(() => { if (error() || refreshError()) queueMicrotask(() => { errorBanner?.scrollIntoView({ block: 'nearest' }); errorBanner?.focus({ preventScroll: true }) }) })
  const [busy, setBusy] = createSignal(false)
  const [approving, setApproving] = createSignal(false)
  const [approvalRevision, setApprovalRevision] = createSignal(0)
  const connected = () => Boolean(props.ctx.sessions.current()?.location && props.ctx.sessions.current()?.server.connected)
  let creationDetails: HTMLDetailsElement | undefined
  const [title, setTitle] = createSignal('')
  const [taskTitle, setTaskTitle] = createSignal('')
  const [taskScope, setTaskScope] = createSignal('')
  const [interruptReason, setInterruptReason] = createSignal('')
  const [config, setConfig] = createSignal<ConfigReport>()
  const [configBusy, setConfigBusy] = createSignal(false)
  const [configError, setConfigError] = createSignal('')
  const [configNotice, setConfigNotice] = createSignal('')
  const [audit, setAudit] = createSignal<string[]>([])
  const [auditError, setAuditError] = createSignal('')
  const [exportStatus, setExportStatus] = createSignal('')
  const [exportBusy, setExportBusy] = createSignal(false)
  let auditDetails: HTMLDetailsElement | undefined
  async function loadAudit() {
    const current = record(); if (!current) return
    const key = props.ctx.sessions.current()?.key
    setAuditError(''); setExportStatus('')
    try {
      const { api, options } = target()
      const related = current.sessionID ? records().filter(item => item.sessionID === current.sessionID) : [current]
      const summaries = await Promise.all((related.length ? related : [current]).map(async item => auditSummary(item, await api.listRuns({ recordID: item.id }, options))))
      if (key === props.ctx.sessions.current()?.key && current.id === record()?.id) setAudit(summaries)
    } catch { if (key === props.ctx.sessions.current()?.key) setAuditError('Could not load audit. Close and reopen Audit to retry.') }
  }
  async function exportReport(copy = false) {
    const current = record(); if (!current || exportBusy()) return
    const key = props.ctx.sessions.current()?.key
    setExportBusy(true); setExportStatus(''); setAuditError('')
    try {
      const { api, options } = target()
      const report = await api.exportReport({ recordID: current.id }, options)
      if (key !== props.ctx.sessions.current()?.key || current.id !== record()?.id) return
      if (copy) { await props.ctx.system.copy(report.markdown); setExportStatus('Copied') }
      else setExportStatus(await props.ctx.system.save({ name: report.name, content: report.markdown }) ? 'Report saved' : 'Save cancelled')
    } catch (failure) { if (key === props.ctx.sessions.current()?.key) setAuditError(visibleError(failure) === 'Could not write report file.' ? 'Could not write report file.' : copy ? 'Could not copy report.' : 'Could not export report.') }
    finally { if (key === props.ctx.sessions.current()?.key) setExportBusy(false) }
  }
  const canProbe = () => config()?.enableProbe && config()?.roles.some(role => role.role === 'reviewer' && role.model && !role.errors.length)
  // Automatic loads retry after 0.5 s, 1 s and 2 s because the server can briefly reject plugin
  // RPC while it reloads plugins. Manual actions report failures immediately.
  let epoch = 0
  async function checkConfig(probe = false, retry = 0, notify = false) {
    if (configBusy()) return
    setConfigBusy(true); setConfigError('')
    if (notify) setConfigNotice('')
    const key = props.ctx.sessions.current()?.key
    const token = epoch
    try {
      const { api, options, session } = target()
      const result = probe ? await api.probeImage({ parentSessionID: session.id }, options) : await api.validateConfig({}, options)
      if (key === props.ctx.sessions.current()?.key) {
        setConfig(result)
        if (notify) {
          const issues = result.errors.length + result.roles.reduce((sum, role) => sum + role.errors.length, 0)
          setConfigNotice(issues ? `Checked at ${new Date().toLocaleTimeString()} · ${issues} issue${issues === 1 ? '' : 's'}` : `Validated at ${new Date().toLocaleTimeString()}`)
        }
      }
    }
    catch (failure) {
      if (key !== props.ctx.sessions.current()?.key) return
      console.warn('Relay config check failed', failure)
      if (retry && retry <= 2000) setTimeout(() => { if (token === epoch) void checkConfig(false, retry * 2) }, retry)
      else setConfigError(probe ? 'Could not run the image probe. Check reviewer validation and try again only when authorized.' : 'Could not validate role configuration. Use Validate config to retry.')
    }
    finally { if (key === props.ctx.sessions.current()?.key) setConfigBusy(false) }
  }
  const view = createMemo(() => recordView(record(), runs()))
  const serverPending = () => Boolean(record()?.pendingApproval && record()?.pendingApproval?.revision === record()?.revision)
  const doneCount = () => view().tasks.filter(task => task.status === 'completed').length
  let generation = 0
  function target() {
    const session = props.ctx.sessions.current()
    if (!session?.location || !session.server.connected) throw new Error('Current session server is unavailable. Reconnect, then refresh.')
    return { session, api: session.server.client.rpc(RelayRpc) as unknown as RelayApi, options: { location: session.location } }
  }
  async function refresh(clearError = false, retry = 0) {
    if (clearError) setError('')
    const token = ++generation
    try {
      const { session, api, options } = target()
      const all = (await api.listRecords({}, options)).filter(item => item.location.directory === session.location!.directory)
      const current = record()
      const chosen = all.find(item => item.id === current?.id) ?? all.find(item => item.sessionID === session.id) ?? all[0]
      const snapshot = chosen ? await api.getSnapshot({ recordID: chosen.id }, options) : undefined
      const runList = snapshot ? await api.listRuns({ recordID: snapshot.id }, options) : []
      const evidenceList = snapshot ? await api.listEvidence({ id: snapshot.id }, options) : []
      if (token === generation) { setRecords(all); setRecord(snapshot); setRuns(runList); setEvidence(evidenceList); setRefreshError(''); if (auditDetails?.open) void loadAudit() }
    } catch (failure) {
      if (token !== generation) return
      console.warn('Relay refresh failed', failure)
      if (retry && retry <= 2000) setTimeout(() => { if (token === generation) void refresh(false, retry * 2) }, retry)
      else setRefreshError('Could not refresh. Use Refresh to retry.')
    }
  }
  async function run(work: (api: RelayApi, options: object, sessionID: string) => Promise<RecordInfo>, requestApproval = false) {
    if (requestApproval ? approving() : busy()) return false
    if (requestApproval) { setApproving(true); setApprovalRevision(record()!.revision) } else setBusy(true)
    setError(''); setRefreshError('')
    const sessionKey = props.ctx.sessions.current()?.key
    try {
      const { session, api, options } = target()
      const result = await work(api, options, session.id)
      if (props.ctx.sessions.current()?.key !== sessionKey) return false
      setRecord(result)
      await refresh()
      return true
    } catch (failure) {
      if (props.ctx.sessions.current()?.key !== sessionKey) return false
      await refresh(false)
      setError(visibleError(failure, record(), requestApproval))
      return false
    } finally { if (props.ctx.sessions.current()?.key === sessionKey) { if (requestApproval) setApproving(false); else setBusy(false) } }
  }
  function mutate(op: Op) {
    const current = record()
    if (current) return run((api, options, sessionID) => op.type === 'complete' ? api.signOff({ recordID: current.id, expectedRevision: current.revision, sessionID }, options) : api.mutate({ recordID: current.id, expectedRevision: current.revision, op }, options))
  }
  async function signOff() {
    const current = record()
    if (!current || !view().canSignOff || signing()) return
    const key = props.ctx.sessions.current()?.key
    setSigning(true); setSigningRevision(current.revision); setError('')
    try {
      const { api, options, session } = target()
      const result = await api.signOff({ recordID: current.id, expectedRevision: current.revision, sessionID: session.id }, options)
      if (key !== props.ctx.sessions.current()?.key || current.id !== record()?.id) return
      setRecord(result); await refresh()
    } catch (failure) {
      if (key !== props.ctx.sessions.current()?.key || current.id !== record()?.id) return
      await refresh(); setError(signOffError(failure))
    } finally { if (key === props.ctx.sessions.current()?.key) setSigning(false) }
  }
  createEffect(() => {
    const session = props.ctx.sessions.current()
    const location = session?.location
    const connected = session?.server.connected
    const client = session?.server.client
    generation++; epoch++; setRecord(undefined); setRecords([]); setError(''); setRefreshError(''); setBusy(false); setApproving(false); setTitle(''); setTaskTitle(''); setInterruptReason(''); setConfig(undefined); setConfigBusy(false); setConfigError(''); setConfigNotice('')
    setAudit([]); setAuditError(''); setExportStatus(''); setExportBusy(false)
    setRuns([]); setEvidence([]); setCheckName(''); setCheckCommand(''); setCheckReason(''); setCheckAdapter('command'); setCheckPolicy('automated-required'); setCheckScopeValue('task'); setSigning(false)
    if (!location || !connected || !client) { setError('Select a connected session to view relay records.'); return }
    // Snapshot on mount, location change and reconnection. Every matching event triggers
    // a full snapshot, which also covers revision gaps in this live-only event stream.
    const off = client.rpc(RelayRpc).events.on('changed', event => {
      if (event.location.directory === location.directory) void refresh()
    })
    void refresh(false, 500)
    untrack(() => { void checkConfig(false, 500) })
    onCleanup(() => { off(); generation++; epoch++ })
  })
  return <section class="relay-panel" data-appearance={props.ctx.appearance?.mode()} aria-busy={busy()} aria-label="Relay status">
    <header class="relay-header">
      <div class="relay-header-title">
        <h2>Relay</h2>
        <Show when={record()}><span class="relay-phase-dot" data-phase={record()!.phase} aria-hidden="true" /></Show>
      </div>
      <button type="button" class="relay-btn-sm" disabled={busy()} onClick={() => { void refresh(true); void checkConfig() }}>Refresh</button>
    </header>
    <Show when={error() || refreshError()}><div ref={errorBanner} tabindex="-1" class="relay-error" role="alert"><Show when={error()}><p>{error()}</p></Show><Show when={refreshError()}><p>{refreshError()}</p></Show></div></Show>
    <Show when={pendingMessage(record()) || approving()}>
      <div class="relay-banner relay-banner-warn">
        <p role="status">{pendingMessage(record()) || `Waiting for approval of revision ${approvalRevision()}`}</p>
        <Show when={record()?.pendingApproval}><button type="button" class="relay-btn-sm" disabled={busy()} onClick={() => { const current = record()!; void run((api, options) => api.withdrawApproval({ recordID: current.id, key: current.pendingApproval!.key }, options)) }}>Withdraw approval request</button></Show>
      </div>
    </Show>
    <Show when={approvalMessage(record())}><p class="relay-banner" classList={{ 'relay-banner-ok': record()?.approvalResult?.outcome === 'approved', 'relay-banner-warn': record()?.approvalResult?.outcome !== 'approved' }} role="status">{approvalMessage(record())}</p></Show>
    <Show when={records().length > 1}><label class="relay-picker"><span>Record</span><select value={record()?.id} onChange={event => { setRuns([]); setEvidence([]); setSigning(false); setRecord(records().find(item => item.id === event.currentTarget.value)); void refresh(true) }}><For each={records()}>{item => <option value={item.id}>{item.title}</option>}</For></select></label></Show>
    <div class="relay-hero">
      <Show when={record()} fallback={<><h3 class="relay-record-title">{view().title}</h3><p class="relay-meta">{connected() ? 'Create a record to track tasks. Nothing starts automatically.' : 'Reconnect the selected session to load its records.'}</p></>}>
        <div class="relay-hero-meta">
          <span class="relay-pill relay-phase" data-phase={record()!.phase}>{view().phase}</span>
          <span class="relay-chip relay-mono">{view().revision}</span>
          <Show when={view().tasks.length}><span class="relay-chip">{doneCount()}/{view().tasks.length} done</span></Show>
        </div>
        <h3 class="relay-record-title">{view().title}</h3>
        <p class="relay-location">{view().location}</p>
        <Show when={view().reason}><p class="relay-banner relay-banner-warn" role="status">{view().reason}</p></Show>
        <Show when={signing()}><p class="relay-banner relay-banner-warn" role="status">{signOffMessage(signingRevision())}</p></Show>
        <div class="relay-metrics">
          <p class="relay-meta">{view().tokens}</p>
          <Show when={view().plannerTokens}><p class="relay-meta">{view().plannerTokens}</p></Show>
        </div>
        <Show when={view().actions.some(action => action !== 'interrupt' && action !== 'complete') || view().canSignOff}>
          <div class="relay-actions">
            <For each={view().actions.filter(action => action !== 'interrupt' && action !== 'complete')}>{action => <button type="button" classList={{ 'relay-btn-primary': action === 'start' || action === 'resume', 'relay-btn-subtle': action === 'cancel' }} disabled={busy()} onClick={() => mutate({ type: action })}>{action[0].toUpperCase() + action.slice(1)}</button>}</For>
            <Show when={view().canSignOff}><button type="button" class="relay-btn-primary" disabled={busy() || signing()} onClick={() => { void signOff() }}>Sign off</button></Show>
          </div>
        </Show>
        <Show when={view().actions.includes('interrupt')}><form class="relay-interrupt-form" onSubmit={async event => { event.preventDefault(); if (!interruptReason().trim()) return; if (await mutate({ type: 'interrupt', reason: interruptReason().trim() })) setInterruptReason('') }}>
          <label>Interrupt reason<input maxLength={500} value={interruptReason()} onInput={event => setInterruptReason(event.currentTarget.value)} required /></label><button disabled={busy() || !interruptReason().trim()}>Interrupt</button>
        </form></Show>
      </Show>
    </div>
    <Show when={record()}>
      <section class="relay-section" aria-label="Tasks">
        <div class="relay-section-head">
          <h3>Tasks</h3>
          <Show when={view().tasks.length}><span class="relay-count">{view().tasks.length}</span></Show>
        </div>
        <Show when={record()?.phase === 'running'}><p class="relay-hint">Task status and owner are managed by Relay while running. Interrupt to edit.</p></Show>
        <Show when={view().tasks.length} fallback={<p class="relay-meta">No tasks yet.</p>}>
          <ul class="relay-tasks"><For each={view().tasks}>{task => {
            const [expanded, setExpanded] = createSignal(false)
            const isLong = () => task.title.length > 160
            return <li class="relay-task-card" data-status={task.status}>
              <div class="relay-task-head">
                <p class="relay-stage" data-stage={task.stage.toLowerCase().replace(/\s+/g, '-')}>{task.stage}{task.attempt ? ` · Attempt ${task.attempt}` : ''}</p>
                <span class="relay-meta">Fix cycles: {task.fixCycles}</span>
              </div>
              <p class="relay-task-title" classList={{ 'relay-clamped': isLong() && !expanded() }}>{task.title}</p>
              <Show when={isLong()}><button type="button" class="relay-link-btn" onClick={() => setExpanded(prev => !prev)}>{expanded() ? 'Show less' : 'Show full prompt'}</button></Show>
              <Show when={task.scope}><p class="relay-chip relay-mono relay-scope">{task.scope}</p></Show>
              <Show when={task.summary}><div class="relay-report-box"><p class="relay-report" title={task.summary}>{task.summary}</p></div></Show>
              <Show when={task.findings || task.checks}>
                <div class="relay-task-signals">
                  <Show when={task.findings}><p class="relay-signal" classList={{ 'relay-signal-warn': !task.findings.includes('(0 major)') }}>{task.findings}</p></Show>
                  <Show when={task.checks}><p class="relay-signal" classList={{ 'relay-signal-warn': task.checks.includes('failed') }}>{task.checks}</p></Show>
                </div>
              </Show>
              <div class="relay-task-controls">
                <label>Status<select value={task.status} disabled={busy() || !view().canEdit} onChange={event => mutate({ type: 'setTaskStatus', taskID: task.id, status: event.currentTarget.value as Status })}>
                  <For each={['pending', 'running', 'blocked', 'awaiting_approval', 'completed']}>{status => <option value={status} disabled={status === 'running' && (record()?.phase !== 'running' || !task.owner || task.status === 'running')}>{status.replaceAll('_', ' ')}</option>}</For>
                </select></label>
                <label>Owner role<select value={task.owner?.role ?? ''} aria-describedby={task.status === 'running' ? `relay-owner-${task.id}` : undefined} disabled={busy() || !view().canEdit || task.status === 'running'} onChange={event => { if (event.currentTarget.value) void mutate({ type: 'assignTask', taskID: task.id, owner: { role: event.currentTarget.value as Owner['role'] } }) }}>
                  <option value="" disabled>Unassigned</option><For each={['planner', 'builder', 'reviewer']}>{role => <option value={role}>{role}</option>}</For>
                </select></label>
              </div>
              <Show when={task.status === 'running' || task.owner?.sessionID}>
                <div class="relay-task-foot">
                  <Show when={task.status === 'running'}><p id={`relay-owner-${task.id}`} class="relay-meta">Owner is locked while the task is running</p></Show>
                  <Show when={task.owner?.sessionID}><p class="relay-meta relay-mono">Owner session: {task.owner!.sessionID}</p></Show>
                </div>
              </Show>
            </li>
          }}</For></ul>
        </Show>
        <Show when={view().canAdd}><div class="relay-form-card"><form onSubmit={async event => { event.preventDefault(); const paths = taskScope().split(',').map(item => item.trim()).filter(Boolean); if (!busy() && taskTitle().trim() && await mutate({ type: 'addTask', title: taskTitle(), ...(paths.length ? { allowedPaths: paths } : {}) })) { setTaskTitle(''); setTaskScope('') } }}>
          <div class="relay-form-grid">
            <label>Task title<input value={taskTitle()} onInput={event => setTaskTitle(event.currentTarget.value)} required /></label>
            <label>Allowed paths (optional)<input placeholder="src/app.ts, src/styles/**" value={taskScope()} onInput={event => setTaskScope(event.currentTarget.value)} /></label>
          </div>
          <button disabled={busy()}>Add task</button>
        </form></div></Show>
      </section>
      <section class="relay-verification" aria-label="Verification">
        <div class="relay-section-head">
          <h3>Verification</h3>
          <Show when={record()!.checks.length}><span class="relay-count">{record()!.checks.length}</span></Show>
        </div>
        <Show when={record()!.checks.length} fallback={<p class="relay-meta">No verification checks.</p>}>
          <ul><For each={record()!.checks}>{check => <li class="relay-check-card">
            <div class="relay-check-head">
              <p class="relay-check-name"><strong>{check.name}</strong></p>
              <p class="relay-chip">{check.policy === 'not-applicable' ? checkView(check).label : `Policy: ${check.policy}${checkScope(check) === 'final' ? ' · Final gate' : ''}`}</p>
            </div>
            <p class="relay-code">{check.adapter}: {check.command}</p>
            <Show when={record()!.phase === 'draft'}><div class="relay-actions"><button type="button" class="relay-btn-sm relay-btn-subtle" disabled={busy()} onClick={() => mutate({ type: 'removeCheck', checkID: check.id })}>Remove {check.name}</button></div></Show>
            <For each={check.policy === 'not-applicable' ? [] : record()!.tasks}>{task => {
              const latest = () => evidence().findLast(item => item.taskID === task.id && item.checkID === check.id)
              const item = () => evidenceView(check, latest(), runs(), checkScope(check) === 'final' && !isFinalTask(record()!, task.id))
              const [note, setNote] = createSignal('')
              return <div class="relay-evidence" data-state={evidenceState(item().label, item().manual)} classList={{ 'relay-evidence-manual': item().manual }}>
                <p title={task.title}>{evidenceTitle(task.title)}: {item().label}</p>
                <Show when={item().screenshots}><p class="relay-meta">{item().screenshots}</p></Show>
                <Show when={canRecordManual(record()!, task.id, check, evidence(), runs())}><form onSubmit={async event => { event.preventDefault(); const current = record()!; if (note().trim() && await run((api, options, sessionID) => api.recordManual({ id: current.id, revision: current.revision, taskID: task.id, checkID: check.id, note: note().trim(), sessionID }, options))) setNote('') }}><label>Manual verification note<input maxLength={1000} required value={note()} onInput={event => setNote(event.currentTarget.value)} /></label><button disabled={busy() || !note().trim()}>Record manual verification</button></form></Show>
              </div>
            }}</For>
          </li>}</For></ul>
        </Show>
        <Show when={record()!.phase === 'draft'}><div class="relay-form-card"><form onSubmit={async event => { event.preventDefault(); if (await mutate({ type: 'addCheck', check: { id: crypto.randomUUID(), name: checkName().trim(), command: checkCommand().trim(), adapter: checkAdapter(), policy: checkPolicy(), ...(checkScopeValue() === 'final' ? { scope: 'final' } : {}), ...(checkPolicy() === 'not-applicable' ? { reason: checkReason().trim() } : {}) } })) { setCheckName(''); setCheckCommand(''); setCheckReason(''); setCheckScopeValue('task') } }}>
          <div class="relay-form-grid">
            <label>Check name<input maxLength={120} required value={checkName()} onInput={event => setCheckName(event.currentTarget.value)} /></label>
            <label>Check command<input maxLength={160} required value={checkCommand()} onInput={event => setCheckCommand(event.currentTarget.value)} /></label>
          </div>
          <div class="relay-form-grid">
            <label>Adapter<select value={checkAdapter()} onChange={event => setCheckAdapter(event.currentTarget.value as Check['adapter'])}><option value="command">Command</option><option value="playwright">Playwright</option></select></label>
            <label>Verification policy<select value={checkPolicy()} onChange={event => setCheckPolicy(event.currentTarget.value as Check['policy'])}><option value="automated-required">Automated required</option><option value="manual-allowed">Manual allowed</option><option value="not-applicable">Not applicable</option></select></label>
            <label>Check scope<select value={checkScopeValue()} onChange={event => setCheckScopeValue(event.currentTarget.value as 'task' | 'final')}><option value="task">Each task</option><option value="final">Final gate</option></select></label>
          </div>
          <Show when={checkPolicy() === 'not-applicable'}><label>Not applicable reason<input maxLength={500} required value={checkReason()} onInput={event => setCheckReason(event.currentTarget.value)} /></label></Show>
          <p class="relay-meta">Commands run in the record directory with plugin privileges after plan approval. Playwright writes PNGs to .screenshots/.</p>
          <button disabled={busy()}>Add check</button>
        </form></div></Show>
      </section>
      <section class="relay-section" aria-label="Approvals">
        <div class="relay-section-head"><h3>Approvals</h3></div>
        <Show when={view().approvals.length} fallback={<p class="relay-meta">No plan approvals.</p>}><ul class="relay-approvals"><For each={view().approvals}>{approval => <li>{approval}</li>}</For></ul></Show>
        <Show when={view().canApprove}><button type="button" class="relay-btn-primary" disabled={busy() || approving() || serverPending()} onClick={async () => { if (busy() || approving() || serverPending()) return; const current = record()!; await run((api, options, sessionID) => api.requestApproval({ recordID: current.id, expectedRevision: current.revision, kind: 'plan', sessionID }, options), true) }}>Request plan approval</button></Show>
      </section>
      <details ref={auditDetails} class="relay-audit" onToggle={event => { if (event.currentTarget.open) void loadAudit() }}><summary>Audit</summary>
        <div class="relay-audit-body">
          <Show when={audit().length}><ul class="relay-audit-list"><For each={audit()}>{summary => <li>{summary}</li>}</For></ul></Show>
          <p class="relay-meta">Export and Copy use the current record.</p>
          <div class="relay-actions"><button type="button" class="relay-btn-sm" disabled={exportBusy()} onClick={() => { void exportReport() }}>Export Markdown</button><button type="button" class="relay-btn-sm" disabled={exportBusy()} onClick={() => { void exportReport(true) }}>Copy</button></div>
          <Show when={exportStatus()}><p class="relay-meta" role="status" aria-live="polite">{exportStatus()}</p></Show><Show when={auditError()}><p role="alert" class="relay-error">{auditError()}</p></Show>
        </div>
      </details>
    </Show>
    <Show when={connected()}><details ref={creationDetails}><summary>New record</summary><form onSubmit={async event => { event.preventDefault(); if (!busy() && title().trim() && await run((api, options, sessionID) => api.createRecord({ title: title(), sessionID }, options))) { setTitle(''); if (creationDetails) creationDetails.open = false } }}>
      <label>Record title<input value={title()} onInput={event => setTitle(event.currentTarget.value)} required /></label><button disabled={busy()}>Create record</button>
    </form></details></Show>
    <section class="relay-config-section" aria-label="Role configuration">
      <div class="relay-section-head">
        <h3>Role configuration</h3>
        <div class="relay-actions">
          <button type="button" class="relay-btn-sm" disabled={configBusy()} onClick={() => { void checkConfig(false, 0, true) }}>Validate config</button>
          <Show when={canProbe()}><button type="button" class="relay-btn-sm" disabled={configBusy()} onClick={() => { if (canProbe()) void checkConfig(true, 0, true) }}>Run image probe</button></Show>
        </div>
      </div>
      <Show when={configNotice()}><p class="relay-meta">{configNotice()}</p></Show>
      <Show when={configError()}><p class="relay-error" role="alert">{configError()}</p></Show>
      <Show when={config()}>
        <div class="relay-config-summary">
          <Show when={config()!.summary}><span>{config()!.summary}</span></Show>
          <span>Limits: {config()!.limits.maxRunningTasks} running tasks, {config()!.limits.maxFixCycles} fix cycles</span>
        </div>
        <div class="relay-role-grid">
          <For each={config()!.roles}>{role => <div class="relay-role-card" data-state={roleState(role)}>
            <div class="relay-role-head">
              <span class="relay-role-dot" aria-hidden="true" />
              <span>{role.role}: {role.model ? 'configured' : 'not configured'}</span>
            </div>
            <Show when={role.model}>
              <div class="relay-role-identity">
                <span>Provider: {role.model!.providerID}</span>
                <span>Model: {role.model!.id}</span>
                <Show when={role.model!.variant}><span>Variant: {role.model!.variant}</span></Show>
              </div>
              <p class="relay-role-validation">Validation: {role.errors.length ? 'invalid' : 'valid'}; image: {role.image}</p>
            </Show>
            <For each={role.errors}>{issue => <p class="relay-role-error">{issue}</p>}</For>
            <Show when={role.probe}>
              <p class="relay-role-validation">{role.probe!.status === 'error' ? `Probe error (not cached): ${role.probe!.answer}` : `Probe answer: ${role.probe!.answer}`}</p>
              <p class="relay-role-validation relay-mono">Probe tokens: input {role.probe!.tokens.input}, output {role.probe!.tokens.output}, reasoning {role.probe!.tokens.reasoning}, cache read {role.probe!.tokens.cache.read}, cache write {role.probe!.tokens.cache.write}</p>
            </Show>
          </div>}</For>
        </div>
        <For each={config()!.errors}>{issue => <p class="relay-role-error">{issue}</p>}</For>
      </Show>
    </section>
  </section>
}
export default Plugin.define({ setup(ctx) {
  ctx.add(Style, css)
  const tab = { id: 'relay-status', title: 'Relay', closable: 'hover' as const }
  ctx.add(Panel, { id: 'relay-status', region: 'side', list: () => [tab], render: () => <RelayPanel ctx={ctx} /> })
  ctx.add(Command, { id: 'relay-status', title: 'Relay status', slash: { name: 'relay-status' }, run: () => { const session = ctx.sessions.current(); if (session) ctx.layout.open(`${ctx.id}:relay-status`, session) } })
} })
