import { Plugin } from '@opencode/plugin/tui'
import { RGBA, TextAttributes } from '@opentui/core'
import { createElement, createTextNode, insert, insertNode, setProp, effect, type JSX } from '@opentui/solid'
import { createSignal, createEffect, createRoot } from 'solid-js'
import { RelayRpc, type RelayApi } from './rpc.ts'
import { phaseActions, isFinalTask, checkScope, type RecordInfo, type PhaseAction, type Owner, type RunInfo, type Evidence, type Check } from './model.ts'
import { canRecordManual, checkView, evidenceView, evidenceTitle } from './view.ts'
import { renderStatus, recordView, failureMessage, visibleError, approvalMessage, pendingMessage, signOffMessage, signOffError } from './view.ts'
import { type ConfigReport, type RoleCheck } from './config.ts'
import { auditSummary } from './report.ts'
import { validateAllowedPaths } from './scope.ts'

const FALLBACK = {
  bg: RGBA.fromInts(20, 22, 26),
  raised: RGBA.fromInts(27, 30, 36),
  border: RGBA.fromInts(56, 62, 74),
  text: RGBA.fromInts(235, 238, 244),
  muted: RGBA.fromInts(156, 163, 175),
  subtle: RGBA.fromInts(114, 122, 136),
  accent: RGBA.fromInts(88, 166, 255),
  ok: RGBA.fromInts(63, 185, 80),
  warn: RGBA.fromInts(210, 153, 34),
  err: RGBA.fromInts(248, 81, 73),
}

function palette(ctx: unknown) {
  const theme = (ctx as { theme?: any })?.theme
  return {
    bg: theme?.background?.base ?? FALLBACK.bg,
    raised: theme?.background?.raised?.base ?? FALLBACK.raised,
    border: theme?.border?.base ?? FALLBACK.border,
    text: theme?.text?.base ?? FALLBACK.text,
    muted: theme?.text?.muted ?? FALLBACK.muted,
    subtle: theme?.text?.faint ?? theme?.text?.subtle ?? FALLBACK.subtle,
    accent: theme?.text?.action?.primary?.base ?? FALLBACK.accent,
    ok: theme?.text?.feedback?.success?.base ?? FALLBACK.ok,
    warn: theme?.text?.feedback?.warning?.base ?? FALLBACK.warn,
    err: theme?.text?.feedback?.error?.base ?? FALLBACK.err,
  }
}

type TuiPalette = ReturnType<typeof palette>

function el(tag: string, props: Record<string, any> = {}, ...children: any[]) {
  const node = createElement(tag)
  for (const key of Object.keys(props)) {
    const desc = Object.getOwnPropertyDescriptor(props, key)
    if (desc?.get) effect(() => setProp(node, key, desc.get!()))
    else setProp(node, key, props[key])
  }
  for (const child of children) {
    if (child == null || child === false) continue
    if (typeof child === 'function') insert(node, child)
    else if (typeof child === 'string' || typeof child === 'number') insertNode(node, createTextNode(String(child)))
    else insertNode(node, child)
  }
  return node
}

function line(content: string, fg: RGBA, attributes?: number) {
  return el('text', attributes === undefined ? { content, fg } : { content, fg, attributes })
}

