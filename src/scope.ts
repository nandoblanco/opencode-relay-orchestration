export const MAX_ALLOWED_PATHS = 20
export const MAX_ALLOWED_PATH_LENGTH = 200
export const EDIT_ACTIONS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit'])

const invalidControl = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u{e0000}-\u{e007f}]/u

function collapseSegments(parts: string[]): string[] | undefined {
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!stack.length) return undefined
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack
}

function normalizeAbsolute(raw: string): { root: string; segments: string[] } | undefined {
  let path = raw.replace(/\\/g, '/')
  if (/^file:\/\//i.test(path)) {
    path = path.slice(7)
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  }
  let root = ''
  let rest = path
  const drive = path.match(/^([A-Za-z]:)(\/.*|$)/)
  const unc = !drive ? path.match(/^(\/\/[^/]+\/[^/]+)(\/.*|$)/) : null
  if (drive) { root = drive[1]; rest = drive[2] }
  else if (unc) { root = unc[1]; rest = unc[2] }
  else if (path.startsWith('/')) { root = '/'; rest = path.slice(1) }
  else return undefined
  const segments = collapseSegments(rest.split('/'))
  return segments ? { root, segments } : undefined
}

export function validateAllowedPaths(input: unknown): { ok: true; paths: string[] | undefined } | { ok: false; code: 'invalid_op' | 'limit_exceeded'; message: string } {
  if (input === undefined) return { ok: true, paths: undefined }
  if (!Array.isArray(input)) return { ok: false, code: 'invalid_op', message: 'allowedPaths must be an array of repo-relative paths or globs.' }
  if (input.length === 0) return { ok: true, paths: undefined }
  if (input.length > MAX_ALLOWED_PATHS) return { ok: false, code: 'limit_exceeded', message: `At most ${MAX_ALLOWED_PATHS} allowedPaths entries are allowed per task.` }
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const entry of input) {
    if (typeof entry !== 'string') return { ok: false, code: 'invalid_op', message: 'Each allowedPaths entry must be a non-empty string.' }
    const raw = entry.trim()
    if (!raw || Array.from(raw).length > MAX_ALLOWED_PATH_LENGTH || invalidControl.test(raw)) return { ok: false, code: 'invalid_op', message: 'allowedPaths entries must be valid repo-relative paths without control characters.' }
    if (raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('~') || /^[A-Za-z]:/.test(raw) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
      return { ok: false, code: 'invalid_op', message: `allowedPaths entry must be repo-relative: ${raw}` }
    }
    let clean = raw.replace(/\\/g, '/').replace(/\/+/g, '/')
    while (clean.startsWith('./')) clean = clean.slice(2)
    const trailingSlash = clean.endsWith('/')
    const body = trailingSlash ? clean.slice(0, -1) : clean
    if (!body || body === '.') return { ok: false, code: 'invalid_op', message: `allowedPaths entry cannot be empty or root: ${raw}` }
    const parts = body.split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) return { ok: false, code: 'invalid_op', message: `allowedPaths entry cannot traverse parent directories: ${raw}` }
    const value = trailingSlash ? `${body}/` : body
    if (!seen.has(value)) { seen.add(value); normalized.push(value) }
  }
  return { ok: true, paths: normalized }
}

export function normalizeTarget(directory: string, resource: string): string | undefined {
  const raw = resource.trim()
  if (!raw || invalidControl.test(raw)) return undefined
  if (raw.startsWith('~')) return undefined
  const posix = raw.replace(/\\/g, '/')
  const isAbs = posix.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(posix) || /^file:\/\//i.test(posix)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(posix) && !/^file:\/\//i.test(posix)) return undefined
  if (!isAbs) {
    const segments = collapseSegments(posix.split('/'))
    return segments?.length ? segments.join('/') : undefined
  }
  const base = normalizeAbsolute(directory)
  const target = normalizeAbsolute(posix)
  if (!base || !target) return undefined
  const ci = /^[A-Za-z]:$/.test(base.root) || base.root.startsWith('//')
  const same = (a: string, b: string) => ci ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!same(base.root, target.root) || target.segments.length <= base.segments.length) return undefined
  for (let i = 0; i < base.segments.length; i++) if (!same(base.segments[i], target.segments[i])) return undefined
  return target.segments.slice(base.segments.length).join('/')
}

function patternToRegex(pattern: string, caseInsensitive: boolean): RegExp {
  const glob = pattern.endsWith('/') ? `${pattern}**` : pattern
  let out = ''
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3 }
    else if (glob.startsWith('**', i)) { out += '.*'; i += 2 }
    else if (glob[i] === '*') { out += '[^/]*'; i += 1 }
    else if (glob[i] === '?') { out += '[^/]'; i += 1 }
    else { out += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1 }
  }
  return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '')
}

export function isPathAllowed(directory: string, resource: string, allowedPaths: ReadonlyArray<string>): boolean {
  const target = normalizeTarget(directory, resource)
  if (!target) return false
  const ci = /^[A-Za-z]:/.test(directory) || directory.startsWith('\\\\') || directory.startsWith('//')
  return allowedPaths.some(pattern => patternToRegex(pattern, ci).test(target))
}

export function checkScopeViolation(directory: string, action: string, resources: ReadonlyArray<string>, allowedPaths: ReadonlyArray<string>): string | undefined {
  if (!EDIT_ACTIONS.has(action)) return undefined
  if (!resources.length) return `Out-of-scope file edit blocked: target path unavailable. Allowed paths: ${allowedPaths.join(', ')}`
  for (const resource of resources) {
    if (!isPathAllowed(directory, resource, allowedPaths)) {
      return `Out-of-scope file edit blocked (${resource}). Allowed paths: ${allowedPaths.join(', ')}`
    }
  }
  return undefined
}
