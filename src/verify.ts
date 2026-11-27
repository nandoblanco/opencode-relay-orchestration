import { stat, readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { Check, Evidence } from './model.ts'

export type Preflight = { childProcess: boolean; checks: { checkID: string; available: boolean; reason?: string }[] }
export type CheckResult = Omit<Evidence, 'id' | 'recordID' | 'taskID' | 'checkID' | 'buildRunID'>
export const MAX_SCREENSHOT_COUNT = 8
export const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024
const childProcess = () => import('node:child_process')
export async function preflight(directory: string, checks: Check[], importer = childProcess, requireFrom = createRequire): Promise<Preflight> {
  let available = false
  try { await importer(); available = true } catch {}
  let exists = false
  try { exists = (await stat(directory)).isDirectory() } catch {}
  const results = checks.map(check => {
    let reason = !available ? 'child_process unavailable' : !exists ? 'directory unavailable' : ''
    if (!reason && check.adapter === 'playwright') {
      const require = requireFrom(resolve(directory, 'package.json'))
      let found = false
      for (const name of ['playwright', '@playwright/test']) { try { require.resolve(name); found = true; break } catch {} }
      if (!found) reason = 'Playwright package unavailable'
    }
    return { checkID: check.id, available: !reason, ...(reason ? { reason } : {}) }
  })
  return { childProcess: available, checks: results }
}
export async function runCheck(directory: string, check: Check, signal?: AbortSignal, importer = childProcess): Promise<CheckResult> {
  const startedAt = Date.now(); let output = ''; let timedOut = false
  const { spawn } = await importer()
  signal?.throwIfAborted()
  const exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(check.command, { shell: true, cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(process.platform !== 'win32' ? { detached: true } : {}) })
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-4000) }
    child.stdout?.on('data', append); child.stderr?.on('data', append)
    function kill() {
      if (process.platform === 'win32' && child.pid) {
        const kill = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true })
        kill.on('error', reject)
      } else {
        try { if (!child.pid) throw Error('missing pid'); process.kill(-child.pid, 'SIGKILL') }
        catch { child.kill('SIGKILL') }
      }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, check.timeoutMs ?? 300000)
    const abort = () => { kill() }
    signal?.addEventListener('abort', abort, { once: true })
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    function cleanup() { clearTimeout(timer); clearTimeout(exitTimer); signal?.removeEventListener('abort', abort) }
    child.on('error', error => { cleanup(); reject(error) })
    child.on('exit', code => { exitTimer = setTimeout(() => { cleanup(); done(code ?? -1) }, 2000) })
    child.on('close', code => { cleanup(); done(code ?? -1) })
  })
  signal?.throwIfAborted()
  const screenshots: Evidence['screenshots'] = []
  let capReason: string | undefined
  if (check.adapter === 'playwright' && exitCode === 0 && !timedOut) {
    const found: { path: string; bytes: number }[] = []
    async function collect(path: string) {
      let entries
      try { entries = await readdir(path, { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries) {
        const file = join(path, entry.name)
        if (entry.isDirectory()) await collect(file)
        else if (entry.isFile() && /\.png$/i.test(entry.name)) {
          const info = await stat(file)
          if (info.mtimeMs >= startedAt) found.push({ path: file, bytes: info.size })
        }
      }
    }
    await collect(resolve(directory, check.screenshotDir ?? '.screenshots'))
    found.sort((a, b) => a.path.localeCompare(b.path))
    const totalBytes = found.reduce((sum, item) => sum + item.bytes, 0)
    if (found.length > MAX_SCREENSHOT_COUNT) capReason = `screenshot cap exceeded: ${found.length} files exceeds limit ${MAX_SCREENSHOT_COUNT}`
    else if (totalBytes > MAX_SCREENSHOT_BYTES) capReason = `screenshot cap exceeded: ${totalBytes} bytes exceeds limit ${MAX_SCREENSHOT_BYTES}`
    else for (const item of found) screenshots.push({ path: item.path, sha256: createHash('sha256').update(await readFile(item.path)).digest('hex'), bytes: item.bytes })
  }
  const endedAt = Date.now()
  return { result: exitCode !== 0 || timedOut || capReason ? 'failed' : check.adapter === 'playwright' && !screenshots.length ? 'unverified' : 'passed', source: 'adapter', exitCode, output, screenshots,
    ...(timedOut ? { reason: 'check timed out' } : capReason ? { reason: capReason } : check.adapter === 'playwright' && !screenshots.length && exitCode === 0 ? { reason: 'no screenshots produced' } : {}), startedAt, endedAt, durationMs: endedAt - startedAt }
}