function clip(text: string, max: number) {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function phaseColor(phase: RecordInfo['phase'], p: TuiPalette) {
  if (phase === 'completed' || phase === 'approved') return p.ok
  if (phase === 'running') return p.accent
  if (phase === 'interrupted') return p.warn
  if (phase === 'cancelled') return p.err
  return p.muted
}

function taskTone(status: string, p: TuiPalette) {
  if (status === 'completed') return { color: p.ok, icon: '✓' }
  if (status === 'running') return { color: p.accent, icon: '●' }
  if (status === 'blocked') return { color: p.err, icon: '✕' }
  if (status === 'awaiting_approval') return { color: p.warn, icon: '◈' }
  return { color: p.muted, icon: '○' }
}

function evidenceTone(label: string, manual: boolean | undefined, p: TuiPalette) {
  if (manual) return { color: p.warn, icon: '◆' }
  if (label.startsWith('Passed')) return { color: p.ok, icon: '✓' }
  if (label.startsWith('Failed')) return { color: p.err, icon: '✕' }
  if (label.startsWith('Deferred') || label.startsWith('Not applicable')) return { color: p.subtle, icon: '·' }
  return { color: p.warn, icon: '◌' }
}

function roleRow(role: RoleCheck, p: TuiPalette) {
  const invalid = role.errors.length > 0 || role.image === 'failed' || role.image === 'error'
  const color = invalid ? p.err : role.model ? p.ok : p.warn
  const icon = invalid ? '✕' : role.model ? '●' : '○'
  const label = role.role.padEnd(9, ' ')
  const model = role.model
    ? `${role.model.providerID}/${role.model.id}${role.model.variant ? ` (${role.model.variant})` : ''}${role.role === 'reviewer' ? ` · image: ${role.image}` : ''}`
    : 'not configured'
  const nodes = [line(`${icon} ${label} ${model}`, color)]
  for (const issue of role.errors) nodes.push(line(`  ${issue}`, p.err))
  if (role.probe) {
    nodes.push(line(`  ${role.probe.status === 'error' ? `Probe error (not cached): ${role.probe.answer}` : `Probe answer: ${role.probe.answer}`}`, role.probe.status === 'error' ? p.err : p.muted))
    nodes.push(line(`  Probe tokens: input ${role.probe.tokens.input}, output ${role.probe.tokens.output}, reasoning ${role.probe.tokens.reasoning}, cache read ${role.probe.tokens.cache.read}, cache write ${role.probe.tokens.cache.write}`, p.subtle))
  }
  return el('box', { flexDirection: 'column', width: '100%' }, ...nodes)
}

function taskSummaryCounts(tasks: ReturnType<typeof recordView>['tasks']) {
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, count]) => `${count} ${status.replaceAll('_', ' ')}`).join(' · ')
}

