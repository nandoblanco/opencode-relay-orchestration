import type { RecordInfo, RunInfo, Check, Evidence } from './model.ts'
import { statuses, phaseActions, checkScope, isFinalTask } from './model.ts'
export function approvalMessage(record?: RecordInfo) {
  const result = record?.approvalResult
  if (!result) return ''
  if (record?.pendingApproval?.revision === record?.revision) return ''
  if ((record!.schemaVersion as number) >= 2 && result.outcome === 'approved') {
    if (record!.phase !== 'approved') return ''
    if (!record!.approvals.some(approval => approval.revision === result.revision && approval.planRevision === record!.planRevision)) return ''
  } else if (record!.revision !== result.revision + (result.outcome === 'approved' ? 1 : 0)) return ''
  return result.outcome === 'approved' ? `Plan approved for revision ${result.revision}` : result.outcome === 'withdrawn' ? 'Approval request withdrawn' : result.outcome === 'rejected' ? 'Approval rejected' : 'Plan changed; approval not recorded'
}
export function pendingMessage(record?: RecordInfo) {
  return record?.pendingApproval ? `Waiting for approval of revision ${record.pendingApproval.revision}` : ''
}
export function failureMessage(failure: unknown) {
  const messages: Record<string, string> = { stale_revision: 'This record changed. Review the refreshed snapshot and retry.', approval_pending: 'An approval request is already waiting in the session prompt.', approval_denied: 'The approval request was denied.', invalid_op: 'This action is not available for the selected record or session.', not_found: 'This record could not be found. Refresh to choose another.', storage_inconsistent: 'Storage verification failed. Stop making changes and check the server.' }
  // SDK Rpc.Failure is a plain object, not necessarily an Error instance.
  const rpc = failure as { type: string; message: string; data?: { currentRevision: number } }
  const code = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : rpc?.type
  const detail = failure instanceof Error ? failure.message : rpc?.message
  if (rpc?.type === 'invalid_op' && typeof detail === 'string' && /^Check "[^\r\n]*" contains unsupported characters or settings; remove and re-add it\.$/.test(detail)) return detail
  if (rpc?.type === 'invalid_op' && detail === 'Could not write report file.') return detail
  if (code === 'approval_required') return 'Approve the current plan before starting or resuming work.'
  if (code === 'approval_withdrawn') return 'Approval request withdrawn'
  if (code === 'verification_incomplete') return 'Verification is incomplete. Run the current checks and independent review before sign-off.'
  if (code === 'limit_exceeded') return 'A record limit was exceeded. Check title, task text, owner session and interrupt reason lengths, task count, running tasks and fix cycles.'
  if (Object.hasOwn(messages, code)) return messages[code]
  return 'This action could not be completed. Refresh and try again.'
}
export function formatTimestamp(value: string) { return new Date(value).toLocaleString() }
export function visibleError(failure: unknown, record?: RecordInfo, requestApproval = false) {
  const code = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : (failure as { type?: string })?.type
  const matching = code === 'stale_revision' && record?.approvalResult?.outcome === 'stale' || code === 'approval_denied' && record?.approvalResult?.outcome === 'rejected' || code === 'approval_withdrawn' && record?.approvalResult?.outcome === 'withdrawn'
  return requestApproval && matching && approvalMessage(record) ? '' : failureMessage(failure)
}
export function signOffMessage(revision: number) { return `Waiting for sign-off of revision ${revision}` }
export function signOffError(failure: unknown) {
  const code = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : (failure as { type?: string })?.type
  return code === 'approval_denied' ? 'Sign-off was denied. The record is still running.' : failureMessage(failure)
}
export function tokenTotals(runs: RunInfo[]) {
  const total = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  for (const run of runs) if (run.tokens) {
    total.input += run.tokens.input; total.output += run.tokens.output; total.reasoning += run.tokens.reasoning
    total.cache.read += run.tokens.cache.read; total.cache.write += run.tokens.cache.write
  }
  return total
}
export function tokensMessage(runs: RunInfo[]) {
  const total = tokenTotals(runs)
  return `Tokens: input ${total.input}, output ${total.output}, reasoning ${total.reasoning}, cache read ${total.cache.read}, cache write ${total.cache.write}`
}
export function plannerTokensMessage(record?: RecordInfo) {
  const tracking = record?.plannerSession
  if (!tracking) return ''
  const end = tracking.tokensAtEnd; const start = tracking.tokensAtStart
  if (!end) return `Planner session tokens: ${record && ['completed', 'cancelled'].includes(record.phase) ? 'unavailable' : 'tracking'}`
  if (end.input < start.input || end.output < start.output || end.reasoning < start.reasoning || end.cache.read < start.cache.read || end.cache.write < start.cache.write) return 'Planner session tokens: unavailable (session total decreased)'
  return `Planner session tokens: input +${end.input - start.input}, output +${end.output - start.output}, reasoning +${end.reasoning - start.reasoning}, cache read +${end.cache.read - start.cache.read}`
}
export function interruptionMessage(reason?: string) {
  if (!reason) return ''
  if (reason === 'server_restart') return 'Interrupted: server restarted. Resume explicitly to continue.'
  if (reason === 'escalated: screenshot inspection incomplete') return 'Screenshot inspection incomplete. The reviewer must inspect and list every attached screenshot by its exact name. Resolve the blocked task, then resume.'
  if (reason === 'escalated: screenshot review unavailable') return 'Screenshot review unavailable. Configure a reviewer model with image input and validate it or run the image probe, then resolve the blocked task and resume.'
  if (reason === 'escalated: screenshot changed after check') return 'Screenshot changed after check. Restore the verification output, resolve the blocked task and resume to recheck the screenshot before review.'
  if (reason.startsWith('verification unavailable: ')) return `Verification unavailable: ${reason.slice(26)}. Configure the environment, then resume.`
  if (reason.startsWith('manual verification required: ')) return `Manual verification required: ${reason.slice(30)}. Record your verification, then resume.`
  return reason.startsWith('escalated:') ? `Needs your attention: ${reason.slice(10).trim()}. Resolve the blocked task, then resume.` : `Interrupted: ${reason}`
}
export function evidenceTitle(title: string, limit = 40) {
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  const points = Array.from(clean)
  return points.length > limit ? points.slice(0, limit - 1).join('').replace(/[.\s]+$/, '') + '…' : clean
}
export function checkView(check: Check) {
  return { ...check, label: check.policy === 'not-applicable' ? `Not applicable: ${check.reason}` : `${check.name} (${check.policy}${checkScope(check) === 'final' ? ', final gate' : ''})` }
}
export function canRecordManual(record: RecordInfo, taskID: string, check: Check, evidence: Evidence[], runs: RunInfo[]) {
  const task = record.tasks.find(task => task.id === taskID)
  const build = runs.findLast(run => run.taskID === taskID && run.stage === 'build' && run.status === 'reported')
  const latest = evidence.findLast(item => item.taskID === taskID && item.checkID === check.id && item.buildRunID === build?.id)
  return check.policy === 'manual-allowed' && record.phase === 'interrupted' && record.interruptReason === `manual verification required: ${check.name}` && task?.status === 'running' && task.owner?.role === 'reviewer' && latest?.result === 'unverified'
}
export function evidenceView(check: Check, evidence: Evidence | undefined, runs: RunInfo[], deferred = false) {
  const build = evidence && runs.findLast(run => run.taskID === evidence.taskID && run.stage === 'build' && run.status === 'reported')
  const stale = Boolean(evidence && evidence.buildRunID !== build?.id)
  const label = check.policy === 'not-applicable' ? `Not applicable: ${check.reason}` : !evidence ? (deferred ? 'Deferred to final gate' : 'Unverified: no evidence') : evidence.result === 'passed' ? 'Passed (plugin-run)' : evidence.result === 'failed' ? 'Failed (plugin-run)' : evidence.result === 'manually verified' ? `Manually verified by user: ${evidence.note}` : `Unverified: ${evidence.reason}`
  return { label: label + (stale ? ' (stale)' : ''), stale, screenshots: evidence?.screenshots.length ? `${evidence.screenshots.length} screenshot(s)` : '', manual: evidence?.result === 'manually verified' }
}
export function taskView(task: RecordInfo['tasks'][number], runs: RunInfo[]) {
  const latest = runs.findLast(run => run.taskID === task.id)
  const report = runs.findLast(run => run.taskID === task.id && run.report)?.report
  const review = runs.findLast(run => run.taskID === task.id && run.report && 'findings' in run.report)?.report
  const build = runs.findLast(run => run.taskID === task.id && run.report && 'checks' in run.report)?.report
  const findings = review && 'findings' in review ? review.findings : []
  const failed = build && 'checks' in build ? build.checks.filter(check => check.result === 'failed').length : 0
  const stage = task.status === 'completed' ? 'Done' : task.status === 'blocked' ? 'Blocked' : task.status === 'running' ? task.owner?.role === 'reviewer' ? 'Reviewing' : 'Building' : task.status === 'pending' ? 'Pending' : 'Awaiting approval'
  return { id: task.id, title: task.title, status: task.status, label: task.status.replaceAll('_', ' '), owner: task.owner, fixCycles: task.fixCycles,
    scope: task.allowedPaths?.length ? `Scope: ${task.allowedPaths.join(', ')}` : '',
    stage, attempt: latest?.attempt, summary: report?.summary ?? '', findings: review ? `${findings.length} finding${findings.length === 1 ? '' : 's'} (${findings.filter(item => item.severity === 'major').length} major)` : '',
    checks: build && 'checks' in build ? failed ? `Builder self-checks: ${build.checks.length - failed} passed, ${failed} failed (self-reported, unverified)` : `${build.checks.length} builder check${build.checks.length === 1 ? '' : 's'} (self-reported, unverified)` : '' }
}
export function recordView(record?: RecordInfo, runs: RunInfo[] = []) {
  return record ? {
    title: record.title, revision: `Revision ${record.revision}`, location: record.location.directory,
    phase: `Phase: ${record.phase}`, reason: record.phase === 'cancelled' && record.cancelReason ? `Cancelled: ${record.cancelReason}` : record.phase === 'approved' ? 'Plan approved. Choose Start in the panel or TUI to begin work.' : interruptionMessage(record.interruptReason), actions: phaseActions(record), canAdd: ['draft', 'approved', 'interrupted'].includes(record.phase), canEdit: !['running', 'completed', 'cancelled'].includes(record.phase), canApprove: record.phase === 'draft',
    canSignOff: record.phase === 'running' && record.tasks.length > 0 && record.tasks.every(task => task.status === 'completed'), tokens: tokensMessage(runs), plannerTokens: plannerTokensMessage(record),
    tasks: record.tasks.map(task => taskView(task, runs)),
    approvals: [...(record.approvals.length > 3 ? [`(${record.approvals.length - 3} earlier)`] : []), ...record.approvals.slice(-3).map(approval => `Plan approved for revision ${approval.revision} at ${formatTimestamp(approval.approvedAt)} (permission assert)`)],
  } : { title: 'No relay record', revision: '', location: '', phase: '', reason: '', actions: [], canAdd: false, canEdit: false, canApprove: false, canSignOff: false, tokens: '', plannerTokens: '', tasks: [], approvals: [] }
}
export function renderStatus(record?: RecordInfo, runs: RunInfo[] = [], evidence: Evidence[] = []) {
  const view = recordView(record, runs)
  const counts = statuses.map(status => { const count = view.tasks.filter(task => task.status === status).length; return count ? `${count} ${status.replaceAll('_', ' ')}` : '' }).filter(Boolean).join(', ')
  const tasks = ['Tasks', counts || 'No tasks yet', ...view.tasks.slice(0, 12).map(task => {
    const summary = Array.from(task.summary.replace(/\s+/g, ' ').trim())
    const shown = summary.length > 157 ? summary.slice(0, 157).join('').replace(/[.\s]+$/, '') + '...' : summary.join('')
    return `${task.label}: ${task.title}\n  ${task.stage}${task.attempt ? `, attempt ${task.attempt}` : ''}${task.owner ? `, owner ${task.owner.role}` : ''}${task.scope ? `\n  ${task.scope}` : ''}${shown ? `\n  ${shown}` : ''}${task.findings ? `\n  ${task.findings}` : ''}${task.checks ? `\n  ${task.checks}` : ''}`
  }), ...(view.tasks.length > 12 ? [`(+${view.tasks.length - 12} more tasks)`] : [])].join('\n')
  const verification = record?.checks.length ? ['Verification', ...record.checks.slice(0, 12).flatMap(check => [checkView(check).label, `  Command: ${check.command}`, ...(check.policy === 'not-applicable' ? [] : record.tasks.slice(0, 12).map(task => { const latest = evidence.findLast(item => item.taskID === task.id && item.checkID === check.id); const item = evidenceView(check, latest, runs, checkScope(check) === 'final' && !isFinalTask(record, task.id)); return `  ${evidenceTitle(task.title)}: ${item.label}${item.screenshots ? `; ${item.screenshots}` : ''}` }))]), ...(record.checks.length > 12 ? [`(+${record.checks.length - 12} more checks)`] : [])].join('\n') : ''
  return [[view.title, view.revision, view.location, view.phase, view.reason, view.tokens, view.plannerTokens].filter(Boolean).join('\n'), tasks, ...(verification ? [verification] : []), ...(view.approvals.length ? [['Approvals', ...view.approvals].join('\n')] : []), ...(view.actions.length ? [`Actions:\n${view.actions.map(action => `relay-${action === 'complete' ? 'signoff' : action}`).join('\n')}`] : [])].join('\n\n')
}
