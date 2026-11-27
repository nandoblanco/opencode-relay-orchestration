import type { RecordInfo, RunInfo, Evidence } from './model.ts'
import { tokensMessage, plannerTokensMessage, evidenceTitle } from './view.ts'

function text(value: string) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u{e0000}-\u{e007f}]/gu, ' ').replace(/https?:\/\/[^\s|`"'<>]+|(?<![\w.~-])(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?!(?<=<\/)[A-Za-z][\w:-]*\s*>))[^\s|`"'<>\]\)]+/gi, match => /^https?:\/\//i.test(match) ? match : '[path]').replace(/([\\*_\[\]#])/g, '\\$1').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;')
}
export function auditSummary(record: RecordInfo, runs: RunInfo[]) {
  const review = runs.findLast(run => run.report && 'verdict' in run.report)?.report
  return `${record.title}: ${record.phase}; ${runs.length} run${runs.length === 1 ? '' : 's'}; ${tokensMessage(runs)}; review ${review && 'verdict' in review ? review.verdict : 'none'}`
}
export function auditMarkdown(record: RecordInfo, runs: RunInfo[], evidence: Evidence[]) {
  const directory = record.location.directory.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u{e0000}-\u{e007f}]/gu, '').replace(/([\\*_\[\]#])/g, '\\$1').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;')
  const lines = [`# ${text(record.title)}`, '', `- Phase: ${record.phase}`, `- Revision: ${record.revision}; plan revision: ${record.planRevision}`, `- Location: ${directory}`, ...(record.cancelReason ? [`- Cancelled: ${text(record.cancelReason)}`] : []), '', '## Approvals', ...record.approvals.map(item => `- ${item.kind}; revision ${item.revision}; ${item.source}; ${text(item.approvedAt)}`), '', '## Tasks']
  for (const task of record.tasks) lines.push(`- ${text(task.title)}; ${task.status}; owner ${text(task.owner?.role ?? 'unassigned')}; fix cycles ${task.fixCycles}${task.allowedPaths?.length ? `; scope: ${task.allowedPaths.map(item => text(item)).join(', ')}` : ''}`)
  lines.push('', '## Checks')
  for (const check of record.checks) lines.push(`- ${text(check.name)}; ${check.adapter}; ${check.policy}${check.scope === 'final' ? '; final gate' : ''}; command: ${text(check.command)}`)
  lines.push('', '## Runs', '| Stage | Role | Model | Attempt | Status | Duration ms | Tokens |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const run of runs) lines.push(`| ${run.stage} | ${run.role} | ${text(`${run.model.providerID}/${run.model.id}${run.model.variant ? `/${run.model.variant}` : ''}`)} | ${run.attempt} | ${run.status} | ${run.durationMs ?? 'unavailable'} | ${run.tokens ? tokensMessage([run]) : 'unavailable'} |`)
  lines.push('', '## Evidence')
  for (const item of evidence) {
    const check = record.checks.find(check => check.id === item.checkID)
    const task = record.tasks.find(task => task.id === item.taskID)
    lines.push(`- ${text(task ? evidenceTitle(task.title, 72) : 'Task')}: ${text(check?.name ?? 'Check')}: ${item.result}; ${item.source}${item.reason ? `; ${text(item.reason)}` : ''}${item.note ? `; note: ${text(item.note)}` : ''}${item.exitCode !== undefined ? `; exit code: ${item.exitCode}` : ''}`)
    for (const screenshot of item.screenshots) lines.push(`  - ${text(screenshot.path.split(/[\\/]/).at(-1)!)}; sha256 ${text(screenshot.sha256)}`)
  }
  lines.push('', '## Reviews')
  for (const run of runs) if (run.report && 'verdict' in run.report) {
    const task = record.tasks.find(task => task.id === run.taskID)
    lines.push(`- ${text(task ? evidenceTitle(task.title, 72) : 'Task')}; attempt ${run.attempt}; ${run.report.verdict}: ${text(run.report.summary)}`)
    for (const inspected of run.report.inspected ?? []) lines.push(`  - Inspected: ${text(inspected)}`)
    for (const finding of run.report.findings) lines.push(`  - ${finding.severity}: ${text(finding.text)}`)
  }
  lines.push('', '## Tokens', `- ${tokensMessage(runs)}`, ...(plannerTokensMessage(record) ? [`- ${plannerTokensMessage(record)}`] : []), '')
  return lines.filter(line => line !== undefined).join('\n')
}
