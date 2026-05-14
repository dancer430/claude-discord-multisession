import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanProjectDirs } from '../src/project-dirs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-dirs-test-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function mkRepo(rel: string): void {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, '.git'))
}

describe('scanProjectDirs', () => {
  test('finds a .git at depth 1', async () => {
    mkRepo('foo')
    const r = await scanProjectDirs(root, {})
    expect(r.matches.map(m => m.relative)).toEqual(['foo'])
    expect(r.matches[0].basename).toBe('foo')
    expect(r.matches[0].cwd).toBe(join(root, 'foo'))
    expect(r.truncated).toBe(false)
  })

  test('finds a .git at depth 3', async () => {
    mkRepo('a/b/c')
    const r = await scanProjectDirs(root, {})
    expect(r.matches.map(m => m.relative)).toEqual(['a/b/c'])
  })

  test('does not recurse into a repo once .git is found', async () => {
    mkRepo('foo')
    mkRepo('foo/sub')   // submodule-like — should be skipped
    const r = await scanProjectDirs(root, {})
    expect(r.matches.map(m => m.relative)).toEqual(['foo'])
  })

  test('case-insensitive substring query', async () => {
    mkRepo('connectors-plugin')
    mkRepo('connectors-operator')
    mkRepo('foo-bar')
    const r = await scanProjectDirs(root, { query: 'CONN' })
    expect(r.matches.map(m => m.relative).sort()).toEqual(
      ['connectors-operator', 'connectors-plugin'],
    )
  })

  test('empty query returns all repos sorted by relative path', async () => {
    mkRepo('zeta')
    mkRepo('alpha')
    mkRepo('mid/beta')
    const r = await scanProjectDirs(root, { query: '' })
    expect(r.matches.map(m => m.relative)).toEqual(['alpha', 'mid/beta', 'zeta'])
  })

  test('skips blacklisted directories', async () => {
    mkRepo('keep')
    mkRepo('node_modules/x')
    mkRepo('dist/y')
    mkRepo('build/z')
    mkRepo('.git')          // root-relative .git folder itself (corner case)
    mkRepo('target/q')
    mkRepo('.next/r')
    mkRepo('.venv/s')
    mkRepo('vendor/t')
    const r = await scanProjectDirs(root, {})
    expect(r.matches.map(m => m.relative)).toEqual(['keep'])
  })

  test('does not follow symlinked directories', async () => {
    mkRepo('real')
    const other = mkdtempSync(join(tmpdir(), 'project-dirs-other-'))
    try {
      mkdirSync(join(other, 'sneaky'))
      mkdirSync(join(other, 'sneaky', '.git'))
      symlinkSync(other, join(root, 'link'))
      const r = await scanProjectDirs(root, {})
      expect(r.matches.map(m => m.relative)).toEqual(['real'])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('truncates to maxResults and reports truncated=true', async () => {
    for (let i = 0; i < 5; i++) mkRepo(`repo-${i}`)
    const r = await scanProjectDirs(root, { maxResults: 3 })
    expect(r.matches).toHaveLength(3)
    expect(r.truncated).toBe(true)
  })

  test('throws when root does not exist', async () => {
    await expect(scanProjectDirs(join(root, 'nope'), {})).rejects.toThrow()
  })

  test('throws when root is a file', async () => {
    const f = join(root, 'file')
    writeFileSync(f, 'x')
    await expect(scanProjectDirs(f, {})).rejects.toThrow()
  })

  test('times out when scan exceeds timeoutMs', async () => {
    // Build a deep tree so the recursive scan has work to do, then
    // pass timeoutMs=0 to force a deadline-exceeded throw on the
    // first elapsed-time check after the first readdir completes.
    for (let i = 0; i < 20; i++) mkdirSync(join(root, `d${i}`))
    await expect(scanProjectDirs(root, { timeoutMs: 0 })).rejects.toThrow(/timeout/i)
  })

  test('query does not match path components, only basename', async () => {
    mkRepo('outer/inner-repo')   // basename = 'inner-repo'
    // 'outer' appears in the path but not in any basename
    const r = await scanProjectDirs(root, { query: 'outer' })
    expect(r.matches).toHaveLength(0)
  })
})
