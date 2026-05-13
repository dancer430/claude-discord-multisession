import { test, expect, describe } from 'bun:test'
import { type TmuxRunner, FakeTmuxRunner } from '../src/spawn-manager'
import {
  computeSessionId,
  tmuxSessionName,
  startSpawn,
  killSpawn,
  isAlive,
  PROXY_ENV,
  TMUX_PREFIX,
} from '../src/spawn-manager'
import { deriveSessionId } from '../src/session-id'

describe('FakeTmuxRunner', () => {
  test('records calls and returns scripted exit codes', async () => {
    const fake = new FakeTmuxRunner()
    fake.scriptExit(0)
    const result = await fake.run(['new-session', '-d', '-s', 'claude-abc', 'echo hi'])
    expect(result.exitCode).toBe(0)
    expect(fake.calls).toEqual([['new-session', '-d', '-s', 'claude-abc', 'echo hi']])
  })

  test('isAlive simulation via has-session script', async () => {
    const fake = new FakeTmuxRunner()
    fake.scriptExit(0)    // has-session: alive
    fake.scriptExit(1)    // has-session: dead
    const alive = await fake.run(['has-session', '-t', 'claude-x'])
    const dead = await fake.run(['has-session', '-t', 'claude-y'])
    expect(alive.exitCode).toBe(0)
    expect(dead.exitCode).toBe(1)
  })

  test('defaults to exit 0 when nothing scripted', async () => {
    const fake = new FakeTmuxRunner()
    const r = await fake.run(['has-session', '-t', 'whatever'])
    expect(r.exitCode).toBe(0)
  })
})

describe('computeSessionId', () => {
  test('without label matches deriveSessionId', () => {
    const cwd = '/tmp'
    const { sessionId } = computeSessionId(cwd)
    expect(sessionId).toBe(deriveSessionId(cwd))
  })

  test('with label diverges from no-label', () => {
    const cwd = '/tmp'
    const noLabel = computeSessionId(cwd).sessionId
    const labeled = computeSessionId(cwd, 'feat-A').sessionId
    expect(labeled).not.toBe(noLabel)
  })

  test('different labels diverge', () => {
    const cwd = '/tmp'
    expect(computeSessionId(cwd, 'a').sessionId).not.toBe(computeSessionId(cwd, 'b').sessionId)
  })

  test('same label and cwd is deterministic', () => {
    const cwd = '/tmp'
    expect(computeSessionId(cwd, 'x').sessionId).toBe(computeSessionId(cwd, 'x').sessionId)
  })
})

describe('tmuxSessionName', () => {
  test('prefixes session id', () => {
    expect(tmuxSessionName('abc123def456')).toBe('claude-abc123def456')
    expect(TMUX_PREFIX).toBe('claude-')
  })
})

describe('startSpawn', () => {
  test('shells out tmux new-session -d with proxy env, claude command, and cwd cd', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    const name = await startSpawn({
      runner,
      sessionId: 'abc123def456',
      cwd: '/Users/me/proj',
      claudePath: '/Users/me/.local/bin/claude',
    })
    expect(name).toBe('claude-abc123def456')
    expect(runner.calls).toHaveLength(1)
    const argv = runner.calls[0]
    expect(argv.slice(0, 4)).toEqual(['new-session', '-d', '-s', 'claude-abc123def456'])
    const command = argv[4]
    expect(command).toContain("cd '/Users/me/proj'")
    expect(command).toContain(`export http_proxy=${PROXY_ENV.http_proxy}`)
    expect(command).toContain(`export https_proxy=${PROXY_ENV.https_proxy}`)
    expect(command).toContain(`export all_proxy=${PROXY_ENV.all_proxy}`)
    expect(command).toContain('DISCORD_THREAD_ID=auto')
    expect(command).toContain("'/Users/me/.local/bin/claude'")
    expect(command).not.toContain('CLAUDE_SESSION_ID=')
    expect(command).not.toContain('DISCORD_THREAD_NAME=')
  })

  test('with label adds CLAUDE_SESSION_ID and DISCORD_THREAD_NAME with label suffix', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sid12sid12sid',
      cwd: '/tmp/proj',
      label: 'feat-A',
      claudePath: '/usr/bin/claude',
    })
    const command = runner.calls[0][4]
    expect(command).toContain('CLAUDE_SESSION_ID=sid12sid12sid')
    expect(command).toContain('DISCORD_THREAD_NAME=')
    expect(command).toMatch(/DISCORD_THREAD_NAME='[^']*\[feat-A\][^']*'/)
  })

  test('with threadNameOverride uses that name verbatim (sanitized)', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sid1sid1sid1',
      cwd: '/tmp/proj',
      threadNameOverride: 'my custom name',
      claudePath: '/usr/bin/claude',
    })
    const command = runner.calls[0][4]
    expect(command).toContain("DISCORD_THREAD_NAME='my custom name'")
  })

  test('throws when tmux exits non-zero', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(1, '', 'duplicate session: claude-x')
    let err: Error | null = null
    try {
      await startSpawn({
        runner,
        sessionId: 'sid1sid1sid1',
        cwd: '/tmp',
        claudePath: '/usr/bin/claude',
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('duplicate session')
  })

  test('rejects cwd containing shell-unsafe chars', async () => {
    const runner = new FakeTmuxRunner()
    let err: Error | null = null
    try {
      await startSpawn({
        runner,
        sessionId: 'sid1sid1sid1',
        cwd: '/tmp/bad$name',
        claudePath: '/usr/bin/claude',
      })
    } catch (e) { err = e as Error }
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/invalid cwd/i)
    expect(runner.calls).toHaveLength(0)
  })
})

describe('killSpawn', () => {
  test('returns true when tmux kill-session succeeds', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    const ok = await killSpawn(runner, 'claude-x')
    expect(ok).toBe(true)
    expect(runner.calls[0]).toEqual(['kill-session', '-t', 'claude-x'])
  })
  test('returns false when tmux kill-session reports session-not-found', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(1, '', "can't find session: claude-x")
    const ok = await killSpawn(runner, 'claude-x')
    expect(ok).toBe(false)
  })
})

describe('isAlive', () => {
  test('returns true when has-session exits 0', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    expect(await isAlive(runner, 'claude-x')).toBe(true)
  })
  test('returns false when has-session exits non-zero', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(1)
    expect(await isAlive(runner, 'claude-y')).toBe(false)
  })
})
