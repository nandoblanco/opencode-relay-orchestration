export const statuses = ['pending', 'running', 'blocked', 'awaiting_approval', 'completed'] as const
export type Status = typeof statuses[number]
export const phases = ['draft', 'approved', 'running', 'interrupted', 'completed', 'cancelled'] as const
export type Phase = typeof phases[number]
export type Owner = { role: 'planner' | 'builder' | 'reviewer'; sessionID?: string }
export type BuildReport = { outcome: 'done' | 'blocked'; summary: string; checks: { command: string; result: 'passed' | 'failed' }[] }
export type Check = { id: string; name: string; adapter: 'command' | 'playwright'; command: string; policy: 'automated-required' | 'manual-allowed' | 'not-applicable'; scope?: 'task' | 'final'; reason?: string; screenshotDir?: string; timeoutMs?: number }
export function checkScope(check: Check): 'task' | 'final' { return check.scope ?? 'task' }
export function isFinalTask(record: RecordInfo, taskID: string) {
  return record.tasks.length > 0 && record.tasks.every(task => task.id === taskID || task.status === 'completed')
}
export function applicableChecks(record: RecordInfo, taskID: string) {
  const final = isFinalTask(record, taskID)
  return record.checks.filter(check => check.policy !== 'not-applicable' && (checkScope(check) === 'task' || final))
}
export type Evidence = {
  id: string; recordID: string; taskID: string; checkID: string; buildRunID: string
  result: 'passed' | 'failed' | 'unverified' | 'manually verified'; source: 'adapter' | 'permission-assert'
  reason?: string; note?: string; exitCode?: number; output?: string
  screenshots: { path: string; sha256: string; bytes: number }[]; startedAt: number; endedAt: number; durationMs: number
}
export type ReviewReport = { verdict: 'approve' | 'changes'; summary: string; findings: { severity: 'major' | 'minor'; text: string }[]; inspected?: string[] }
export type RunInfo = {
  id: string; recordID: string; taskID: string; stage: 'build' | 'review'; role: 'builder' | 'reviewer'
  model: { providerID: string; id: string; variant?: string }; sessionID: string; attempt: number
  status: 'active' | 'reported' | 'failed' | 'interrupted' | 'cancelled'; report?: BuildReport | ReviewReport
  startedAt: string; endedAt?: string; durationMs?: number
  evidenceIDs?: string[]
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}
export const transitions = { start: ['draft', 'approved'], interrupt: ['running'], resume: ['interrupted'], complete: ['running'], cancel: ['draft', 'approved', 'running', 'interrupted'] } satisfies Record<string, Phase[]>
export type PhaseAction = keyof typeof transitions
export function phaseActions(record: RecordInfo) {
  return (Object.keys(transitions) as PhaseAction[]).filter(action => (transitions[action] as readonly Phase[]).includes(record.phase) && (!['start', 'resume'].includes(action) || isApproved(record, 'plan')) && (action !== 'complete' || record.tasks.length > 0 && record.tasks.every(task => task.status === 'completed')))
}
export type RecordInfo = {
  cancelReason?: string
  plannerSession?: { previousModel?: { providerID: string; id: string; variant?: string }; model?: { providerID: string; id: string; variant?: string }; tokensAtStart: NonNullable<RunInfo['tokens']>; tokensAtEnd?: NonNullable<RunInfo['tokens']>; restoredAt?: string }
  schemaVersion: 3; id: string; revision: number; planRevision: number; phase: Phase; interruptReason?: string; title: string
  location: { directory: string; projectID: string }; sessionID?: string
  createdAt: string; updatedAt: string
  pendingApproval?: { key: string; revision: number }
  approvalResult?: { revision: number; outcome: 'approved' | 'rejected' | 'stale' | 'withdrawn'; at: string }
  tasks: { id: string; title: string; status: Status; owner?: Owner; fixCycles: number; allowedPaths?: string[]; updatedAt: string }[]
  checks: Check[]
  approvals: { kind: 'plan'; revision: number; planRevision: number; approvedAt: string; source: 'permission-assert' }[]
}
export type Op = { type: 'addCheck'; check: Check } | { type: 'removeCheck'; checkID: string } | { type: 'addTask'; title: string; allowedPaths?: string[] } | { type: 'setTaskStatus'; taskID: string; status: Status } | { type: 'assignTask'; taskID: string; owner: Owner } | { type: 'start' | 'resume' | 'complete' } | { type: 'cancel'; cancelReason?: string } | { type: 'interrupt'; reason: string }
export function isApproved(record: RecordInfo, kind: 'plan') {
  if ((record.schemaVersion as number) >= 2) return record.approvals.findLast(approval => approval.kind === kind)?.planRevision === record.planRevision
  let revision = record.revision
  for (const approval of [...record.approvals].reverse()) {
    if (approval.revision + 1 !== revision) return false
    if (approval.kind === kind) return true
    revision = approval.revision
  }
  return false
}
