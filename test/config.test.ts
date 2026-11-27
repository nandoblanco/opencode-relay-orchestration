import { test } from 'node:test'
import { candidates, effectiveConfig, configSummary, validateSettings } from '../src/config.ts'
test('configuration facts, overlays, disable explorer and validation ranges', () => {
  const model = { providerID: 'test', id: 'model', name: 'Model', status: 'active', capabilities: { tools: true, input: ['text', 'image'] }, limit: { context: 1000 }, variants: [{ id: 'high' }] }
  const models = [model, { ...model, id: 'deprecated', status: 'deprecated' }, { ...model, id: 'text', capabilities: { tools: true, input: ['text'] } }, { ...model, id: 'no-tools', capabilities: { tools: false, input: ['image'] } }]
  assert.deepEqual(candidates(models, 'reviewer').map(model => model.id), ['model'])
  assert.deepEqual(candidates(models, 'builder').map(model => model.id), ['model', 'text'])
  assert.equal(Object.keys(candidates(models, 'reviewer')[0]).includes('cost'), false)
  const configured = effectiveConfig({ roles: { explorer: { providerID: 'test', id: 'original' }, planner: { providerID: 'test', id: 'original' } }, limits: { maxRunningTasks: 2 } }, { version: 1, roles: { planner: { providerID: 'test', id: 'model' } }, limits: { maxFixCycles: 0 }, explorer: false, autoStart: false, brainstormFirst: false, widths: [390], updatedAt: 'now' })
  assert.equal(configured.models.planner!.id, 'model'); assert.equal(configured.models.explorer, undefined)
  assert.deepEqual(configured.limits, { maxRunningTasks: 2, maxFixCycles: 0 }); assert.equal(configured.source, 'saved now'); assert.equal(configured.autoStart, false); assert.equal(configured.brainstormFirst, false)
  assert.match(configSummary(configured), /brainstorm off/)
  for (const input of [{ roles: { planner: { providerID: 'test', id: 'unknown' } } }, { roles: { planner: { providerID: 'test', id: 'model', variant: 'bad' } } }, { roles: { reviewer: { providerID: 'test', id: 'text' } } }, { limits: { maxFixCycles: 6 } }, { limits: { maxRunningTasks: 0 } }, { widths: [319] }, { widths: [3841] }, { widths: [320, 400, 500, 600, 700] }, { brainstormFirst: 'yes' as unknown as boolean }]) assert.throws(() => validateSettings(input, models))
  validateSettings({ roles: { reviewer: { providerID: 'test', id: 'model', variant: 'high' } }, widths: [320, 3840], limits: { maxFixCycles: 0, maxRunningTasks: 4 }, brainstormFirst: false }, models)
  assert.throws(() => validateSettings({ roles: { planner: { providerID: 'test', id: 'model' } } }, [{ ...model, enabled: false }]), /unavailable/)
})
test('invalid option settings are errors and ignored by effective summary', () => {
  for (const widths of ['390', [], [319], [3841], [390.5], [320, 400, 500, 600, 700]]) {
    const config = effectiveConfig({ widths, autoStart: 'yes', explorer: 0, brainstormFirst: 'no' })
    assert.ok(config.errors.some(error => error.startsWith('widths')))
    assert.ok(config.errors.includes('autoStart must be a boolean')); assert.ok(config.errors.includes('explorer must be a boolean')); assert.ok(config.errors.includes('brainstormFirst must be a boolean'))
    assert.deepEqual(config.widths, [1280, 390]); assert.equal(config.autoStart, true); assert.equal(config.explorer, true); assert.equal(config.brainstormFirst, true)
    assert.match(configSummary(config), /brainstorm on/)
  }
  const valid = effectiveConfig({ widths: [320, 3840], autoStart: false, explorer: false, brainstormFirst: false })
  assert.deepEqual(valid.widths, [320, 3840]); assert.equal(valid.autoStart, false); assert.equal(valid.explorer, false); assert.equal(valid.brainstormFirst, false)
})
import assert from 'node:assert/strict'
import { parseConfig, probeKey } from '../src/config.ts'
import { setup } from '../src/server.ts'
import { memoryStorage } from './helpers.ts'
import type { Plugin } from '@opencode/plugin'

