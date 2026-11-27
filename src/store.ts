import { randomUUID } from 'node:crypto'
import { readLimits } from './config.ts'
import type { Plugin } from '@opencode/plugin'
type Context = Plugin.Context

import { statuses, transitions, isApproved, checkScope, type RecordInfo, type Op, type Phase, type PhaseAction, type RunInfo, type Check, type Evidence } from './model.ts'
import { validateAllowedPaths } from './scope.ts'
export { statuses, phases, transitions, phaseActions, isApproved, type RecordInfo, type Op, type Status, type Phase, type PhaseAction, type Owner } from './model.ts'
export class StoreError extends Error {
  code: 'stale_revision' | 'not_found' | 'approval_denied' | 'approval_withdrawn' | 'approval_required' | 'invalid_op' | 'approval_pending' | 'storage_inconsistent' | 'limit_exceeded' | 'verification_incomplete'
  currentRevision?: number
  constructor(code: StoreError['code'], currentRevision?: number, message?: string) {
    super(message ?? code); this.code = code; this.currentRevision = currentRevision
  }
}
export function migrate(value: unknown): RecordInfo {
  let record = structuredClone(value) as RecordInfo
  if ((record.schemaVersion as number) === 1) {
    const approved = isApproved(record, 'plan')
    const planRevision = approved ? record.approvals.at(-1)!.revision : record.revision
    record = { ...record, schemaVersion: 2 as 3, planRevision, phase: approved ? 'approved' : 'draft', tasks: record.tasks.map(task => ({ ...task, fixCycles: 0 })), approvals: record.approvals.map(approval => ({ ...approval, planRevision: approval.revision })) }
  }
  if ((record.schemaVersion as number) === 2) record = { ...record, schemaVersion: 3, checks: [] }
  return record
}
export function validateCheck(check: Check) {
  if (!check || typeof check !== 'object' || Object.keys(check).some(key => !['id', 'name', 'adapter', 'command', 'policy', 'scope', 'reason', 'screenshotDir', 'timeoutMs'].includes(key))) throw new StoreError('invalid_op')
  for (const [key, max] of [['id', 200], ['name', 120], ['command', 160]] as const) if (typeof check[key] !== 'string' || !check[key].trim() || Array.from(check[key]).length > max) throw new StoreError('invalid_op')
  for (const value of [check.name, check.command, check.reason, check.screenshotDir]) if (typeof value === 'string' && /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u{e0000}-\u{e007f}]/u.test(value)) throw new StoreError('invalid_op')
  if (!['command', 'playwright'].includes(check.adapter) || !['automated-required', 'manual-allowed', 'not-applicable'].includes(check.policy)) throw new StoreError('invalid_op')
  if (check.scope !== undefined && !['task', 'final'].includes(check.scope)) throw new StoreError('invalid_op')
  if (check.reason !== undefined && (typeof check.reason !== 'string' || Array.from(check.reason).length > 500) || check.policy === 'not-applicable' && !check.reason?.trim()) throw new StoreError('invalid_op')
  if (check.screenshotDir !== undefined && (check.adapter !== 'playwright' || typeof check.screenshotDir !== 'string' || !check.screenshotDir.trim() || /^(?:[a-z]:|[\\/])/i.test(check.screenshotDir) || check.screenshotDir.split(/[\\/]/).includes('..'))) throw new StoreError('invalid_op')
  if (check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0 || check.timeoutMs > 1800000)) throw new StoreError('invalid_op')
}

// One writer for every store instance in this module, including different locations.
let queue: Promise<unknown> = Promise.resolve()
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work)
  queue = next.catch(() => {})
  return next
}

