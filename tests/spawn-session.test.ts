import { test, expect, describe } from 'bun:test'
import { parseSpawnCommand } from '../src/spawn-session'
import { validateSpawnRequest } from '../src/spawn-session'
import { defaultAccess, type Access } from '../src/access'

describe('parseSpawnCommand', () => {
  test('parses trigger + absolute path', () => {
    expect(parseSpawnCommand('起子区 /Users/me/foo', '起子区'))
      .toEqual({ rawPath: '/Users/me/foo' })
  })

  test('strips surrounding whitespace', () => {
    expect(parseSpawnCommand('  起子区   /tmp/x  ', '起子区'))
      .toEqual({ rawPath: '/tmp/x' })
  })

  test('returns null when trigger absent', () => {
    expect(parseSpawnCommand('hello world', '起子区')).toBeNull()
  })

  test('returns null when trigger has no argument', () => {
    expect(parseSpawnCommand('起子区', '起子区')).toBeNull()
    expect(parseSpawnCommand('起子区   ', '起子区')).toBeNull()
  })

  test('returns null when trigger is only a substring', () => {
    expect(parseSpawnCommand('foo起子区 /x', '起子区')).toBeNull()
  })

  test('rejects multi-line messages', () => {
    expect(parseSpawnCommand('起子区 /tmp/x\nmore', '起子区')).toBeNull()
  })

  test('honors a custom trigger', () => {
    expect(parseSpawnCommand('/spawn /a/b', '/spawn'))
      .toEqual({ rawPath: '/a/b' })
  })

  test('argument is everything after the first whitespace (no further split)', () => {
    // Paths can contain spaces if they have to. We take the whole remainder.
    expect(parseSpawnCommand('起子区 /a path/with spaces', '起子区'))
      .toEqual({ rawPath: '/a path/with spaces' })
  })
})

function makeAccess(over: Partial<Access> = {}): Access {
  return { ...defaultAccess(), allowFrom: ['user-1'], spawnAllowedRoots: ['/root'], ...over }
}

function fakeStat(isDir: boolean) {
  return (_: string) => ({ isDirectory: () => isDir })
}

describe('validateSpawnRequest', () => {
  test('happy path: in allowlist, exists, is dir, sender authorized', () => {
    const r = validateSpawnRequest({
      rawPath: '/root/sub',
      senderId: 'user-1',
      parentChannelId: 'chan-1',
      access: makeAccess(),
      statSync: fakeStat(true),
      homeDir: '/Users/me',
    })
    expect(r).toEqual({ ok: true, cwd: '/root/sub', threadName: 'sub' })
  })

  test('threadName is basename of resolved path', () => {
    const r = validateSpawnRequest({
      rawPath: '/root/sub/deeper-name',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(true), homeDir: '/Users/me',
    })
    if (!r.ok) throw new Error('expected ok')
    expect(r.threadName).toBe('deeper-name')
  })

  test('expands ~ against homeDir', () => {
    const r = validateSpawnRequest({
      rawPath: '~/foo',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess({ spawnAllowedRoots: ['/Users/me'] }),
      statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r).toEqual({ ok: true, cwd: '/Users/me/foo', threadName: 'foo' })
  })

  test('rejects when sender not in allowFrom', () => {
    const r = validateSpawnRequest({
      rawPath: '/root/sub',
      senderId: 'random', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('not_authorized')
  })

  test('rejects when spawnAllowedRoots empty/missing', () => {
    const r = validateSpawnRequest({
      rawPath: '/root/sub',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess({ spawnAllowedRoots: [] }),
      statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('allowlist_empty')
  })

  test('rejects relative path', () => {
    const r = validateSpawnRequest({
      rawPath: 'relative/path',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('path_not_absolute')
  })

  test('rejects path outside allowlist', () => {
    const r = validateSpawnRequest({
      rawPath: '/other/place',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('path_outside_allowlist')
  })

  test('prefix matching has a boundary: rejects /rootEvil under /root', () => {
    const r = validateSpawnRequest({
      rawPath: '/rootEvil/x',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('path_outside_allowlist')
  })

  test('exact-match allowlist root is allowed', () => {
    const r = validateSpawnRequest({
      rawPath: '/root',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(true)
  })

  test('rejects ENOENT', () => {
    const statSync = (_: string) => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) }
    const r = validateSpawnRequest({
      rawPath: '/root/sub',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(),
      statSync: statSync as any, homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('path_not_found')
  })

  test('rejects when path is not a directory', () => {
    const r = validateSpawnRequest({
      rawPath: '/root/file',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(false), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('path_not_directory')
  })

  test('normalizes ./.. segments before allowlist match', () => {
    // /root/../other -> /other, which is outside allowlist
    const r = validateSpawnRequest({
      rawPath: '/root/../other',
      senderId: 'user-1', parentChannelId: 'chan-1',
      access: makeAccess(), statSync: fakeStat(true), homeDir: '/Users/me',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('path_outside_allowlist')
  })
})