export default Plugin.define({ id: 'opencode-relay-orchestration', setup(ctx) {
  const [record, setRecord] = createSignal<RecordInfo>()
  const [runs, setRuns] = createSignal<RunInfo[]>([])
  const [evidence, setEvidence] = createSignal<Evidence[]>([])
  const [signingRevision, setSigningRevision] = createSignal<number>()
  const [error, setError] = createSignal('')
  const [config, setConfig] = createSignal<ConfigReport>()
  async function checkConfig(probe = false) {
    try {
      const id = sessionID()
      if (probe && !id) { ctx.ui.toast.show({ message: 'Select a session before running an image probe.', variant: 'error' }); return }
      const result = probe ? await api().probeImage({ parentSessionID: id! }, options()) : await api().validateConfig({}, options())
      setConfig(result)
      const reviewer = result.roles.find(role => role.role === 'reviewer')
      if (probe && (reviewer?.image === 'error' || reviewer?.image === 'failed')) ctx.ui.toast.show({ message: reviewer.image === 'error' ? 'The image probe encountered a host error. No vision verdict was cached.' : 'The image probe answer did not match the expected color.', variant: 'error' })
    }
    catch { ctx.ui.toast.show({ message: probe ? 'Could not run the image probe. Check the reviewer configuration and probe setting.' : 'Could not validate role configuration. Use Relay validate config to retry.', variant: 'error' }) }
  }
  const [panelFocused, setPanelFocused] = createSignal(false)
  let generation = 0
  const lastResults = new Map<string, string>()
  const api = () => { if (!ctx.location) throw new Error('Select a session location before using Relay.'); return ctx.client.rpc(RelayRpc) as unknown as RelayApi }
  const options = () => ({ location: ctx.location })
  function sessionID() { const route = ctx.ui.router.current(); return route.type === 'session' ? route.sessionID : undefined }
  async function refresh() {
    if (!ctx.location) return
    const token = ++generation
    try {
      setConfig(await api().validateConfig({}, options()))
      const records = (await api().listRecords({}, options())).filter(item => item.location.directory === ctx.location?.directory)
      const selected = records.find(item => item.id === record()?.id) ?? records.find(item => item.sessionID === sessionID()) ?? records[0]
      const snapshot = selected ? await api().getSnapshot({ recordID: selected.id }, options()) : undefined
      const runList = snapshot ? await api().listRuns({ recordID: snapshot.id }, options()) : []
      const evidenceList = snapshot ? await api().listEvidence({ id: snapshot.id }, options()) : []
      if (token === generation) {
        setRecord(snapshot); setRuns(runList); setEvidence(evidenceList); setError('')
        const resultKey = snapshot?.approvalResult ? JSON.stringify(snapshot.approvalResult) : ''
        if (snapshot) {
          if (lastResults.has(snapshot.id) && resultKey && resultKey !== lastResults.get(snapshot.id) && approvalMessage(snapshot)) ctx.ui.toast.show({ message: approvalMessage(snapshot), variant: snapshot?.approvalResult?.outcome === 'approved' ? 'success' : 'warning' })
          lastResults.set(snapshot.id, resultKey)
        }
      }
    } catch (failure) { if (token === generation) setError(failureMessage(failure)) }
  }
  async function run(work: () => Promise<RecordInfo>, requestApproval = false) {
    setError('')
    try { setRecord(await work()); await refresh() } catch (failure) { await refresh(); const message = visibleError(failure, record(), requestApproval); setError(message); if (message) ctx.ui.toast.show({ message, variant: 'error' }) }
  }
  const disposeWatch = createRoot(dispose => {
    createEffect(() => { ctx.location; sessionID(); setRecord(undefined); setRuns([]); setEvidence([]); setSigningRevision(undefined); setConfig(undefined); void refresh() })
    return dispose
  })
  const off = ctx.client.rpc(RelayRpc).events.on('changed', event => {
    if (event.location.directory === ctx.location?.directory) void refresh()
  })
  const reconnect = ctx.data.on('server.connected', () => { void refresh() })
  const slot = ctx.ui.slot({ append: 'session.panel', render(input) {
    if (input.name !== 'opencode-relay-orchestration:status') { setPanelFocused(false); return null }
    setPanelFocused(input.focused)
    createEffect(() => setPanelFocused(input.focused))
    createEffect(() => { input.sessionID; void refresh() })
    const p = palette(ctx)
    const header = el('box', { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
      line('Relay', p.text, TextAttributes.BOLD),
      el('text', {
        get content() {
          const current = record()
          if (!current) return 'Idle'
          const done = current.tasks.filter(task => task.status === 'completed').length
          const progress = current.tasks.length ? ` · ${done}/${current.tasks.length}` : ''
          return `● ${current.phase.toUpperCase()} · r${current.revision}${progress}`
        },
        get fg() {
          const current = record()
          return current ? phaseColor(current.phase, p) : p.subtle
        },
        attributes: TextAttributes.BOLD,
      }),
    )
    const buildBody = () => {
      const current = record()
      const view = recordView(current, runs())
      const cfg = config()
      const sections: any[] = []

      const err = error()
      if (err) {
        sections.push(el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: p.err, paddingLeft: 1, paddingRight: 1 },
          line(err, p.err),
        ))
      }

      const pending = pendingMessage(current)
      const approval = approvalMessage(current)
      const signOff = signingRevision() !== undefined ? signOffMessage(signingRevision()!) : ''
      if (pending) {
        sections.push(el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: p.warn, paddingLeft: 1, paddingRight: 1 },
          line(`◌ ${pending}`, p.warn),
        ))
      }
      if (approval) {
        const ok = current?.approvalResult?.outcome === 'approved'
        sections.push(el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: ok ? p.ok : p.warn, paddingLeft: 1, paddingRight: 1 },
          line(`${ok ? '✓' : '✕'} ${approval}`, ok ? p.ok : p.warn),
        ))
      }
      if (signOff) {
        sections.push(el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: p.warn, paddingLeft: 1, paddingRight: 1 },
          line(`◌ ${signOff}`, p.warn),
        ))
      }

      if (!current) {
        sections.push(el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: p.border, backgroundColor: p.raised, paddingLeft: 1, paddingRight: 1 },
          line(view.title, p.text, TextAttributes.BOLD),
          line('Run /relay <task> or /relay-new to create a record.', p.muted),
        ))
      } else {
        const heroNodes: any[] = [
          line(clip(view.title, 200), p.text, TextAttributes.BOLD),
          line(view.revision, p.subtle),
          line(view.location, p.subtle),
          line(view.phase, phaseColor(current.phase, p), TextAttributes.BOLD),
        ]
        if (view.reason) heroNodes.push(line(view.reason, p.warn))
        heroNodes.push(line(view.tokens, p.muted))
        if (view.plannerTokens) heroNodes.push(line(view.plannerTokens, p.muted))
        sections.push(el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: p.border, backgroundColor: p.raised, paddingLeft: 1, paddingRight: 1 }, ...heroNodes))

        const taskHeader = el('box', { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
          line(`Tasks (${view.tasks.length})`, p.accent, TextAttributes.BOLD),
          line(view.tasks.length ? taskSummaryCounts(view.tasks) : 'None', p.subtle),
        )
        const taskCards = view.tasks.map(task => {
          const tone = taskTone(task.status, p)
          const stageLabel = task.attempt ? `${task.stage}, attempt ${task.attempt}` : task.stage
          const ownerLabel = task.owner ? `owner ${task.owner.role}` : 'unassigned'
          const cardNodes: any[] = [
            el('box', { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
              line(`${tone.icon} ${stageLabel}`, tone.color, TextAttributes.BOLD),
              line(`${ownerLabel} · fixes ${task.fixCycles}`, p.subtle),
            ),
            line(clip(task.title, 220), p.text),
          ]
          if (task.scope) cardNodes.push(line(task.scope, p.subtle))
          if (task.summary) cardNodes.push(line(clip(task.summary, 200), p.muted))
          if (task.findings) cardNodes.push(line(task.findings, task.findings.includes('(0 major)') ? p.muted : p.warn))
          if (task.checks) cardNodes.push(line(task.checks, task.checks.includes('failed') ? p.warn : p.muted))
          return el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: task.status === 'pending' ? p.border : tone.color, paddingLeft: 1, paddingRight: 1 }, ...cardNodes)
        })
        sections.push(el('box', { flexDirection: 'column', width: '100%', gap: 1 }, taskHeader, ...(taskCards.length ? taskCards : [line('No tasks yet.', p.subtle)])))

        if (current.checks.length) {
          const checkCards = current.checks.map(check => {
            const policyText = check.policy === 'not-applicable' ? checkView(check).label : `${check.policy}${checkScope(check) === 'final' ? ' · Final gate' : ''}`
            const checkNodes: any[] = [
              el('box', { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
                line(check.name, p.text, TextAttributes.BOLD),
                line(policyText, p.subtle),
              ),
              line(`${check.adapter}: ${check.command}`, p.muted),
            ]
            if (check.policy !== 'not-applicable') {
              for (const task of current.tasks) {
                const latest = evidence().findLast(item => item.taskID === task.id && item.checkID === check.id)
                const item = evidenceView(check, latest, runs(), checkScope(check) === 'final' && !isFinalTask(current, task.id))
                const ev = evidenceTone(item.label, item.manual, p)
                const shots = item.screenshots ? ` (${item.screenshots})` : ''
                checkNodes.push(line(`  ${ev.icon} ${evidenceTitle(task.title)}: ${item.label}${shots}`, ev.color))
              }
            }
            return el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: p.border, paddingLeft: 1, paddingRight: 1 }, ...checkNodes)
          })
          sections.push(el('box', { flexDirection: 'column', width: '100%', gap: 1 },
            line(`Verification (${current.checks.length})`, p.accent, TextAttributes.BOLD),
            ...checkCards,
          ))
        }

        if (view.approvals.length) {
          sections.push(el('box', { flexDirection: 'column', width: '100%' },
            line('Approvals', p.accent, TextAttributes.BOLD),
            ...view.approvals.map(item => line(`· ${item}`, p.muted)),
          ))
        }
      }

      if (cfg) {
        const cfgNodes: any[] = [
          line('Role configuration', p.accent, TextAttributes.BOLD),
          ...(cfg.summary ? [line(cfg.summary, p.subtle)] : []),
          line(`Limits: ${cfg.limits.maxRunningTasks} running tasks, ${cfg.limits.maxFixCycles} fix cycles`, p.subtle),
          ...cfg.roles.map(role => roleRow(role, p)),
          ...cfg.errors.map(issue => line(issue, p.err)),
        ]
        sections.push(el('box', { flexDirection: 'column', width: '100%', border: true, borderStyle: 'rounded', borderColor: p.border, paddingLeft: 1, paddingRight: 1 }, ...cfgNodes))
      }

      return el('box', { flexDirection: 'column', width: '100%', gap: 1 }, ...sections)
    }

    const scroll = el('scrollbox', { flexGrow: 1, width: '100%', flexDirection: 'column' }, () => buildBody())
    const footer = el('box', { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
      line('Esc: close Relay panel', p.subtle),
      line('Ctrl+P: relay commands', p.subtle),
    )
    const root = el('box', { flexDirection: 'column', width: '100%', height: '100%', paddingLeft: 1, paddingRight: 1, paddingTop: 1, gap: 1, focusable: false, backgroundColor: p.bg }, header, scroll, footer)
    return root as unknown as JSX.Element
  } })
  let layerRegistered = false
  const appSlot = ctx.ui.slot({ append: 'app', render() {
    if (!layerRegistered) {
      layerRegistered = true
      ctx.keymap.layer(() => ({ mode: 'global', enabled: () => panelFocused() && ctx.ui.panel.current()?.name === 'opencode-relay-orchestration:status', commands: [{ id: 'relay-panel-escape', bind: 'escape', title: 'Close Relay panel', run: () => { if (!panelFocused() || ctx.ui.panel.current()?.name !== 'opencode-relay-orchestration:status') return false; ctx.ui.panel.close(); setPanelFocused(false) } }] }))
      ctx.keymap.layer(() => ({ mode: 'global', commands: [
    { id: 'relay-validate-config', title: 'Relay validate config', description: 'Validate configured role models without prompting.', palette: true, slash: { name: 'relay-validate-config' }, run: () => checkConfig() },
    { id: 'relay-probe-image', title: 'Relay run image probe', description: 'Explicitly probe the configured reviewer image input.', enabled: () => config()?.enableProbe === true && Boolean(config()?.roles.some(role => role.role === 'reviewer' && role.model && !role.errors.length)), palette: true, slash: { name: 'relay-probe-image' }, run: () => { if (config()?.enableProbe) return checkConfig(true) } },
    { id: 'relay-status', title: 'Relay status', description: 'Open record status and approvals.', palette: true, slash: { name: 'relay-status' }, run: async () => { await refresh(); if (!ctx.ui.panel.open('opencode-relay-orchestration:status')) await ctx.ui.dialog.alert({ title: 'Relay', message: renderStatus(record(), runs(), evidence()) + '\n' + error() }) } },
    { id: 'relay-audit', title: 'Relay audit', description: 'Show related records and worker summaries.', palette: true, slash: { name: 'relay-audit' }, run: async () => {
      await refresh(); const current = record(); if (!current) { ctx.ui.toast.show({ message: 'No Relay record selected.', variant: 'error' }); return }
      try {
        const all = await api().listRecords({}, options())
        const related = current.sessionID ? all.filter(item => item.sessionID === current.sessionID) : [current]
        const summaries = await Promise.all((related.length ? related : [current]).map(async item => auditSummary(item, await api().listRuns({ recordID: item.id }, options()))))
        await ctx.ui.dialog.alert({ title: 'Relay audit', message: summaries.join('\n\n') })
      } catch { ctx.ui.toast.show({ message: 'Could not load Relay audit.', variant: 'error' }) }
    } },
    { id: 'relay-export', title: 'Relay export Markdown', description: 'Write the selected report to .relay/reports.', palette: true, slash: { name: 'relay-export' }, run: async () => {
      const current = record(); if (!current) { ctx.ui.toast.show({ message: 'No Relay record selected.', variant: 'error' }); return }
      try { const report = await api().exportReport({ recordID: current.id, write: true }, options()); ctx.ui.toast.show({ message: `Report written: ${report.path!}`, variant: 'success' }) }
      catch (failure) { ctx.ui.toast.show({ message: failureMessage(failure) === 'Could not write report file.' ? 'Could not write report file.' : 'Could not export Relay report.', variant: 'error' }) }
    } },
    { id: 'relay-add-check', title: 'Add relay check', description: 'Add a verification check in draft.', enabled: () => record()?.phase === 'draft', palette: true, slash: { name: 'relay-add-check' }, run: async () => {
      const current = record(); if (!current || current.phase !== 'draft') return
      const name = await ctx.ui.dialog.prompt({ title: 'Check name' }); if (!name?.trim()) return
      const command = await ctx.ui.dialog.prompt({ title: 'Check command' }); if (!command?.trim()) return
      const adapter = await ctx.ui.dialog.prompt({ title: 'Adapter: command or playwright' }); if (!adapter) return
      const policy = await ctx.ui.dialog.prompt({ title: 'Policy: automated-required, manual-allowed or not-applicable' }); if (!policy) return
      const scopeInput = await ctx.ui.dialog.prompt({ title: 'Scope: task or final (blank for task)' })
      const scope = scopeInput?.trim() || 'task'
      const reason = policy === 'not-applicable' ? await ctx.ui.dialog.prompt({ title: 'Not applicable reason' }) : undefined
      if (!['command', 'playwright'].includes(adapter) || !['automated-required', 'manual-allowed', 'not-applicable'].includes(policy) || !['task', 'final'].includes(scope) || policy === 'not-applicable' && !reason?.trim()) { ctx.ui.toast.show({ message: 'Choose a listed adapter, policy and scope (task or final), with a reason when not applicable.', variant: 'error' }); return }
      await run(() => api().mutate({ recordID: current.id, expectedRevision: current.revision, op: { type: 'addCheck', check: { id: crypto.randomUUID(), name: name.trim(), command: command.trim(), adapter: adapter as Check['adapter'], policy: policy as Check['policy'], ...(scope === 'final' ? { scope: 'final' } : {}), ...(reason ? { reason: reason.trim() } : {}) } } }, options()))
    } },
    { id: 'relay-remove-check', title: 'Remove relay check', description: 'Remove a verification check in draft.', enabled: () => record()?.phase === 'draft', palette: true, slash: { name: 'relay-remove-check' }, run: async () => {
      const current = record(); if (!current || current.phase !== 'draft') return
      const number = await ctx.ui.dialog.prompt({ title: 'Check number', description: current.checks.map((check, index) => `${index + 1}: ${check.name}`).join('\n') })
      const check = current.checks[Number(number) - 1]; if (!number || !check) return
      await run(() => api().mutate({ recordID: current.id, expectedRevision: current.revision, op: { type: 'removeCheck', checkID: check.id } }, options()))
    } },
    { id: 'relay-manual-verify', title: 'Record manual relay verification', description: 'Request permission to record your manual verification.', enabled: () => record()?.phase === 'interrupted', palette: true, slash: { name: 'relay-manual-verify' }, run: async () => {
      const current = record(); if (!current) return
      const choices = current.tasks.flatMap(task => current.checks.filter(check => canRecordManual(current, task.id, check, evidence(), runs())).map(check => ({ task, check })))
      if (!choices.length) return
      const number = await ctx.ui.dialog.prompt({ title: 'Verification number', description: choices.map((item, index) => `${index + 1}: ${item.task.title}: ${item.check.name}`).join('\n') })
      const selected = choices[Number(number) - 1]; if (!number || !selected) return
      const note = await ctx.ui.dialog.prompt({ title: 'Manual verification note' }); if (!note?.trim()) return
      await run(() => api().recordManual({ id: current.id, revision: current.revision, taskID: selected.task.id, checkID: selected.check.id, note: note.trim(), sessionID: sessionID() }, options()))
    } },
    { id: 'relay-close', title: 'Close relay panel', description: 'Close the Relay panel and return to the composer.', palette: true, slash: { name: 'relay-close' }, run: () => { setPanelFocused(false); ctx.ui.panel.close() } },
    { id: 'relay-withdraw', title: 'Withdraw approval request', description: 'Withdraw the pending Relay approval request.', enabled: () => Boolean(record()?.pendingApproval), palette: true, slash: { name: 'relay-withdraw' }, run: async () => { const current = record(); if (!current?.pendingApproval) return; await run(() => api().withdrawApproval({ recordID: current.id, key: current.pendingApproval!.key }, options())) } },
    { id: 'relay-new', title: 'New relay record', description: 'Create a record without starting work.', palette: true, slash: { name: 'relay-new' }, run: async () => { const title = await ctx.ui.dialog.prompt({ title: 'Record title' }); if (title) await run(() => api().createRecord({ title, sessionID: sessionID() }, options())) } },
    { id: 'relay-add-task', title: 'Add relay task', description: 'Add a pending task to the selected record.', enabled: () => recordView(record()).canAdd, palette: true, slash: { name: 'relay-add-task' }, run: async () => { const current = record(); if (!ctx.location || !current) { ctx.ui.toast.show({ message: 'Select a session location and create a relay record first.', variant: 'error' }); return }; if (!recordView(current).canAdd) { ctx.ui.toast.show({ message: 'Plan edits are not available in this phase.', variant: 'error' }); return }; const title = await ctx.ui.dialog.prompt({ title: 'Task title' }); if (!title) return; const rawScope = await ctx.ui.dialog.prompt({ title: 'Allowed paths (optional, comma-separated; blank for unrestricted)' }); const entries = rawScope?.split(',').map(item => item.trim()).filter(Boolean) ?? []; const scoped = entries.length ? validateAllowedPaths(entries) : { ok: true as const, paths: undefined }; if (!scoped.ok) { ctx.ui.toast.show({ message: scoped.message, variant: 'error' }); return }; await run(() => api().mutate({ recordID: current.id, expectedRevision: current.revision, op: { type: 'addTask', title, ...(scoped.paths ? { allowedPaths: scoped.paths } : {}) } }, options())) } },
    { id: 'relay-approve', title: 'Approve relay plan', description: 'Request approval in the record session.', enabled: () => recordView(record()).canApprove, palette: true, slash: { name: 'relay-approve' }, run: async () => { const current = record(); const id = sessionID(); if (!ctx.location || !current || !id) { ctx.ui.toast.show({ message: 'Select a session location and create a relay record first.', variant: 'error' }); return }; if (!recordView(current).canApprove) { ctx.ui.toast.show({ message: 'Plan approval is available only in draft.', variant: 'error' }); return }; await run(() => api().requestApproval({ recordID: current.id, expectedRevision: current.revision, kind: 'plan', sessionID: id }, options()), true) } },
    { id: 'relay-signoff', title: 'Sign off relay record', description: 'Request human sign-off after every task is done.', enabled: () => recordView(record()).canSignOff && signingRevision() === undefined, palette: true, slash: { name: 'relay-signoff' }, run: async () => {
      const current = record(); const id = sessionID()
      if (!current || !id || !recordView(current).canSignOff || signingRevision() !== undefined) return
      const token = generation
      setSigningRevision(current.revision); setError('')
      try { const result = await api().signOff({ recordID: current.id, expectedRevision: current.revision, sessionID: id }, options()); if (id === sessionID() && current.id === record()?.id) { setRecord(result); await refresh() } }
      catch (failure) { if (id === sessionID() && current.id === record()?.id) { await refresh(); const message = signOffError(failure); setError(message); ctx.ui.toast.show({ message, variant: 'error' }) } }
      finally { if (id === sessionID() && token <= generation) setSigningRevision(undefined) }
    } },
    ...(['start', 'interrupt', 'resume', 'complete', 'cancel'] as PhaseAction[]).map(action => ({ id: `relay-${action}`, title: `${action[0].toUpperCase() + action.slice(1)} relay record`, description: `Explicitly ${action} the selected relay record.`, enabled: () => Boolean(record() && phaseActions(record()!).includes(action)), palette: true as const, slash: { name: `relay-${action}` }, run: async () => {
      const current = record()
      if (!current || !phaseActions(current).includes(action)) { ctx.ui.toast.show({ message: 'This transition is not available. Check the phase and current plan approval.', variant: 'error' }); return }
      const reason = action === 'interrupt' ? await ctx.ui.dialog.prompt({ title: 'Interrupt reason' }) : undefined
      if (action === 'interrupt' && !reason?.trim()) return
      await run(() => action === 'complete' ? api().signOff({ recordID: current.id, expectedRevision: current.revision, sessionID: sessionID() }, options()) : api().mutate({ recordID: current.id, expectedRevision: current.revision, op: action === 'interrupt' ? { type: action, reason: reason!.trim() } : { type: action } }, options()))
    } })),
    { id: 'relay-assign-task', title: 'Assign relay task owner', description: 'Assign a role and optional session to a task.', enabled: () => recordView(record()).canEdit, palette: true, slash: { name: 'relay-assign-task' }, run: async () => {
      const current = record(); if (!current || !recordView(current).canEdit) return
      const taskNumber = await ctx.ui.dialog.prompt({ title: 'Task number', description: current.tasks.map((task, index) => `${index + 1}: ${task.title}`).join('\n') })
      if (!taskNumber) return
      const task = current.tasks[Number(taskNumber) - 1]
      if (!task || task.status === 'running') { ctx.ui.toast.show({ message: 'Choose a task that is not running.', variant: 'error' }); return }
      const role = await ctx.ui.dialog.prompt({ title: 'Owner role: planner, builder or reviewer' })
      if (!role) return
      if (!['planner', 'builder', 'reviewer'].includes(role)) { ctx.ui.toast.show({ message: 'Choose planner, builder or reviewer.', variant: 'error' }); return }
      const ownerSession = await ctx.ui.dialog.prompt({ title: 'Owner session ID (optional)' })
      await run(() => api().mutate({ recordID: current.id, expectedRevision: current.revision, op: { type: 'assignTask', taskID: task.id, owner: { role: role as Owner['role'], ...(ownerSession?.trim() ? { sessionID: ownerSession.trim() } : {}) } } }, options()))
    } },
  ] }))
    }
    return null
  } })
  return () => { generation++; disposeWatch(); off(); reconnect(); slot(); appSlot() }
} })