test('config parser accepts role refs, missing roles and exact M4 limit defaults', () => {
  assert.deepEqual(parseConfig({ roles: { explorer: { providerID: 'test', id: 'explore' } } }).models.explorer, { providerID: 'test', id: 'explore' })
  assert.deepEqual(parseConfig(undefined).models, {})
  assert.deepEqual(parseConfig({}).errors, [])
  assert.deepEqual(parseConfig({ roles: { reviewr: { providerID: 'test', id: 'vision' } } }).errors, ['roles.reviewr is not a supported role'])
  assert.deepEqual(parseConfig({ limits: { maxRunningTasks: '3', maxFixCycles: -1 } }).limits, { maxRunningTasks: 1, maxFixCycles: 2 })
  const valid = parseConfig({ roles: { reviewer: { providerID: 'test', id: 'vision', variant: 'high' } }, limits: { maxRunningTasks: 2, maxFixCycles: 0 }, enableProbe: true })
  assert.equal(valid.models.reviewer?.id, 'vision'); assert.deepEqual(valid.errors, []); assert.equal(valid.enableProbe, true)
  for (const options of [null, [], { roles: [] }, { roles: { planner: 'bad' } }, { roles: { reviewer: { providerID: '', id: 3, variant: false } } }, { limits: null, enableProbe: 'true' }]) assert.ok(parseConfig(options).errors.length)
  assert.notEqual(probeKey({ providerID: 'test', id: 'a' }), probeKey({ providerID: 'test', id: 'a', variant: 'high' }))
})
test('role parsing runs once for multiple invalid roles and retains valid models with an unknown key', () => {
  assert.deepEqual(parseConfig({ roles: { planner: 'bad', reviewer: { providerID: '', id: 'x' } } }).errors, [
    'roles.planner must be an object',
    'roles.reviewer.providerID must be a nonempty string',
  ])
  const models = { planner: { providerID: 'test', id: 'plan' }, builder: { providerID: 'test', id: 'build' }, reviewer: { providerID: 'test', id: 'review', variant: 'high' } }
  const result = parseConfig({ roles: { ...models, reviewr: {} } })
  assert.deepEqual(result.errors, ['roles.reviewr is not a supported role'])
  assert.deepEqual(result.models, models)
})
async function context(options: object, storage = memoryStorage()) {
  let handlers: any; let creates = 0; let prompts = 0; let fail = false; let answer = 'red'; let waiting: Promise<void> | undefined
  const models = [{ providerID: 'test', id: 'vision', enabled: true, variants: [{ id: 'high' }], capabilities: { tools: true, input: ['text', 'image'] } }]
  const ctx = { options, storage, tool: { transform: async () => ({ dispose: async () => {} }) }, location: { directory: '/project', project: { id: 'project' } }, model: { list: async () => ({ data: models }) }, permission: { hook: async () => ({ dispose: async () => {} }) }, session: {
    get: async () => ({ projectID: 'project', location: { directory: '/project' }, tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
    create: async (input: any) => { creates++; assert.equal(input.permissions.length, 16); assert.ok(input.permissions.every((rule: any) => rule.effect === 'deny')); for (const action of ['edit', 'write', 'shell', 'subagent', 'question', 'relay.approve', 'relay.signoff', 'relay.verify', 'relay.configure', 'relay_plan_add', 'relay_plan_submit', 'relay_plan_cancel', 'relay_status', 'relay_explore', 'relay_config_set']) assert.ok(input.permissions.some((rule: any) => rule.action === action && rule.resource === '*')); assert.ok(input.permissions.some((rule: any) => rule.action === 'shell' && rule.resource === '*opencode*')); return { id: 'child' } },
    prompt: async (input: any) => { prompts++; assert.match(input.files[0].uri, /^data:image\/png;base64,/); if (fail) throw Error('transport'); await waiting }, wait: async () => {}, context: async () => [{ type: 'assistant', content: [{ type: 'text', text: answer }] }],
  }, rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } } } as unknown as Plugin.Context
  await setup({ ...ctx, command: { transform: async () => ({ dispose: async () => {} }) } } as unknown as Plugin.Context)
  return { handlers, models, creates: () => creates, prompts: () => prompts, fail: (value = true) => { fail = value }, answer: (text: string) => { answer = text }, wait: (value: Promise<void>) => { waiting = value } }
}
const error = { error: (type: string) => ({ type }) }
test('validateConfig reports missing, disabled, variant, tool and reviewer image outcomes without pricing', async () => {
  const role = { providerID: 'test', id: 'vision', variant: 'high' }
  const c = await context({ roles: { planner: role, builder: { ...role, id: 'missing' }, reviewer: role } })
  let report = await c.handlers.validateConfig()
  assert.equal(report.roles[0].exists, true); assert.equal(report.roles[1].exists, false); assert.equal(report.roles[2].image, 'declared')
  assert.doesNotMatch(JSON.stringify(report), /cost|pricing/)
  c.models[0].enabled = false; c.models[0].variants = []; c.models[0].capabilities.tools = false; c.models[0].capabilities.input = ['text']
  report = await c.handlers.validateConfig()
  assert.deepEqual(report.roles[2].errors, ['Model is disabled', 'Variant not found', 'Tools are required', 'Image input is not declared'])
  assert.equal(report.roles[2].image, 'unavailable')
  const missing = await context({}); assert.equal((await missing.handlers.validateConfig()).roles[2].image, 'not configured')
})
test('explicit image probe is gated, persisted per identity, survives setup and caches failure', async () => {
  const model = { providerID: 'test', id: 'vision', variant: 'high' }; const options = { roles: { reviewer: model }, enableProbe: true }; const storage = memoryStorage()
  const off = await context({ roles: { reviewer: model } }); assert.equal((await off.handlers.probeImage({ parentSessionID: 'parent' }, error)).type, 'invalid_op'); assert.equal(off.prompts(), 0)
  const c = await context(options, storage)
  const report = await c.handlers.probeImage({ parentSessionID: 'parent' }, error)
  assert.equal(report.roles[2].image, 'verified'); assert.equal(report.roles[2].probe.tokens.input, 4); assert.equal(c.prompts(), 1)
  await c.handlers.probeImage({ parentSessionID: 'parent' }, error); assert.equal(c.prompts(), 1)
  const restart = await context(options, storage); await restart.handlers.probeImage({ parentSessionID: 'parent' }, error); assert.equal(restart.creates(), 0)
  const changed = await context({ roles: { reviewer: { providerID: 'test', id: 'vision' } }, enableProbe: true }, storage); changed.answer('blue')
  assert.equal((await changed.handlers.probeImage({ parentSessionID: 'parent' }, error)).roles[2].image, 'failed'); assert.equal(changed.prompts(), 1)
})
test('host exceptions are logged, safe and not cached; a later authorized request can retry', async t => {
  const logs = t.mock.method(console, 'error', () => {})
  const storage = memoryStorage(); const model = { providerID: 'test', id: 'vision', variant: 'high' }
  const c = await context({ roles: { reviewer: model }, enableProbe: true }, storage)
  c.fail()
  const report = await c.handlers.probeImage({ parentSessionID: 'parent' }, error)
  assert.equal(report.roles[2].image, 'error'); assert.ok(Array.from(report.roles[2].probe.answer).length <= 200)
  assert.equal(await storage.get(probeKey(model)), undefined)
  assert.equal(logs.mock.callCount(), 1)
  assert.equal(logs.mock.calls[0].arguments[0], 'Relay image probe failed')
  assert.equal(logs.mock.calls[0].arguments[1], probeKey(model))
  assert.equal((logs.mock.calls[0].arguments[2] as Error).message, 'transport')
  c.fail(false)
  assert.equal((await c.handlers.probeImage({ parentSessionID: 'parent' }, error)).roles[2].image, 'verified')
  assert.equal(c.prompts(), 2)
  assert.equal((await storage.get(probeKey(model)) as any).status, 'verified')
})
test('probe accepts only an exact punctuation-normalized color and rejects refusals containing red', async () => {
  for (const answer of [' red ', 'RED.', '"Red!"', 'I refuse to identify this image, but the word red appears here.', 'The color is red', 'red or blue', 'red123', 'r e d']) {
    const c = await context({ roles: { reviewer: { providerID: 'test', id: 'vision' } }, enableProbe: true })
    c.answer(answer)
    assert.equal((await c.handlers.probeImage({ parentSessionID: 'parent' }, error)).roles[2].image, [' red ', 'RED.', '"Red!"'].includes(answer) ? 'verified' : 'failed')
  }
})
test('concurrent image probe uses invalid_op and never opens an extra prompt', async () => {
  const c = await context({ roles: { reviewer: { providerID: 'test', id: 'vision' } }, enableProbe: true })
  let release!: () => void
  c.wait(new Promise<void>(resolve => { release = resolve }))
  const first = c.handlers.probeImage({ parentSessionID: 'parent' }, error)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await c.handlers.probeImage({ parentSessionID: 'parent' }, error)).type, 'invalid_op')
  assert.equal(c.prompts(), 1)
  release(); await first
})
