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

import { mock } from 'bun:test'
import { spawnClaude } from '../src/spawn-session'

describe('spawnClaude', () => {
  function makeSpawnStub(pid = 12345) {
    const calls: any[] = []
    const fn: any = (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts })
      return { pid, unref() { (fn as any).unrefed = true } }
    }
    fn.calls = calls
    return fn
  }
  function makeOpenSync(fd = 7) {
    const calls: any[] = []
    const fn: any = (path: string, flags: string, mode: number) => {
      calls.push({ path, flags, mode })
      return fd
    }
    fn.calls = calls
    return fn
  }

  test('spawns with cwd, env additions, detached, stdio fd', () => {
    const spawnStub = makeSpawnStub()
    const openSyncStub = makeOpenSync(11)
    const r = spawnClaude({
      cwd: '/root/sub',
      threadName: 'sub',
      command: ['claude', '--channels', 'plugin:discord@dancer430-discord'],
      env: { PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080' },
      logPath: '/tmp/spawned-abc.log',
      spawn: spawnStub,
      openSync: openSyncStub,
    })
    expect(r).toEqual({ ok: true, pid: 12345 })
    expect(spawnStub.calls).toHaveLength(1)
    const call = spawnStub.calls[0]
    expect(call.cmd).toBe('claude')
    expect(call.args).toEqual(['--channels', 'plugin:discord@dancer430-discord'])
    expect(call.opts.cwd).toBe('/root/sub')
    expect(call.opts.detached).toBe(true)
    expect(call.opts.stdio).toEqual(['ignore', 11, 11])
    expect(call.opts.env.DISCORD_THREAD_ID).toBe('auto')
    expect(call.opts.env.DISCORD_THREAD_NAME).toBe('sub')
    expect(call.opts.env.HTTPS_PROXY).toBe('http://proxy:8080')
    expect(call.opts.env.PATH).toBe('/bin')
    expect(openSyncStub.calls[0].path).toBe('/tmp/spawned-abc.log')
    expect((spawnStub as any).unrefed).toBe(true)
  })

  test('caller-supplied env entries do NOT override DISCORD_THREAD_ID / NAME', () => {
    const spawnStub = makeSpawnStub()
    const r = spawnClaude({
      cwd: '/root/sub', threadName: 'sub',
      command: ['claude'],
      env: { DISCORD_THREAD_ID: 'attacker', DISCORD_THREAD_NAME: 'attacker' },
      logPath: '/tmp/x.log',
      spawn: spawnStub, openSync: makeOpenSync(),
    })
    expect(r.ok).toBe(true)
    expect(spawnStub.calls[0].opts.env.DISCORD_THREAD_ID).toBe('auto')
    expect(spawnStub.calls[0].opts.env.DISCORD_THREAD_NAME).toBe('sub')
  })

  test('returns spawn_failed when spawn throws ENOENT', () => {
    const spawnStub: any = () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    const r = spawnClaude({
      cwd: '/root/sub', threadName: 'sub',
      command: ['no-such-binary'],
      env: {}, logPath: '/tmp/x.log',
      spawn: spawnStub, openSync: makeOpenSync(),
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('spawn_failed')
    expect(r.message).toContain('ENOENT')
  })

  test('returns spawn_failed when openSync throws', () => {
    const r = spawnClaude({
      cwd: '/root/sub', threadName: 'sub',
      command: ['claude'], env: {},
      logPath: '/no/such/dir/x.log',
      spawn: makeSpawnStub(),
      openSync: ((_: string) => { throw new Error('EACCES') }) as any,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('spawn_failed')
    expect(r.message).toContain('EACCES')
  })
})

describe('spawnClaude fd-leak fix', () => {
  test('closes fd when spawn throws (no fd leak)', () => {
    const closedFds: number[] = []
    mock.module('fs', () => ({
      ...require('fs'),
      closeSync: (fd: number) => { closedFds.push(fd) },
    }))
    const failSpawn: any = () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
    const r = spawnClaude({
      cwd: '/root/sub', threadName: 'sub',
      command: ['no-such'], env: {}, logPath: '/tmp/x.log',
      spawn: failSpawn,
      openSync: ((_: string, _f: string, _m: number) => 42) as any,
    })
    expect(r.ok).toBe(false)
    expect(closedFds).toEqual([42])
  })

  test('closes fd on parent side after successful spawn (no fd leak)', () => {
    const closedFds: number[] = []
    mock.module('fs', () => ({
      ...require('fs'),
      closeSync: (fd: number) => { closedFds.push(fd) },
    }))
    const spawnStub: any = () => ({ pid: 7777, unref() {} })
    const r = spawnClaude({
      cwd: '/root/sub', threadName: 'sub',
      command: ['claude'], env: {}, logPath: '/tmp/x.log',
      spawn: spawnStub,
      openSync: ((_: string, _f: string, _m: number) => 99) as any,
    })
    expect(r).toEqual({ ok: true, pid: 7777 })
    expect(closedFds).toEqual([99])
  })
})

import { handleSpawnCommand } from '../src/spawn-session'
import { FakeDiscordOps } from '../src/discord-ops'

describe('handleSpawnCommand', () => {
  function setup(over: Partial<Access> = {}) {
    const ops = new FakeDiscordOps()
    const spawnStub = (() => {
      const calls: any[] = []
      const fn: any = (cmd: string, args: string[], opts: any) => {
        calls.push({ cmd, args, opts })
        return { pid: 999, unref() {} }
      }
      fn.calls = calls
      return fn
    })()
    const openSyncStub: any = () => 5
    const logCalls: any[] = []
    const access: Access = { ...defaultAccess(), allowFrom: ['user-1'], spawnAllowedRoots: ['/root'], ...over }
    return { ops, spawnStub, openSyncStub, logCalls, access }
  }

  test('happy path: ack reply, spawn invoked, success log', async () => {
    const { ops, spawnStub, openSyncStub, logCalls, access } = setup()
    await handleSpawnCommand({
      rawPath: '/root/sub',
      senderId: 'user-1',
      parentChannelId: 'parent-1',
      access,
      ops,
      command: ['claude', '--channels', 'plugin:discord@x'],
      env: { PATH: '/bin' },
      stateDir: '/tmp/state',
      statSync: ((p: string) => ({ isDirectory: () => true })) as any,
      spawn: spawnStub,
      openSync: openSyncStub,
      log: (fields) => logCalls.push(fields),
      homeDir: '/Users/me',
    })

    const replies = ops.calls.filter(c => c.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(String((replies[0] as any).text)).toContain('/root/sub')
    expect(spawnStub.calls).toHaveLength(1)
    expect(spawnStub.calls[0].opts.cwd).toBe('/root/sub')
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0].outcome).toBe('ok')
    expect(logCalls[0].pid).toBe(999)
  })

  test('rejection: not_authorized → silent (no reply), err log only', async () => {
    const { ops, spawnStub, openSyncStub, logCalls, access } = setup()
    await handleSpawnCommand({
      rawPath: '/root/sub', senderId: 'someone-else',
      parentChannelId: 'parent-1', access, ops,
      command: ['claude'], env: {}, stateDir: '/tmp/state',
      statSync: (() => ({ isDirectory: () => true })) as any,
      spawn: spawnStub, openSync: openSyncStub,
      log: (f) => logCalls.push(f), homeDir: '/Users/me',
    })
    expect(ops.calls.filter(c => c.kind === 'reply')).toHaveLength(0)
    expect(spawnStub.calls).toHaveLength(0)
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0].outcome).toBe('err')
    expect(logCalls[0].code).toBe('not_authorized')
  })

  test('rejection: path_outside_allowlist → error reply, err log', async () => {
    const { ops, spawnStub, openSyncStub, logCalls, access } = setup()
    await handleSpawnCommand({
      rawPath: '/elsewhere', senderId: 'user-1',
      parentChannelId: 'parent-1', access, ops,
      command: ['claude'], env: {}, stateDir: '/tmp/state',
      statSync: (() => ({ isDirectory: () => true })) as any,
      spawn: spawnStub, openSync: openSyncStub,
      log: (f) => logCalls.push(f), homeDir: '/Users/me',
    })
    const replies = ops.calls.filter(c => c.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(String((replies[0] as any).text)).toMatch(/spawnAllowedRoots|白名单/)
    expect(spawnStub.calls).toHaveLength(0)
    expect(logCalls[0].outcome).toBe('err')
    expect(logCalls[0].code).toBe('path_outside_allowlist')
  })

  test('rejection: allowlist_empty → error reply mentions config', async () => {
    const { ops, spawnStub, openSyncStub, logCalls, access } = setup({ spawnAllowedRoots: [] })
    await handleSpawnCommand({
      rawPath: '/anything', senderId: 'user-1',
      parentChannelId: 'parent-1', access, ops,
      command: ['claude'], env: {}, stateDir: '/tmp/state',
      statSync: (() => ({ isDirectory: () => true })) as any,
      spawn: spawnStub, openSync: openSyncStub,
      log: (f) => logCalls.push(f), homeDir: '/Users/me',
    })
    expect(ops.calls.filter(c => c.kind === 'reply')).toHaveLength(1)
    expect(spawnStub.calls).toHaveLength(0)
    expect(logCalls[0].code).toBe('allowlist_empty')
  })

  test('spawn-side failure: ack present, plus failure reply, err log', async () => {
    const { ops, openSyncStub, logCalls, access } = setup()
    const failSpawn: any = () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
    await handleSpawnCommand({
      rawPath: '/root/sub', senderId: 'user-1',
      parentChannelId: 'parent-1', access, ops,
      command: ['no-such'], env: {}, stateDir: '/tmp/state',
      statSync: (() => ({ isDirectory: () => true })) as any,
      spawn: failSpawn, openSync: openSyncStub,
      log: (f) => logCalls.push(f), homeDir: '/Users/me',
    })
    const replies = ops.calls.filter(c => c.kind === 'reply')
    expect(replies.length).toBe(2)
    expect(String((replies[0] as any).text)).toContain('启动')   // ack
    expect(String((replies[1] as any).text)).toMatch(/启动失败|ENOENT/)
    expect(logCalls[0].outcome).toBe('err')
    expect(logCalls[0].code).toBe('spawn_failed')
  })

  test('ENOENT failure reply includes CLAUDE_DISCORD_SPAWN_CMD hint', async () => {
    const { ops, openSyncStub, logCalls, access } = setup()
    const failSpawn: any = () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }
    await handleSpawnCommand({
      rawPath: '/root/sub', senderId: 'user-1',
      parentChannelId: 'parent-1', access, ops,
      command: ['claude', '--channels', 'plugin:discord@x'], env: {},
      stateDir: '/tmp/state',
      statSync: (() => ({ isDirectory: () => true })) as any,
      spawn: failSpawn, openSync: openSyncStub,
      log: (f) => logCalls.push(f), homeDir: '/Users/me',
    })
    const replies = ops.calls.filter(c => c.kind === 'reply')
    const errReply = String((replies[1] as any).text)
    expect(errReply).toContain('CLAUDE_DISCORD_SPAWN_CMD')
    expect(errReply).toContain('claude --channels plugin:discord@x')
  })

  test('log path lives under stateDir/spawned', async () => {
    const { ops, spawnStub, logCalls, access } = setup()
    let opened = ''
    const openSyncStub: any = (p: string) => { opened = p; return 5 }
    await handleSpawnCommand({
      rawPath: '/root/sub', senderId: 'user-1',
      parentChannelId: 'parent-1', access, ops,
      command: ['claude'], env: {}, stateDir: '/tmp/state',
      statSync: (() => ({ isDirectory: () => true })) as any,
      spawn: spawnStub, openSync: openSyncStub,
      log: (f) => logCalls.push(f), homeDir: '/Users/me',
    })
    expect(opened.startsWith('/tmp/state/spawned/')).toBe(true)
    expect(opened.endsWith('.log')).toBe(true)
  })
})
