import { Rpc } from '@opencode/plugin/rpc'
import type { RecordInfo, Op, RunInfo, Evidence } from './model.ts'
import type { ConfigReport } from './config.ts'

const string = { type: 'string', minLength: 1 } as const
const integer = { type: 'integer', minimum: 1 } as const
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required, additionalProperties: false })
const owner = object({ role: { enum: ['planner', 'builder', 'reviewer'] }, sessionID: { ...string, maxLength: 200 } }, ['role'])
const check = object({ id: { ...string, maxLength: 200 }, name: { ...string, maxLength: 120 }, adapter: { enum: ['command', 'playwright'] }, command: { ...string, maxLength: 160 }, policy: { enum: ['automated-required', 'manual-allowed', 'not-applicable'] }, scope: { enum: ['task', 'final'] }, reason: { ...string, maxLength: 500 }, screenshotDir: string, timeoutMs: { ...integer, maximum: 1800000 } }, ['id', 'name', 'adapter', 'command', 'policy'])
const storedCheck = { ...check, properties: { ...check.properties, command: { ...string, maxLength: 1000 } } }
const model = object({ providerID: string, id: string, variant: string }, ['providerID', 'id'])
const tokens = object({ input: { type: 'number' }, output: { type: 'number' }, reasoning: { type: 'number' }, cache: object({ read: { type: 'number' }, write: { type: 'number' } }) })
const evidence = object({ id: string, recordID: string, taskID: string, checkID: string, buildRunID: string, result: { enum: ['passed', 'failed', 'unverified', 'manually verified'] }, source: { enum: ['adapter', 'permission-assert'] }, reason: string, note: { ...string, maxLength: 1000 }, exitCode: { type: 'integer' }, output: { type: 'string', maxLength: 4000 }, screenshots: { type: 'array', items: object({ path: string, sha256: string, bytes: { type: 'number', minimum: 0 } }) }, startedAt: { type: 'number' }, endedAt: { type: 'number' }, durationMs: { type: 'number', minimum: 0 } }, ['id', 'recordID', 'taskID', 'checkID', 'buildRunID', 'result', 'source', 'screenshots', 'startedAt', 'endedAt', 'durationMs'])
const record = object({ schemaVersion: { const: 3 }, id: string, revision: integer, planRevision: integer, phase: { enum: ['draft', 'approved', 'running', 'interrupted', 'completed', 'cancelled'] }, interruptReason: { ...string, maxLength: 500 }, title: string,
  location: object({ directory: string, projectID: string }), sessionID: string, createdAt: string, updatedAt: string,
  pendingApproval: object({ key: string, revision: integer }),
  cancelReason: { ...string, maxLength: 500 },
  plannerSession: object({ previousModel: model, model, tokensAtStart: tokens, tokensAtEnd: tokens, restoredAt: string }, ['tokensAtStart']),
  approvalResult: object({ revision: integer, outcome: { enum: ['approved', 'rejected', 'stale', 'withdrawn'] }, at: string }),
  tasks: { type: 'array', items: object({ id: string, title: string, status: { enum: ['pending', 'running', 'blocked', 'awaiting_approval', 'completed'] }, owner, fixCycles: { type: 'integer', minimum: 0 }, allowedPaths: { type: 'array', items: { ...string, maxLength: 200 }, maxItems: 20 }, updatedAt: string }, ['id', 'title', 'status', 'fixCycles', 'updatedAt']) },
  approvals: { type: 'array', items: object({ kind: { const: 'plan' }, revision: integer, planRevision: integer, approvedAt: string, source: { const: 'permission-assert' } }) },
  checks: { type: 'array', items: storedCheck },
}, ['schemaVersion', 'id', 'revision', 'planRevision', 'phase', 'title', 'location', 'createdAt', 'updatedAt', 'tasks', 'approvals', 'checks'])
const errors = { stale_revision: object({ currentRevision: integer }), not_found: object({}), approval_denied: object({}), approval_withdrawn: object({}), approval_required: object({}), invalid_op: object({}), approval_pending: object({}), storage_inconsistent: object({}), limit_exceeded: object({}), verification_incomplete: object({}) }
const probe = object({ status: { enum: ['verified', 'failed', 'error'] }, sessionID: { type: 'string' }, answer: { type: 'string' }, tokens, at: string })
const buildReport = object({ outcome: { enum: ['done', 'blocked'] }, summary: { type: 'string' }, checks: { type: 'array', items: object({ command: { type: 'string' }, result: { enum: ['passed', 'failed'] } }) } })
const reviewReport = object({ verdict: { enum: ['approve', 'changes'] }, summary: { type: 'string' }, findings: { type: 'array', items: object({ severity: { enum: ['major', 'minor'] }, text: { type: 'string' } }) }, inspected: { type: 'array', items: { type: 'string' } } }, ['verdict', 'summary', 'findings'])
const run = object({ id: string, recordID: string, taskID: string, stage: { enum: ['build', 'review'] }, role: { enum: ['builder', 'reviewer'] }, model, sessionID: string, attempt: integer, status: { enum: ['active', 'reported', 'failed', 'interrupted', 'cancelled'] }, report: { oneOf: [buildReport, reviewReport] }, startedAt: string, endedAt: string, durationMs: { type: 'number', minimum: 0 }, tokens, evidenceIDs: { type: 'array', items: string } }, ['id', 'recordID', 'taskID', 'stage', 'role', 'model', 'sessionID', 'attempt', 'status', 'startedAt'])
const report = object({ roles: { type: 'array', items: object({ role: { enum: ['planner', 'builder', 'reviewer', 'explorer'] }, model, exists: { type: 'boolean' }, enabled: { type: 'boolean' }, variant: { type: 'boolean' }, tools: { type: 'boolean' }, image: { enum: ['not configured', 'not required', 'unavailable', 'declared', 'verified', 'failed', 'error'] }, errors: { type: 'array', items: string }, probe }, ['role', 'exists', 'enabled', 'variant', 'tools', 'image', 'errors']) }, errors: { type: 'array', items: string }, limits: object({ maxRunningTasks: integer, maxFixCycles: { type: 'integer', minimum: 0 } }), enableProbe: { type: 'boolean' } })
export const RelayRpc = Rpc.define({
  id: 'opencode-relay-orchestration',
  methods: {
    exportReport: { input: object({ recordID: string, write: { type: 'boolean' } }, ['recordID']), output: object({ name: string, markdown: { type: 'string' }, path: string }, ['name', 'markdown']), errors },
    validateConfig: { input: object({}), output: { ...report, properties: { ...report.properties, widths: { type: 'array', items: integer }, autoStart: { type: 'boolean' }, explorer: { type: 'boolean' }, brainstormFirst: { type: 'boolean' }, source: string, summary: string } }, errors },
    probeImage: { input: object({ parentSessionID: string }), output: report, errors },
    getSnapshot: { input: object({ recordID: string }), output: record, errors },
    createRecord: { input: object({ title: string, sessionID: string }, ['title']), output: record, errors },
    mutate: { input: object({ recordID: string, expectedRevision: integer, op: { oneOf: [object({ type: { const: 'addCheck' }, check }), object({ type: { const: 'removeCheck' }, checkID: string }), object({ type: { const: 'addTask' }, title: string, allowedPaths: { type: 'array', items: { ...string, maxLength: 200 }, maxItems: 20 } }, ['type', 'title']), object({ type: { const: 'setTaskStatus' }, taskID: string, status: { enum: ['pending', 'running', 'blocked', 'awaiting_approval', 'completed'] } }), object({ type: { const: 'assignTask' }, taskID: string, owner }), ...['start', 'resume', 'complete', 'cancel'].map(type => object({ type: { const: type } })), object({ type: { const: 'interrupt' }, reason: { ...string, maxLength: 500 } })] } }), output: record, errors },
    requestApproval: { input: object({ recordID: string, expectedRevision: integer, kind: { const: 'plan' }, sessionID: string }, ['recordID', 'expectedRevision', 'kind']), output: record, errors },
    withdrawApproval: { input: object({ recordID: string, key: string }), output: record, errors },
    listRecords: { input: object({}), output: { type: 'array', items: record }, errors },
    listRuns: { input: object({ recordID: string }), output: { type: 'array', items: run }, errors },
    listEvidence: { input: object({ id: string }), output: { type: 'array', items: evidence }, errors },
    recordManual: { input: object({ id: string, revision: integer, taskID: string, checkID: string, note: { ...string, maxLength: 1000 }, sessionID: string }, ['id', 'revision', 'taskID', 'checkID', 'note']), output: record, errors },
    signOff: { input: object({ recordID: string, expectedRevision: integer, sessionID: string }, ['recordID', 'expectedRevision']), output: record, errors },
    probeWorkerSession: { input: object({ parentSessionID: string, model: object({ providerID: string, id: string, variant: string }, ['providerID', 'id']) }), output: { type: 'object' }, errors },
  },
  events: { changed: { schema: object({ recordID: string, revision: integer }) } },
})
// JSON-schema inference is unknown in SDK 2.3.2. This explicit contract mirrors the schemas.
export interface RelayApi {
  exportReport(input: { recordID: string; write?: boolean }, options?: object): Promise<{ name: string; markdown: string; path?: string }>
  validateConfig(input: object, options?: object): Promise<ConfigReport>
  probeImage(input: { parentSessionID: string }, options?: object): Promise<ConfigReport>
  getSnapshot(input: { recordID: string }, options?: object): Promise<RecordInfo>
  createRecord(input: { title: string; sessionID?: string }, options?: object): Promise<RecordInfo>
  mutate(input: { recordID: string; expectedRevision: number; op: Op }, options?: object): Promise<RecordInfo>
  requestApproval(input: { recordID: string; expectedRevision: number; kind: 'plan'; sessionID?: string }, options?: object): Promise<RecordInfo>
  withdrawApproval(input: { recordID: string; key: string }, options?: object): Promise<RecordInfo>
  listRecords(input: object, options?: object): Promise<RecordInfo[]>
  listRuns(input: { recordID: string }, options?: object): Promise<RunInfo[]>
  listEvidence(input: { id: string }, options?: object): Promise<Evidence[]>
  recordManual(input: { id: string; revision: number; taskID: string; checkID: string; note: string; sessionID?: string }, options?: object): Promise<RecordInfo>
  signOff(input: { recordID: string; expectedRevision: number; sessionID?: string }, options?: object): Promise<RecordInfo>
}
