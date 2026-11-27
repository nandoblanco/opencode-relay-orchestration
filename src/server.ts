import { Plugin } from '@opencode/plugin'
type Context = Plugin.Context
import { RelayRpc } from './rpc.ts'
import { createStore, StoreError, validateCheck, type Op, type RecordInfo } from './store.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { auditMarkdown } from './report.ts'
import { effectiveConfig, configSummary, roles, probeKey, type ConfigInput, type SavedConfig, type ConfigReport, type ProbeResult } from './config.ts'
import { createOrchestrator, cleanTitle as promptTitle, reportSchema, workerApiDenials } from './orchestrator.ts'
import { Tool } from '@opencode/schema/tool'
import { preflight, runCheck } from './verify.ts'
import { registerPlanner, plannerTools } from './planner.ts'
import { checkScopeViolation } from './scope.ts'

export const approveAction = 'relay.approve'
export const signOffAction = 'relay.signoff'
export const verifyAction = 'relay.verify'
export { workerApiDenials, promptTitle }
export function evaluateApproval(input: { action: string; effect: 'allow' | 'deny' | 'ask'; message?: string; metadata?: Record<string, unknown> }) {
  if (![approveAction, signOffAction, verifyAction].includes(input.action) || input.effect === 'deny') return
  input.effect = 'ask'
  if (input.action === verifyAction) {
    input.message = `Record manual verification for ${promptTitle(String(input.metadata?.checkName ?? 'check'))}, task ${promptTitle(String(input.metadata?.taskTitle ?? 'task'), 40)}? Note: ${promptTitle(String(input.metadata?.note ?? ''), 1000)}. This is not a plugin-run pass.`
    return
  }
  if (input.action === signOffAction) {
    input.message = `Sign off ${promptTitle(String(input.metadata?.title ?? 'record'))}? ${Number(input.metadata?.taskCount) || 0} tasks completed, revision ${Number(input.metadata?.revision) || 0}.`
    return
  }
  const details = []
  if (input.metadata?.taskCount !== undefined && Number.isFinite(Number(input.metadata.taskCount))) details.push(`${Number(input.metadata.taskCount)} tasks`)
  if (input.metadata?.revision !== undefined && Number.isFinite(Number(input.metadata.revision))) details.push(`revision ${Number(input.metadata.revision)}`)
  input.message = `Approve plan${input.metadata?.title ? ` for ${promptTitle(String(input.metadata.title))}` : ''}?${details.length ? ` ${details.join(', ')}.` : ''}`
  const titles = input.metadata?.taskTitles
  if (Array.isArray(titles) && titles.every(title => typeof title === 'string') && titles.length) {
    const shown = titles.slice(0, 3).map(title => promptTitle(title, 32))
    const more = Math.max(0, Number(input.metadata?.taskCount) - shown.length)
    input.message = input.message.replace(/[?.]$/, '') + `: ${shown.join('; ')}${more ? ` (+${more} more)` : ''}.`
  }
  if (Array.from(input.message).length > 240) input.message = Array.from(input.message).slice(0, 237).join('') + '...'
  const checks = input.metadata?.checks as { name: string; command: string; scope?: string }[] | undefined
  if (checks) input.message += `\nChecks: ${Number(input.metadata?.checkCount) || 0}\n${checks.slice(0, 10).map(check => `${promptTitle(check.name, 120)}${check.scope === 'final' ? ' [final]' : ''}: ${check.command}`).join('\n')}${Number(input.metadata?.checkCount) > checks.length ? `\n+${Number(input.metadata?.checkCount) - checks.length} more` : ''}`
}
export async function setup(ctx: Context, adapter = { preflight, runCheck }) {
  const getConfig = async () => effectiveConfig(ctx.options, await ctx.storage.get('relay/config') as SavedConfig | undefined)
  const config = await getConfig()
  const store = createStore(ctx.storage, { directory: ctx.location.directory, projectID: ctx.location.project.id }, config.limits)
  let scopeForSession: ((sessionID: string) => { directory: string; allowedPaths: string[] } | undefined) | undefined
  const hook = await ctx.permission.hook('evaluate', input => {
    const scope = scopeForSession?.(input.sessionID)
    if (scope && input.effect !== 'deny') {
      const violation = checkScopeViolation(scope.directory, input.action, input.resources, scope.allowedPaths)
      if (violation) { input.effect = 'deny'; input.message = violation; return }
    }
    if (input.action === 'relay.configure' && input.effect !== 'deny') { input.effect = 'ask'; input.message = `Save Relay configuration? ${String(input.metadata?.summary ?? '')}`; return }
    evaluateApproval(input)
  })
  const locks = new Set<string>()
  const lockQueues = new Map<string, Promise<void>>()
  const configuring = new Set<string>()
  function lockdown(sessionID: string, active: boolean) {
    const work = (lockQueues.get(sessionID) ?? Promise.resolve()).then(async () => {
      const key = `relay/lockdown/${sessionID}`
      const previous = await ctx.storage.get(key)
      if (previous) locks.add(sessionID)
      const needed = active || configuring.has(sessionID) || (await store.list()).some(record => record.sessionID === sessionID && !['completed', 'cancelled'].includes(record.phase))
      if (needed === locks.has(sessionID)) return
      let session
      try { session = await ctx.session.get({ sessionID }) }
      catch (failure) {
        if (failure && typeof failure === 'object' && '_tag' in failure && failure._tag === 'SessionNotFoundError') {
          locks.delete(sessionID)
          await ctx.storage.remove(key)
        }
        throw failure
      }
      const permissions = [...(session.permissions ?? [])]
      if (needed) {
        // Existing matching denies belong to the user, not this plugin.
        if (permissions.some(rule => rule.action === 'shell' && rule.resource === '*opencode*' && rule.effect === 'deny')) return
        try { await ctx.session.update({ sessionID, permissions: [...permissions, { action: 'shell', resource: '*opencode*', effect: 'deny' }] }) }
        catch (failure) {
          locks.delete(sessionID)
          await ctx.storage.remove(key)
          throw failure
        }
        await ctx.storage.set(key, { owned: true })
        locks.add(sessionID)
      } else {
        const index = permissions.findLastIndex(rule => rule.action === 'shell' && rule.resource === '*opencode*' && rule.effect === 'deny')
        if (index >= 0) permissions.splice(index, 1)
        await ctx.session.update({ sessionID, permissions })
        locks.delete(sessionID)
        await ctx.storage.remove(key)
      }
    }).catch(failure => { console.error('Relay lockdown failed', sessionID, failure) })
    lockQueues.set(sessionID, work)
    return work
  }
  async function configure(input: ConfigInput, sessionID: string) {
    if (configuring.has(sessionID)) throw new Tool.Error({ message: 'A Relay configuration request is already pending in this session.' })
    configuring.add(sessionID)
    try {
      await lockdown(sessionID, true)
      const before = await ctx.storage.get('relay/config') as SavedConfig | undefined
      const saved: SavedConfig = { ...before, ...input, roles: { ...before?.roles, ...input.roles }, limits: { ...before?.limits, ...input.limits }, version: 1, updatedAt: before?.updatedAt ?? 'pending' }
      const summary = `${configSummary(effectiveConfig(ctx.options, saved))}; models ${JSON.stringify(effectiveConfig(ctx.options, saved).models)}`
      try { await ctx.permission.assert({ sessionID, action: 'relay.configure', resources: ['relay-config'], metadata: { summary } }) }
      catch (failure) {
        if (failure && typeof failure === 'object' && '_tag' in failure && (failure._tag === 'Permission.DeclinedError' || failure._tag === 'Tool.Error')) throw new Tool.Error({ message: 'Settings not saved: permission was denied.' })
        throw failure
      }
      if (JSON.stringify(await ctx.storage.get('relay/config')) !== JSON.stringify(before)) throw new Tool.Error({ message: 'Relay configuration changed while approval was pending. Run /relay-configure again to review the current settings.' })
      saved.updatedAt = new Date().toISOString()
      await ctx.storage.set('relay/config', saved)
      const read = await ctx.storage.get('relay/config')
      if (JSON.stringify(read) !== JSON.stringify(saved)) throw new Tool.Error({ message: 'Relay configuration could not be verified after saving.' })
      return `${configSummary(effectiveConfig(ctx.options, saved))}; models ${JSON.stringify(effectiveConfig(ctx.options, saved).models)}`
    } finally {
      configuring.delete(sessionID)
      await lockdown(sessionID, false)
    }
  }
  const pending = new Map<string, { token: string; sessionID: string; resource: string; action: string }>()
  const results = new Map<string, NonNullable<RecordInfo['approvalResult']>>()
  const plannerUpdates = new Map<string, Promise<RecordInfo>>()
  async function restorePlanner(record: RecordInfo): Promise<RecordInfo> {
    if (!record.plannerSession || !record.sessionID) return record
    const active = plannerUpdates.get(record.id)
    if (active) {
      const settled = await active
      return ['completed', 'cancelled'].includes(record.phase) && !settled.plannerSession?.tokensAtEnd ? restorePlanner(await store.get(record.id)) : settled
    }
    const work = async () => {
      let current = await store.get(record.id)
      const tracking = current.plannerSession!
      if (!tracking.restoredAt) {
        current = await store.updatePlanner(record.id, planner => { planner.restoredAt = new Date().toISOString() })
        if (tracking.previousModel) try { await ctx.session.switchModel({ sessionID: record.sessionID!, model: tracking.previousModel }) } catch (failure) { console.error('Relay planner model restore failed', record.id, failure) }
      }
      if (['completed', 'cancelled'].includes(current.phase) && !current.plannerSession!.tokensAtEnd) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const session = await Promise.race([ctx.session.get({ sessionID: record.sessionID! }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Planner token capture timed out')), 10000) })])
          const tokens = session.tokens
          current = await store.updatePlanner(record.id, planner => { planner.tokensAtEnd = { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: { read: tokens.cache.read, write: tokens.cache.write } } })
        } catch (failure) { console.error('Relay planner token capture failed', record.id, failure) }
        finally { clearTimeout(timer) }
      }
      return current
    }
    const pending = work().catch(failure => { console.error('Relay planner lifecycle failed', record.id, failure); return record }).finally(() => plannerUpdates.delete(record.id))
    plannerUpdates.set(record.id, pending)
    return pending
  }
  function snapshot(record: RecordInfo) {
    const key = [...pending.keys()].find(key => key === `${record.id}@${record.revision}` || key === `signoff:${record.id}@${record.revision}` || key.startsWith(`${record.id}@${record.revision}:`))
    return { ...record, ...(key ? { pendingApproval: { key, revision: record.revision } } : {}), ...(results.has(record.id) ? { approvalResult: results.get(record.id) } : {}) }
  }
  const probes = new Set<string>()
  const probeSessions = new Set<string>()
  const imageProbes = new Set<string>()
  const imageErrors = new Map<string, ProbeResult>()
  async function validateConfig(): Promise<ConfigReport> {
    const config = await getConfig()
    const models = await ctx.model.list({})
    const checks: ConfigReport['roles'] = []
    for (const role of roles) {
      const model = config.models[role]
      const found = model ? models.data.find(item => item.id === model.id && item.providerID === model.providerID) : undefined
      const errors = config.errors.filter(message => message.startsWith(`roles.${role}`))
      const variant = Boolean(found && (!model?.variant || found.variants.some(item => item.id === model.variant)))
      if (model) {
        if (!found) errors.push('Model not found')
        else { if (!found.enabled) errors.push('Model is disabled'); if (!variant) errors.push('Variant not found'); if (!found.capabilities.tools) errors.push('Tools are required'); if (role === 'reviewer' && !found.capabilities.input.includes('image')) errors.push('Image input is not declared') }
      }
      const probe = model && role === 'reviewer' ? imageErrors.get(probeKey(model)) ?? await ctx.storage.get(probeKey(model)) as ProbeResult | undefined : undefined
      checks.push({ role, ...(model ? { model } : {}), exists: Boolean(found), enabled: Boolean(found?.enabled), variant, tools: Boolean(found?.capabilities.tools), image: !model ? 'not configured' : role !== 'reviewer' ? 'not required' : probe?.status ?? (found?.capabilities.input.includes('image') ? 'declared' : 'unavailable'), errors, ...(probe ? { probe } : {}) })
    }
    return { roles: checks, errors: config.errors, limits: config.limits, enableProbe: config.enableProbe, widths: config.widths, autoStart: config.autoStart, explorer: config.explorer, brainstormFirst: config.brainstormFirst, source: config.source, summary: configSummary(config) }
  }
  async function validateSession(sessionID: string) {
    let session
    try { session = await ctx.session.get({ sessionID }) } catch { throw new StoreError('invalid_op') }
    if (session.projectID !== ctx.location.project.id || session.location.directory !== ctx.location.directory) throw new StoreError('invalid_op')
    return session
  }
  let registration: { dispose(): Promise<void>; events: { emit(name: 'changed', data: { recordID: string; revision: number }): Promise<void> } }
  const guarded = async (work: () => Promise<unknown>, error: (type: keyof typeof RelayRpc.methods.mutate.errors, message: string, data: object) => unknown) => {
    try { return await work() } catch (failure) {
      if (!(failure instanceof StoreError)) throw failure
      return error(failure.code, failure.message, failure.code === 'stale_revision' ? { currentRevision: failure.currentRevision } : {})
    }
  }
  async function changed(work: Promise<Awaited<ReturnType<typeof store.get>>>) {
    let record = await work
    if (['completed', 'cancelled'].includes(record.phase)) record = await restorePlanner(record)
    if (record.sessionID) await lockdown(record.sessionID, !['completed', 'cancelled'].includes(record.phase))
    try { await registration.events.emit('changed', { recordID: record.id, revision: record.revision }) }
    catch (failure) { console.error('Relay change event failed after persistence', failure) }
    return snapshot(record)
  }
  async function withdraw(record: RecordInfo, key: string) {
    const request = pending.get(key)
    if (!request || !(key.startsWith(`${record.id}@`) || key.startsWith(`signoff:${record.id}@`))) throw new StoreError('invalid_op')
    pending.delete(key)
    results.set(record.id, { revision: Number(key.slice(key.indexOf('@') + 1).split(':')[0]), outcome: 'withdrawn', at: new Date().toISOString() })
    try {
      const requests = await ctx.permission.list({ sessionID: request.sessionID })
      for (const item of requests) if (item.action === request.action && item.resources.length === 1 && item.resources[0] === request.resource) {
        try { await ctx.permission.reply({ sessionID: request.sessionID, requestID: item.id, decision: 'reject' }) }
        catch (failure) { console.error('Relay host approval withdrawal failed', failure) }
      }
    } catch (failure) { console.error('Relay host approval withdrawal failed', failure) }
    return changed(store.get(record.id))
  }
  const orchestrator = createOrchestrator(ctx, store, config, record => changed(Promise.resolve(record)), adapter, getConfig)
  scopeForSession = orchestrator.scopeForSession
  async function mutate(input: { recordID: string; expectedRevision: number; op: Op }) {
    store.limits((await getConfig()).limits)
    const key = [...pending].find(([key, request]) => request.action === approveAction && key.startsWith(`${input.recordID}@`))?.[0]
    if (key && input.op.type !== 'cancel') throw new StoreError('approval_pending')
    if (key && input.op.type === 'cancel') {
      const record = await store.get(input.recordID)
      if (record.revision !== input.expectedRevision) throw new StoreError('stale_revision', record.revision)
      await withdraw(record, key)
    }
    return snapshot(await orchestrator.mutate(input.recordID, input.expectedRevision, input.op))
  }
  async function requestPlan(input: { recordID: string; expectedRevision: number; kind: 'plan'; sessionID?: string }, autoStart = false) {
    const record = await store.get(input.recordID)
    if (record.phase !== 'draft') throw new StoreError('invalid_op')
    if (record.revision !== input.expectedRevision) throw new StoreError('stale_revision', record.revision)
    if (record.sessionID && input.sessionID && record.sessionID !== input.sessionID) throw new StoreError('invalid_op')
    const sessionID = record.sessionID ?? input.sessionID
    if (!sessionID) throw new StoreError('invalid_op')
    await validateSession(sessionID)
    for (const check of record.checks) {
      try { validateCheck(check) }
      catch (failure) {
        if (!(failure instanceof StoreError)) throw failure
        failure.message = `Check "${promptTitle(check.name)}" contains unsupported characters or settings; remove and re-add it.`
        throw failure
      }
    }
    const key = `${record.id}@${input.expectedRevision}`
    if (pending.has(key)) throw new StoreError('approval_pending')
    const token = randomUUID()
    pending.set(key, { token, sessionID, resource: key, action: approveAction })
    // Never race assert against abort: retain the key while the host prompt is open.
    // Once opened, the human answer survives client disconnects unless explicitly withdrawn.
    const waiting = await changed(Promise.resolve(record))
    async function settle() {
      try {
        const approved = await store.approve(input.recordID, input.expectedRevision, async () => {
          if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
          try { await ctx.permission.assert({ sessionID: sessionID!,
            action: approveAction, resources: [`${input.recordID}@${input.expectedRevision}`],
            metadata: { recordID: input.recordID, title: promptTitle(record.title), taskTitles: record.tasks.slice(0, 3).map(task => promptTitle(task.title, 32)), taskCount: record.tasks.length, checks: record.checks.slice(0, 10).map(check => ({ name: promptTitle(check.name, 120), command: check.command, ...(check.scope === 'final' ? { scope: 'final' } : {}) })), checkCount: record.checks.length, revision: input.expectedRevision, kind: input.kind } }) }
          catch (failure) {
            // Exact host tags mean declined or cancelled, not a transport/internal failure.
            if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
            if (failure && typeof failure === 'object' && '_tag' in failure && (failure._tag === 'Tool.Error' || failure._tag === 'Permission.DeclinedError')) throw new StoreError('approval_denied')
            throw failure
          }
          if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
        }, () => { if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn') })
        if (pending.get(key)?.token === token) {
          results.set(record.id, { revision: input.expectedRevision, outcome: 'approved', at: new Date().toISOString() })
          if (autoStart && (await getConfig()).autoStart) {
            try { await orchestrator.mutate(record.id, approved.revision, { type: 'start' }) }
            catch (failure) { console.error('Relay approved plan could not auto-start; start manually after reviewing the current record', record.id, failure) }
          }
        }
      } catch (failure) {
        if (pending.get(key)?.token === token && failure instanceof StoreError && (failure.code === 'stale_revision' || failure.code === 'approval_denied' || failure.code === 'approval_withdrawn')) {
          results.set(record.id, { revision: failure.code === 'stale_revision' ? failure.currentRevision ?? input.expectedRevision : input.expectedRevision, outcome: failure.code === 'stale_revision' ? 'stale' : failure.code === 'approval_withdrawn' ? 'withdrawn' : 'rejected', at: new Date().toISOString() })
          if (failure.code === 'stale_revision') console.error('Relay plan changed; approval not recorded', key)
        }
        console.error('Relay approval settlement failed', key, failure)
      } finally {
        if (pending.get(key)?.token === token) pending.delete(key)
        try { await changed(store.get(record.id)) }
        catch (failure) { console.error('Relay settlement notification failed', record.id, failure) }
      }
    }
    void settle().catch(failure => console.error('Relay approval settlement failed', key, failure))
    return waiting
  }
  const tool = await ctx.tool.transform(editor => editor.add({ name: 'relay_report', description: 'Report the active Relay worker result exactly once. Does not approve or sign off.', input: reportSchema,
    execute: async (input, context) => {
      try { await orchestrator.report(context.sessionID, input); return { content: 'Relay report recorded. Checks are self-reported and unverified.' } }
      catch (failure) { if (failure instanceof StoreError) throw new Tool.Error({ message: failure.code }); throw failure }
    },
  }))
  registration = await ctx.rpc.register(RelayRpc, {
    exportReport: async (raw, { error }) => guarded(async () => {
      const input = raw as { recordID: string; write?: boolean }
      const record = await store.get(input.recordID)
      if (record.location.projectID !== ctx.location.project.id || record.location.directory !== ctx.location.directory) throw new StoreError('invalid_op')
      const id = record.id.slice(0, 8)
      if (!/^[0-9a-f-]{8}$/.test(id)) throw new StoreError('invalid_op')
      const name = `relay-${id}.md`
      const markdown = auditMarkdown(record, await store.listRuns(record.id), await store.listEvidence(record.id))
      if (input.write) {
        try {
          await mkdir(join(record.location.directory, '.relay', 'reports'), { recursive: true })
          await writeFile(join(record.location.directory, '.relay', 'reports', name), markdown, 'utf8')
        } catch (error) {
          console.error('Relay report write failed', error)
          const failure = new StoreError('invalid_op')
          failure.message = 'Could not write report file.'
          throw failure
        }
      }
      return { name, markdown, ...(input.write ? { path: `.relay/reports/${name}` } : {}) }
    }, error),
    validateConfig: async () => validateConfig(),
    probeImage: async (raw, { error }) => guarded(async () => {
      if (!config.enableProbe) throw new StoreError('invalid_op')
      const input = raw as { parentSessionID: string }
      await validateSession(input.parentSessionID)
      const report = await validateConfig()
      const reviewer = report.roles.find(role => role.role === 'reviewer')!
      if (!reviewer.model || reviewer.errors.length) throw new StoreError('invalid_op')
      const key = probeKey(reviewer.model)
      const cached = await ctx.storage.get(key) as ProbeResult | undefined
      if (cached) return report
      if (imageProbes.has(key)) throw new StoreError('invalid_op')
      imageProbes.add(key)
      let sessionID = ''
      let result: ProbeResult = { status: 'error', sessionID, answer: '', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, at: new Date().toISOString() }
      try {
        const session = await ctx.session.create({ parentID: input.parentSessionID, title: 'Relay explicit image compatibility probe', model: reviewer.model,
          location: { directory: ctx.location.directory }, permissions: [...['edit', 'write', 'shell', 'subagent', 'question', approveAction, signOffAction, verifyAction, 'relay.configure', ...plannerTools].map(action => ({ action, resource: '*', effect: 'deny' as const })), ...workerApiDenials] })
        sessionID = session.id; result.sessionID = sessionID
        probeSessions.add(sessionID)
        // Fixed red PNG. No user files or environment details leave this probe.
        await ctx.session.prompt({ sessionID, text: 'Identify the solid color in the attached image. Reply with only the color name. Do not use tools.', files: [{ uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', source: { type: 'inline' }, name: 'color.png' }] })
        await ctx.session.wait({ sessionID })
        const messages = await ctx.session.context({ sessionID })
        const answer = messages.filter(message => message.type === 'assistant').flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join(' ').trim()
        if (!answer) throw new Error('No model answer was produced')
        const info = await ctx.session.get({ sessionID })
        result = { status: answer.replace(/\p{P}/gu, '').trim().toLowerCase() === 'red' ? 'verified' : 'failed', sessionID, answer: Array.from(answer).slice(0, 500).join(''), tokens: { input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning, cache: { read: info.tokens.cache.read, write: info.tokens.cache.write } }, at: new Date().toISOString() }
      } catch (failure) {
        console.error('Relay image probe failed', key, failure)
        // Deliberately do not echo exception text: it can contain paths, headers or stacks.
        result = { ...result, status: 'error', answer: sessionID ? 'The host could not complete the image probe. No vision verdict was recorded.' : 'The host could not create the image probe session.' }
      }
      finally { imageProbes.delete(key) }
      if (result.status === 'error') imageErrors.set(key, result)
      else { imageErrors.delete(key); await ctx.storage.set(key, result) }
      return validateConfig()
    }, error),
    getSnapshot: async (raw, { error }) => guarded(async () => snapshot(await store.get((raw as { recordID: string }).recordID)), error),
    listRecords: async (_, { error }) => guarded(async () => (await store.list()).map(snapshot), error),
    createRecord: async (raw, { error }) => guarded(async () => { const input = raw as { title: string; sessionID?: string }; if (input.sessionID) await validateSession(input.sessionID); return changed(store.create(input.title, input.sessionID)) }, error),
    mutate: async (raw, { error }) => guarded(() => mutate(raw as { recordID: string; expectedRevision: number; op: Op }), error),
    listRuns: async (raw, { error }) => guarded(() => store.listRuns((raw as { recordID: string }).recordID), error),
    listEvidence: async (raw, { error }) => guarded(() => store.listEvidence((raw as { id: string }).id), error),
    recordManual: async (raw, { error, signal }) => guarded(async () => {
      const input = raw as { id: string; revision: number; taskID: string; checkID: string; note: string; sessionID?: string }
      const record = await store.get(input.id)
      if (record.sessionID && input.sessionID && record.sessionID !== input.sessionID) throw new StoreError('invalid_op')
      const sessionID = record.sessionID ?? input.sessionID
      if (!sessionID) throw new StoreError('invalid_op')
      await validateSession(sessionID)
      const key = `${input.id}@${input.revision}:${input.taskID}:${input.checkID}`
      if (pending.has(key)) throw new StoreError('approval_pending')
      const token = randomUUID()
      pending.set(key, { token, sessionID, resource: key, action: verifyAction })
      await changed(Promise.resolve(record))
      try {
        return await changed(store.recordManual(input.id, input.revision, input.taskID, input.checkID, input.note, async () => {
          if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
          signal?.throwIfAborted()
          try { await ctx.permission.assert({ sessionID, action: verifyAction, resources: [key], metadata: { checkName: record.checks.find(check => check.id === input.checkID)?.name, taskTitle: record.tasks.find(task => task.id === input.taskID)?.title, note: input.note, revision: input.revision } }) }
          catch (failure) {
            if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
            if (failure && typeof failure === 'object' && '_tag' in failure && (failure._tag === 'Tool.Error' || failure._tag === 'Permission.DeclinedError')) throw new StoreError('approval_denied')
            throw failure
          }
          if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
        }, () => { if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn') }))
      } finally { if (pending.get(key)?.token === token) pending.delete(key); await changed(store.get(record.id)) }
    }, error),
    signOff: async (raw, { error, signal }) => guarded(async () => {
      const input = raw as { recordID: string; expectedRevision: number; sessionID?: string }
      const record = await store.get(input.recordID)
      if (record.sessionID && input.sessionID && record.sessionID !== input.sessionID) throw new StoreError('invalid_op')
      const sessionID = record.sessionID ?? input.sessionID
      if (!sessionID) throw new StoreError('invalid_op')
      await validateSession(sessionID)
      const key = `signoff:${record.id}@${input.expectedRevision}`
      if (pending.has(key)) throw new StoreError('approval_pending')
      const token = randomUUID()
      pending.set(key, { token, sessionID, resource: `${record.id}@${input.expectedRevision}`, action: signOffAction })
      await changed(Promise.resolve(record))
      try {
        return await changed(store.signOff(record.id, input.expectedRevision, async () => {
          if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
          signal?.throwIfAborted()
          try { await ctx.permission.assert({ sessionID, action: signOffAction, resources: [`${record.id}@${input.expectedRevision}`], metadata: { recordID: record.id, title: promptTitle(record.title), taskCount: record.tasks.length, revision: input.expectedRevision } }) }
          catch (failure) {
            if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
            if (failure && typeof failure === 'object' && '_tag' in failure && (failure._tag === 'Tool.Error' || failure._tag === 'Permission.DeclinedError')) throw new StoreError('approval_denied')
            throw failure
          }
          if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn')
        }, () => { if (pending.get(key)?.token !== token) throw new StoreError('approval_withdrawn') }))
      } finally { if (pending.get(key)?.token === token) pending.delete(key); await changed(store.get(record.id)) }
    }, error),
    requestApproval: async (raw, { error }) => guarded(() => requestPlan(raw as { recordID: string; expectedRevision: number; kind: 'plan'; sessionID?: string }), error),
    withdrawApproval: async (raw, { error }) => guarded(async () => {
      const input = raw as { recordID: string; key: string }
      const record = await store.get(input.recordID)
      return withdraw(record, input.key)
    }, error),
    probeWorkerSession: async (raw, { error }) => guarded(async () => {
      const input = raw as { parentSessionID: string; model: { id: string; providerID: string; variant?: string } }
      if (!config.enableProbe) throw new StoreError('invalid_op')
      await validateSession(input.parentSessionID)
      const models = await ctx.model.list({})
      const model = models.data.find(model => model.id === input.model.id && model.providerID === input.model.providerID)
      if (!model || (input.model.variant !== undefined && !model.variants.some(variant => variant.id === input.model.variant))) throw new StoreError('invalid_op')
      if (probes.has(input.parentSessionID)) throw new StoreError('invalid_op')
      probes.add(input.parentSessionID)
      let session
      try {
      session = await ctx.session.create({ parentID: input.parentSessionID, title: 'Relay reviewer compatibility probe', model: input.model,
        location: { directory: ctx.location.directory }, permissions: [
          ...['edit', 'write', 'shell', 'subagent', 'question', approveAction, signOffAction, verifyAction, 'relay.configure', ...plannerTools].map(action => ({ action, resource: '*', effect: 'deny' as const })), ...workerApiDenials,
        ] })
      } catch (failure) { probes.delete(input.parentSessionID); throw failure }
      probeSessions.add(session.id)
      try { return await ctx.session.get({ sessionID: session.id }) }
      catch { throw new Error(`Probe session ${session.id} was created but could not be read. Inspect that session before retrying.`) }
    }, error),
  })
  const command = await registerPlanner(ctx, { store, snapshot, changed, cancel: (record, cancelReason) => mutate({ recordID: record.id, expectedRevision: record.revision, op: { type: 'cancel', cancelReason } }), config: getConfig, configure, restore: restorePlanner, validateSession, cleanTitle: promptTitle, requestPlan, model: config.models.planner, explorer: config.models.explorer, isWorker: sessionID => orchestrator.isWorker(sessionID) || probeSessions.has(sessionID), pending: id => [...pending].some(([key, value]) => value.action === approveAction && key.startsWith(`${id}@`)) })
  try { await orchestrator.reconcile() } catch (failure) { console.error('Relay startup reconciliation failed', failure) }
  try {
    for (const record of await store.list()) if (record.sessionID && ['completed', 'cancelled'].includes(record.phase) && await ctx.storage.get(`relay/lockdown/${record.sessionID}`)) await lockdown(record.sessionID, false)
  } catch (failure) { console.error('Relay lockdown reconciliation failed', failure) }
  return async () => { await registration.dispose(); await hook.dispose(); await tool.dispose(); await command.dispose() }
}
export default Plugin.define({ id: 'opencode-relay-orchestration', setup })
