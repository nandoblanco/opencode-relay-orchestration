import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preflight, runCheck, MAX_SCREENSHOT_COUNT, MAX_SCREENSHOT_BYTES } from '../src/verify.ts'
import { EventEmitter } from 'node:events'
import type { Check } from '../src/model.ts'
import { mkdir, mkdtemp, writeFile, rm, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const check: Check = { id: 'check', name: 'Test', adapter: 'command', command: 'test', policy: 'automated-required' }
test('non-Windows checks detach, kill the process group and fall back to child kill', async t => {
  t.mock.property(process, 'platform', 'linux')
  for (const fallback of [false, true]) {
    const calls: any[] = []; const child = new EventEmitter() as any; child.pid = 123
    child.kill = (signal: string) => { calls.push(['child', signal]); setImmediate(() => child.emit('close', 1)) }
    const kill = t.mock.method(process, 'kill', (pid: number, signal: string) => { calls.push([pid, signal]); if (fallback) throw Error('missing group'); setImmediate(() => child.emit('close', 1)); return true })
    const controller = new AbortController(); let options: any
    const importer = async () => ({ spawn: (_: string, input: any) => { options = input; return child } }) as any
    const result = runCheck('.', check, controller.signal, importer)
    await new Promise(resolve => setImmediate(resolve)); controller.abort()
    await assert.rejects(result, /abort/i)
    assert.equal(options.detached, true); assert.deepEqual(calls[0], [-123, 'SIGKILL'])
    assert.equal(calls.length, fallback ? 2 : 1)
    kill.mock.restore()
  }
})
test('exit resolves after two seconds when inherited pipes never close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = new EventEmitter() as any
  const result = runCheck('.', check, undefined, async () => ({ spawn: () => child }) as any)
  await new Promise(resolve => setImmediate(resolve)); child.emit('exit', 0)
  t.mock.timers.tick(2000)
  assert.equal((await result).result, 'passed')
})
test('abort kills the check and ignores stdin without creating a result', async () => {
  const controller = new AbortController(); const calls: any[] = []
  const child = new EventEmitter() as any; child.pid = 123; child.kill = () => setImmediate(() => child.emit('close', 1))
  const spawn = async () => ({ spawn: (...args: any[]) => {
    calls.push(args)
    if (calls.length === 1) return child
    setImmediate(() => child.emit('close', 1)); return new EventEmitter()
  } }) as any
  const result = runCheck('.', check, controller.signal, spawn)
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  await assert.rejects(result, /abort/i)
  assert.deepEqual(calls[0][1].stdio, ['ignore', 'pipe', 'pipe'])
  if (process.platform === 'win32') assert.deepEqual(calls[1].slice(0, 2), ['taskkill', ['/T', '/F', '/PID', '123']])
})
test('preflight guards missing child_process, missing directory and missing Playwright', async () => {
  const missing = await preflight('.', [check], async () => { throw Error('missing') })
  assert.equal(missing.childProcess, false); assert.equal(missing.checks[0].available, false)
  assert.equal((await preflight('./does-not-exist', [check])).checks[0].reason, 'directory unavailable')
  const requireFrom = (() => ({ resolve: () => { throw Error('missing') } })) as any
  assert.equal((await preflight('.', [{ ...check, adapter: 'playwright' }], undefined, requireFrom)).checks[0].reason, 'Playwright package unavailable')
  assert.equal((await preflight('.', [check])).checks[0].available, true)
})
function importer(code: number, output = '') {
  return async () => ({ spawn: () => {
    const child = new EventEmitter() as any; child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    setImmediate(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', code) })
    return child
  } }) as any
}
test('adapter records exit, tail and no-screenshot unverified rather than pass', async () => {
  const passed = await runCheck('.', check, undefined, importer(0, 'x'.repeat(5000)))
  assert.equal(passed.result, 'passed'); assert.equal(passed.output?.length, 4000)
  assert.equal((await runCheck('.', check, undefined, importer(1))).result, 'failed')
  const empty = await runCheck('.', { ...check, adapter: 'playwright', screenshotDir: 'does-not-exist' }, undefined, importer(0))
  assert.equal(empty.result, 'unverified'); assert.equal(empty.reason, 'no screenshots produced')
})
test('Playwright collects only fresh PNGs and hashes bytes', async () => {
  await mkdir('.screenshots', { recursive: true })
  const directory = await mkdtemp(resolve('.screenshots', 'm4-adapter-'))
  try {
    await mkdir(join(directory, '.screenshots'))
    await writeFile(join(directory, '.screenshots', 'old.png'), 'old')
    await utimes(join(directory, '.screenshots', 'old.png'), 1, 1)
    const spawn = async () => ({ spawn: () => {
      const child = new EventEmitter() as any
      setImmediate(async () => { await writeFile(join(directory, '.screenshots', 'new.png'), 'png'); await utimes(join(directory, '.screenshots', 'new.png'), new Date(Date.now() + 1000), new Date(Date.now() + 1000)); child.emit('close', 0) })
      return child
    } }) as any
    const result = await runCheck(directory, { ...check, adapter: 'playwright' }, undefined, spawn)
    assert.equal(result.result, 'passed'); assert.equal(result.screenshots.length, 1); assert.equal(result.screenshots[0].bytes, 3); assert.match(result.screenshots[0].sha256, /^[a-f0-9]{64}$/)
  } finally { await rm(directory, { recursive: true }) }
})
test('Windows timeout requests taskkill for the process tree and records failure', async t => {
  if (process.platform !== 'win32') return
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: any[] = []; const child = new EventEmitter() as any; child.pid = 123
  const spawn = async () => ({ spawn: (...args: any[]) => {
    calls.push(args)
    if (calls.length === 1) return child
    setImmediate(() => child.emit('close', 1))
    return new EventEmitter()
  } }) as any
  const result = runCheck('.', { ...check, timeoutMs: 10 }, undefined, spawn)
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(10)
  assert.equal((await result).reason, 'check timed out')
  assert.deepEqual(calls[1].slice(0, 2), ['taskkill', ['/T', '/F', '/PID', '123']])
})
test('Playwright fails loudly when screenshot count or total bytes exceed caps', async () => {
  await mkdir('.screenshots', { recursive: true })
  const directory = await mkdtemp(resolve('.screenshots', 'm7-caps-'))
  try {
    const dir = join(directory, '.screenshots')
    await mkdir(dir)
    const countSpawn = async () => ({ spawn: () => {
      const child = new EventEmitter() as any
      setImmediate(async () => {
        const future = new Date(Date.now() + 1000)
        for (let i = 0; i < MAX_SCREENSHOT_COUNT + 1; i++) {
          const file = join(dir, `shot-${i}.png`)
          await writeFile(file, 'png'); await utimes(file, future, future)
        }
        child.emit('close', 0)
      })
      return child
    } }) as any
    const overCount = await runCheck(directory, { ...check, adapter: 'playwright' }, undefined, countSpawn)
    assert.equal(overCount.result, 'failed')
    assert.deepEqual(overCount.screenshots, [])
    assert.match(overCount.reason ?? '', /screenshot cap exceeded: 9 files exceeds limit 8/)

    const bytesDir = join(directory, 'big-shots')
    await mkdir(bytesDir)
    const bytesSpawn = async () => ({ spawn: () => {
      const child = new EventEmitter() as any
      setImmediate(async () => {
        const future = new Date(Date.now() + 1000)
        const file = join(bytesDir, 'huge.png')
        await writeFile(file, Buffer.alloc(MAX_SCREENSHOT_BYTES + 1))
        await utimes(file, future, future)
        child.emit('close', 0)
      })
      return child
    } }) as any
    const overBytes = await runCheck(directory, { ...check, adapter: 'playwright', screenshotDir: 'big-shots' }, undefined, bytesSpawn)
    assert.equal(overBytes.result, 'failed')
    assert.deepEqual(overBytes.screenshots, [])
    assert.match(overBytes.reason ?? '', /screenshot cap exceeded: .* bytes exceeds limit/)
  } finally { await rm(directory, { recursive: true }) }
})