export function createStore(storage: Context['storage'], location: RecordInfo['location'], limits: { maxRunningTasks?: unknown; maxFixCycles?: unknown } = {}) {
  let { maxRunningTasks, maxFixCycles } = readLimits(limits)
  const prefix = `relay/records/${encodeURIComponent(location.projectID)}/`
  const runPrefix = `relay/runs/${encodeURIComponent(location.projectID)}/`
  const evidencePrefix = `relay/evidence/${encodeURIComponent(location.projectID)}/`
  async function listEvidence(id: string): Promise<Evidence[]> {
    await get(id)
    const evidence: Evidence[] = []; let after: string | undefined
    do {
      const page = await storage.scan({ prefix: `${evidencePrefix}${id}/`, after, limit: 100 })
      evidence.push(...page.entries.map(entry => entry.value as Evidence)); after = page.next
    } while (after)
    const order = { unverified: 0, failed: 1, passed: 2, 'manually verified': 3 }
    return evidence.sort((a, b) => a.endedAt - b.endedAt || a.startedAt - b.startedAt || order[a.result] - order[b.result] || a.id.localeCompare(b.id))
  }
  async function saveEvidence(input: Omit<Evidence, 'id'>) {
    const evidence = { ...input, id: randomUUID() }
    await storage.set(`${evidencePrefix}${input.recordID}/${evidence.id}`, evidence)
    return evidence
  }
  async function verification(record: RecordInfo) {
    const checks = record.checks.filter(check => check.policy !== 'not-applicable')
    if (!checks.length) return
    const taskChecks = checks.filter(check => checkScope(check) === 'task')
    const finalChecks = checks.filter(check => checkScope(check) === 'final')
    const runs = await listRuns(record.id); const evidence = await listEvidence(record.id)
    const valid = (item: Evidence | undefined, check: Check) => Boolean(item && (item.result === 'passed' || item.result === 'manually verified' && check.policy === 'manual-allowed'))
    const entries = record.tasks.map(task => {
      const build = runs.findLast(run => run.taskID === task.id && run.stage === 'build' && run.status === 'reported')
      const review = runs.findLast(run => run.taskID === task.id && run.stage === 'review' && run.status === 'reported' && run.report && 'verdict' in run.report && run.report.verdict === 'approve')
      return { task, build, review }
    })
    let finalSatisfied = !finalChecks.length
    for (const { task, build, review } of entries) {
      if (!build || !review || review.startedAt < build.startedAt || !review.evidenceIDs) throw new StoreError('verification_incomplete')
      const taskCurrent = taskChecks.map(check => evidence.findLast(item => item.taskID === task.id && item.checkID === check.id && item.buildRunID === build.id))
      if (taskCurrent.some((item, index) => !valid(item, taskChecks[index])) || taskCurrent.some(item => !review.evidenceIDs!.includes(item!.id))) throw new StoreError('verification_incomplete')
      const finalCurrent = finalChecks.map(check => evidence.findLast(item => item.taskID === task.id && item.checkID === check.id && item.buildRunID === build.id))
      const hasFinalEvidence = finalChecks.length > 0 && finalCurrent.every((item, index) => valid(item, finalChecks[index])) && finalCurrent.every(item => review.evidenceIDs!.includes(item!.id))
      const expectedLength = hasFinalEvidence ? taskCurrent.length + finalCurrent.length : taskCurrent.length
      if (review.evidenceIDs.length !== expectedLength) throw new StoreError('verification_incomplete')
      if (hasFinalEvidence && entries.every(other => other.build && review.startedAt >= other.build.startedAt && (!other.build.endedAt || review.startedAt >= other.build.endedAt))) finalSatisfied = true
    }
    if (!finalSatisfied) throw new StoreError('verification_incomplete')
  }
  async function listRuns(recordID: string): Promise<RunInfo[]> {
    await get(recordID)
    const runs: RunInfo[] = []; let after: string | undefined
    do {
      const page = await storage.scan({ prefix: `${runPrefix}${recordID}/`, after, limit: 100 })
      runs.push(...page.entries.map(entry => entry.value as RunInfo)); after = page.next
    } while (after)
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attempt - b.attempt || (a.stage === b.stage ? 0 : a.stage === 'build' ? -1 : 1) || a.id.localeCompare(b.id))
  }
  async function get(id: string): Promise<RecordInfo> {
    const value = await storage.get(prefix + id)
    if (!value) throw new StoreError('not_found')
    return migrate(value)
  }
  async function persist(record: RecordInfo) {
    await storage.set(prefix + record.id, JSON.parse(JSON.stringify(record)))
    const saved = await get(record.id)
    if (saved.revision !== record.revision) throw new StoreError('storage_inconsistent')
    return saved
  }
  function write(id: string, revision: number, apply: (record: RecordInfo) => void | Promise<void>, planRevision?: number) {
    return serialize(async () => {
      const record = await get(id)
      if (planRevision === undefined ? record.revision !== revision : record.planRevision !== planRevision) throw new StoreError('stale_revision', record.revision)
      await apply(record)
      record.revision++
      record.updatedAt = new Date().toISOString()
      return persist(record)
    })
  }
  async function list() {
    const records: RecordInfo[] = []
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix, after, limit: 100 })
      records.push(...page.entries.map(entry => migrate(entry.value)))
      after = page.next
    } while (after)
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  return {
    limits(values: { maxRunningTasks: number; maxFixCycles: number }) { maxRunningTasks = values.maxRunningTasks; maxFixCycles = values.maxFixCycles },
    get,
    write,
    updatePlanner(id: string, apply: (planner: NonNullable<RecordInfo['plannerSession']>) => void) {
      return serialize(async () => {
        const record = await get(id)
        if (!record.plannerSession) return record
        apply(record.plannerSession)
        return persist(record)
      })
    },
    listRuns,
    listEvidence,
    createEvidence(input: Omit<Evidence, 'id'>) {
      return serialize(async () => { await get(input.recordID); return saveEvidence(input) })
    },
    async recordManual(id: string, revision: number, taskID: string, checkID: string, note: string, permission: () => Promise<void>, guard?: () => void) {
      function eligible(record: RecordInfo) {
        const check = record.checks.find(check => check.id === checkID)
        const task = record.tasks.find(task => task.id === taskID)
        if (!check || check.policy !== 'manual-allowed' || record.phase !== 'interrupted' || record.interruptReason !== `manual verification required: ${check.name}` || task?.status !== 'running' || task.owner?.role !== 'reviewer' || typeof note !== 'string' || !note.trim() || Array.from(note).length > 1000) throw new StoreError('invalid_op')
      }
      const before = await get(id)
      if (before.revision !== revision) throw new StoreError('stale_revision', before.revision)
      eligible(before)
      const runs = await listRuns(id)
      const build = runs.findLast(run => run.taskID === taskID && run.stage === 'build' && run.status === 'reported')
      const latest = (await listEvidence(id)).findLast(item => item.taskID === taskID && item.checkID === checkID && item.buildRunID === build?.id)
      if (!build || latest?.result !== 'unverified') throw new StoreError('invalid_op')
      await permission()
      return serialize(async () => {
        const record = await get(id)
        if (record.revision !== revision) throw new StoreError('stale_revision', record.revision)
        eligible(record)
        const currentBuild = (await listRuns(id)).findLast(run => run.taskID === taskID && run.stage === 'build' && run.status === 'reported')
        if (currentBuild?.id !== build.id) throw new StoreError('verification_incomplete')
        guard?.()
        const now = Date.now()
        await saveEvidence({ recordID: id, taskID, checkID, buildRunID: build.id, result: 'manually verified', source: 'permission-assert', note: note.trim(), screenshots: [], startedAt: now, endedAt: now, durationMs: 0 })
        record.revision++; record.updatedAt = new Date().toISOString()
        return persist(record)
      })
    },
    createRun(input: Omit<RunInfo, 'id'>) {
      return serialize(async () => {
        await get(input.recordID)
        const run = { ...input, id: randomUUID() }
        await storage.set(`${runPrefix}${run.recordID}/${run.id}`, run)
        return run
      })
    },
    updateRun(recordID: string, runID: string, apply: (run: RunInfo) => void) {
      return serialize(async () => {
        const key = `${runPrefix}${recordID}/${runID}`
        const run = await storage.get(key) as RunInfo | undefined
        if (!run) throw new StoreError('not_found')
        apply(run)
        await storage.set(key, JSON.parse(JSON.stringify(run)))
        return run
      })
    },
    create(title: string, sessionID?: string, plannerSession?: RecordInfo['plannerSession']) {
      return serialize(async () => {
        title = title.trim()
        if (!title) throw new StoreError('invalid_op')
        if (Array.from(title).length > 500) throw new StoreError('limit_exceeded')
        const now = new Date().toISOString()
        return persist({ schemaVersion: 3, id: randomUUID(), revision: 1, planRevision: 1, phase: 'draft', title: title.trim(), location,
          ...(sessionID ? { sessionID } : {}), ...(plannerSession ? { plannerSession } : {}), createdAt: now, updatedAt: now, tasks: [], checks: [], approvals: [] })
      })
    },
    list,
    async reconcile() {
      const changed: RecordInfo[] = []
      for (const record of await list()) {
        if (record.phase !== 'running') continue
        try { changed.push(await write(record.id, record.revision, current => { current.phase = 'interrupted'; current.interruptReason = 'server_restart' })) }
        catch (failure) { if (!(failure instanceof StoreError) || failure.code !== 'stale_revision') console.error('Relay record reconciliation failed', record.id, failure) }
      }
      return changed
    },
    mutate(id: string, revision: number, op: Op) {
      return write(id, revision, record => {
        if (record.phase === 'completed' || record.phase === 'cancelled') throw new StoreError('invalid_op')
        if (op.type === 'addCheck' || op.type === 'removeCheck') {
          if (record.phase !== 'draft') throw new StoreError('invalid_op')
          if (op.type === 'addCheck') {
            validateCheck(op.check)
            if (record.checks.some(check => check.id === op.check.id || check.name.trim() === op.check.name.trim())) throw new StoreError('invalid_op')
            if (record.checks.length >= 20) throw new StoreError('limit_exceeded')
            record.checks.push(structuredClone(op.check))
          } else {
            const index = record.checks.findIndex(check => check.id === op.checkID)
            if (index < 0) throw new StoreError('invalid_op')
            record.checks.splice(index, 1)
          }
          record.planRevision++
        } else if (op.type === 'addTask' && typeof op.title === 'string' && op.title.trim()) {
          if (!['draft', 'approved', 'interrupted'].includes(record.phase)) throw new StoreError('invalid_op')
          if (Array.from(op.title.trim()).length > 2000 || record.tasks.length >= 200) throw new StoreError('limit_exceeded')
          const scoped = validateAllowedPaths(op.allowedPaths)
          if (!scoped.ok) throw new StoreError(scoped.code, undefined, scoped.message)
          record.tasks.push({ id: randomUUID(), title: op.title.trim(), status: 'pending', fixCycles: 0, ...(scoped.paths ? { allowedPaths: scoped.paths } : {}), updatedAt: new Date().toISOString() })
          record.planRevision++; record.phase = 'draft'; delete record.interruptReason
        } else if (op.type === 'setTaskStatus' && statuses.includes(op.status)) {
          if (['running'].includes(record.phase)) throw new StoreError('invalid_op')
          const task = record.tasks.find(task => task.id === op.taskID)
          if (!task) throw new StoreError('invalid_op')
          if (op.status === 'running') {
            if (record.phase !== 'running' || !task.owner || task.status === 'running') throw new StoreError('invalid_op')
            if (record.tasks.filter(task => task.status === 'running').length >= maxRunningTasks) throw new StoreError('limit_exceeded')
          }
          if (task.status === 'running' && op.status === 'pending') {
            if (task.fixCycles >= maxFixCycles) throw new StoreError('limit_exceeded')
            task.fixCycles++
          }
          task.status = op.status; task.updatedAt = new Date().toISOString()
        } else if (op.type === 'assignTask') {
          if (record.phase === 'running') throw new StoreError('invalid_op')
          const task = record.tasks.find(task => task.id === op.taskID)
          if (!task || task.status === 'running' || !op.owner || !['planner', 'builder', 'reviewer'].includes(op.owner.role) || (op.owner.sessionID !== undefined && (typeof op.owner.sessionID !== 'string' || !op.owner.sessionID.trim()))) throw new StoreError('invalid_op')
          if (op.owner.sessionID !== undefined && Array.from(op.owner.sessionID.trim()).length > 200) throw new StoreError('limit_exceeded')
          task.owner = { role: op.owner.role, ...(op.owner.sessionID ? { sessionID: op.owner.sessionID.trim() } : {}) }; task.updatedAt = new Date().toISOString()
        } else if (Object.hasOwn(transitions, op.type)) {
          const action = op.type as PhaseAction
          if (!(transitions[action] as readonly Phase[]).includes(record.phase)) throw new StoreError('invalid_op')
          if ((action === 'start' || action === 'resume') && !isApproved(record, 'plan')) throw new StoreError('approval_required')
          if (action === 'complete' && (!record.tasks.length || !record.tasks.every(task => task.status === 'completed'))) throw new StoreError('invalid_op')
          if (['complete'].includes(action)) throw new StoreError('approval_required')
          if (op.type === 'cancel' && op.cancelReason !== undefined) {
            if (record.phase !== 'draft' || !op.cancelReason.trim()) throw new StoreError('invalid_op')
            if (Array.from(op.cancelReason.trim()).length > 500) throw new StoreError('limit_exceeded')
            record.cancelReason = op.cancelReason.trim()
          }
          if (op.type === 'interrupt') {
            if (typeof op.reason !== 'string' || !op.reason.trim()) throw new StoreError('invalid_op')
            if (Array.from(op.reason.trim()).length > 500) throw new StoreError('limit_exceeded')
            record.interruptReason = op.reason.trim()
          } else delete record.interruptReason
          record.phase = action === 'start' || action === 'resume' ? 'running' : action === 'interrupt' ? 'interrupted' : action === 'complete' ? 'completed' : 'cancelled'
        } else throw new StoreError('invalid_op')
      })
    },
    async signOff(id: string, revision: number, permission: () => Promise<void>, guard?: () => void) {
      const before = await get(id)
      if (before.revision !== revision) throw new StoreError('stale_revision', before.revision)
      if (before.phase !== 'running' || !before.tasks.length || !before.tasks.every(task => task.status === 'completed')) throw new StoreError('invalid_op')
      await verification(before)
      await permission()
      return write(id, revision, async record => {
        if (record.phase !== 'running' || !record.tasks.length || !record.tasks.every(task => task.status === 'completed')) throw new StoreError('invalid_op')
        await verification(record)
        guard?.()
        record.phase = 'completed'
      })
    },
    async approve(id: string, revision: number, permission: () => Promise<void>, guard?: () => void) {
      const before = await get(id)
      if (before.phase !== 'draft') throw new StoreError('invalid_op')
      if (before.revision !== revision) throw new StoreError('stale_revision', before.revision)
      await permission()
      return write(id, revision, record => {
        if (record.phase !== 'draft') throw new StoreError('invalid_op')
        guard?.()
        record.approvals.push({ kind: 'plan', revision, planRevision: record.planRevision, approvedAt: new Date().toISOString(), source: 'permission-assert' })
        if (record.phase === 'draft') record.phase = 'approved'
      }, before.planRevision)
    },
  }
}
