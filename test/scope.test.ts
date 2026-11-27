import test from 'node:test'
import assert from 'node:assert/strict'
import { checkScopeViolation, isPathAllowed, MAX_ALLOWED_PATHS, normalizeTarget, validateAllowedPaths } from '../src/scope.ts'

test('validateAllowedPaths normalizes, deduplicates and rejects unsafe patterns', () => {
  assert.deepEqual(validateAllowedPaths(undefined), { ok: true, paths: undefined })
  assert.deepEqual(validateAllowedPaths([]), { ok: true, paths: undefined })
  assert.deepEqual(validateAllowedPaths(['./src\\styles//', 'src/styles/', ' src/report.ts ']), { ok: true, paths: ['src/styles/', 'src/report.ts'] })

  for (const bad of [
    [''],
    ['   '],
    ['.'],
    ['./'],
    ['/etc/passwd'],
    ['C:\\secret\\a.ts'],
    ['\\\\server\\share\\a.ts'],
    ['~/secret.ts'],
    ['file:///tmp/a.ts'],
    ['../escape.ts'],
    ['src/../../escape.ts'],
    ['src/\u202ebad.ts'],
    ['a'.repeat(201)],
  ]) {
    const res = validateAllowedPaths(bad)
    assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(bad)}`)
    if (!res.ok) assert.equal(res.code, 'invalid_op')
  }

  const tooMany = Array.from({ length: MAX_ALLOWED_PATHS + 1 }, (_, i) => `src/f${i}.ts`)
  const over = validateAllowedPaths(tooMany)
  assert.equal(over.ok, false)
  if (!over.ok) assert.equal(over.code, 'limit_exceeded')
})

test('normalizeTarget and isPathAllowed enforce repo-relative patterns on Windows and POSIX', () => {
  const winDir = 'C:\\workspace\\project'
  assert.equal(normalizeTarget(winDir, 'C:\\workspace\\project\\src\\report.ts'), 'src/report.ts')
  assert.equal(normalizeTarget(winDir, 'c:/workspace/project/SRC/Report.ts'), 'SRC/Report.ts')
  assert.equal(normalizeTarget(winDir, './src\\a\\..\\b.ts'), 'src/b.ts')
  assert.equal(normalizeTarget(winDir, 'file:///C:/workspace/project/src/x.ts'), 'src/x.ts')
  assert.equal(normalizeTarget(winDir, 'C:\\workspace\\other\\x.ts'), undefined)
  assert.equal(normalizeTarget(winDir, 'C:\\workspace\\project\\..\\other\\x.ts'), undefined)
  assert.equal(normalizeTarget(winDir, '../outside.ts'), undefined)

  assert.equal(isPathAllowed(winDir, 'C:\\workspace\\project\\SRC\\Report.ts', ['src/report.ts']), true)
  assert.equal(isPathAllowed(winDir, 'src/a.ts', ['src/*.ts']), true)
  assert.equal(isPathAllowed(winDir, 'src/sub/a.ts', ['src/*.ts']), false)
  assert.equal(isPathAllowed(winDir, 'src/a.ts', ['src/**/*.ts']), true)
  assert.equal(isPathAllowed(winDir, 'src/sub/deep/a.ts', ['src/**/*.ts']), true)
  assert.equal(isPathAllowed(winDir, 'src/styles/main.css', ['src/styles/']), true)
  assert.equal(isPathAllowed(winDir, 'src/styles/sub/a.css', ['src/styles/']), true)
  assert.equal(isPathAllowed(winDir, 'src/styles-extra/a.css', ['src/styles/']), false)
  assert.equal(isPathAllowed(winDir, 'src/v1.ts', ['src/v?.ts']), true)
  assert.equal(isPathAllowed(winDir, 'src/v10.ts', ['src/v?.ts']), false)

  const posixDir = '/work/app'
  assert.equal(isPathAllowed(posixDir, '/work/app/src/app.ts', ['src/app.ts']), true)
  assert.equal(isPathAllowed(posixDir, '/work/app/SRC/app.ts', ['src/app.ts']), false)
  assert.equal(isPathAllowed(posixDir, '/etc/passwd', ['**']), false)
  assert.equal(isPathAllowed(posixDir, '../app/src/app.ts', ['src/app.ts']), false)
})

test('checkScopeViolation blocks out-of-scope and empty-resource edits while allowing non-edit actions', () => {
  const dir = 'C:\\workspace\\project'
  assert.equal(checkScopeViolation(dir, 'read', ['C:\\workspace\\other\\secret.txt'], ['src/**']), undefined)
  assert.equal(checkScopeViolation(dir, 'shell', ['npm test'], ['src/**']), undefined)
  assert.equal(checkScopeViolation(dir, 'edit', ['C:\\workspace\\project\\src\\ok.ts'], ['src/**']), undefined)
  assert.equal(checkScopeViolation(dir, 'multiedit', ['src/a.ts', 'src/b.ts'], ['src/*.ts']), undefined)

  const denied = checkScopeViolation(dir, 'edit', ['C:\\workspace\\project\\package.json'], ['src/**'])
  assert.match(denied ?? '', /Out-of-scope file edit blocked.*src\/\*\*/)

  const mixed = checkScopeViolation(dir, 'apply_patch', ['src/a.ts', 'README.md'], ['src/*.ts'])
  assert.match(mixed ?? '', /Out-of-scope file edit blocked.*README\.md/)

  const empty = checkScopeViolation(dir, 'write', [], ['src/**'])
  assert.match(empty ?? '', /unavailable/i)
})
