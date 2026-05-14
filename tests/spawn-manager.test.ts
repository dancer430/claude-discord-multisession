import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type TmuxRunner, FakeTmuxRunner } from '../src/spawn-manager'
import {
  computeSessionId,
  tmuxSessionName,
  startSpawn,
  killSpawn,
  isAlive,
  ensureCwdTrusted,
  ensureMcpJsonServersEnabled,
  classifySpawnPane,
  watchAndDismissSpawnPrompts,
  PROXY_ENV,
  TMUX_PREFIX,
} from '../src/spawn-manager'
import { deriveSessionId } from '../src/session-id'

function tempConfig(initial?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-trust-'))
  const file = join(dir, 'claude.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return file
}

function tempCwd(mcpJson?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mcp-cwd-'))
  if (mcpJson !== undefined) writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcpJson))
  return dir
}

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

  test('label + threadNameOverride: override wins for name; CLAUDE_SESSION_ID still set from label', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sidcombosidcombo'.slice(0, 12),
      cwd: '/tmp/proj',
      label: 'feat-A',
      threadNameOverride: 'my override',
      claudePath: '/usr/bin/claude',
    })
    const command = runner.calls[0][4]
    expect(command).toContain('CLAUDE_SESSION_ID=')
    expect(command).toContain("DISCORD_THREAD_NAME='my override'")
    // override wins for thread_name; label's [feat-A] suffix MUST NOT appear.
    expect(command).not.toMatch(/\[feat-A\]/)
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

  test('with claudeArgs appends shell-escaped args after claudePath, in order', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sidargs1sidar',
      cwd: '/tmp/proj',
      claudePath: '/usr/bin/claude',
      claudeArgs: ['--channels', 'plugin:discord@dancer430-discord'],
    })
    const command = runner.calls[0][4]
    // Each arg lands quoted and ordered after the claudePath. The full tail
    // looks like:  '/usr/bin/claude' '--channels' 'plugin:discord@dancer430-discord'
    expect(command).toMatch(
      /'\/usr\/bin\/claude' '--channels' 'plugin:discord@dancer430-discord'(?:\s|$)/,
    )
  })

  test('with empty claudeArgs leaves the launch line unchanged', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sidempty1sid',
      cwd: '/tmp/proj',
      claudePath: '/usr/bin/claude',
      claudeArgs: [],
    })
    const command = runner.calls[0][4]
    // No trailing args, no stray whitespace before the &&/EOL after the claudePath.
    expect(command).toMatch(/'\/usr\/bin\/claude'\s*$/)
  })

  test('without claudeArgs (undefined) behaves identically to legacy callers', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sidnoneunsid',
      cwd: '/tmp/proj',
      claudePath: '/usr/bin/claude',
    })
    const command = runner.calls[0][4]
    expect(command).toMatch(/'\/usr\/bin\/claude'\s*$/)
  })

  test('shell-escapes args that contain quotes and spaces', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sidescapsidesc',
      cwd: '/tmp/proj',
      claudePath: '/usr/bin/claude',
      // A space inside an arg would break the shell if unescaped; an embedded
      // single-quote would break naive escaping. Both must be safely passed.
      claudeArgs: ["--prompt=hi there", "it's me"],
    })
    const command = runner.calls[0][4]
    // The single-quote-escaping convention used elsewhere is '\'' inside the quoted region.
    expect(command).toContain("'--prompt=hi there'")
    expect(command).toContain("'it'\\''s me'")
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

const BYPASS_PROMPT_PANE = `
────────────────────────────────────────────────────────────────────────────────
  WARNING: Claude Code running in Bypass Permissions mode

  In Bypass Permissions mode, Claude Code will not ask for your approval
  before running potentially dangerous commands.

  ❯ 1. No, exit
    2. Yes, I accept

  Enter to confirm · Esc to cancel
`

const DANGEROUS_PROMPT_PANE = `
────────────────────────────────────────────────────────────────────────────────
  WARNING: Loading development channels

  --dangerously-load-development-channels is for local channel development only.

  Channels: plugin:discord@dancer430-discord

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
`

const READY_PANE = `
╭─── Claude Code v2.1.141 ─────────────────────────────────────────────────────╮
│             Welcome back Some User!                                          │
╰──────────────────────────────────────────────────────────────────────────────╯

  Listening for channel messages from: plugin:discord@dancer430-discord
`

describe('classifySpawnPane', () => {
  test('returns null for empty / pre-render pane', () => {
    expect(classifySpawnPane('')).toBeNull()
    expect(classifySpawnPane('  spinner... \n')).toBeNull()
  })

  test('detects the bypass-permissions warning by both header and option-1 label', () => {
    expect(classifySpawnPane(BYPASS_PROMPT_PANE)).toBe('bypass')
  })

  test('detects the dangerously-load-channels warning', () => {
    expect(classifySpawnPane(DANGEROUS_PROMPT_PANE)).toBe('dangerous')
  })

  test('returns "ready" once the main TUI is visible', () => {
    expect(classifySpawnPane(READY_PANE)).toBe('ready')
  })

  test('does not misclassify a partial render that only mentions "Bypass Permissions" in passing', () => {
    // The main TUI shows a "⏵⏵ bypass permissions on" footer line that
    // includes the phrase but is NOT the warning. We require the option-1
    // text "No, exit" too — without it, we should not call this 'bypass'.
    const noisyReady = READY_PANE + '\n  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    expect(classifySpawnPane(noisyReady)).toBe('ready')
  })
})

describe('watchAndDismissSpawnPrompts', () => {
  // Helper: build a FakeTmuxRunner that returns scripted exit codes / panes
  // for each tmux invocation. Each step represents ONE call to runner.run().
  type Step = { pane: string } | { sent: true } | { fail: true }
  function script(...steps: Step[]): FakeTmuxRunner {
    const runner = new FakeTmuxRunner()
    for (const s of steps) {
      if ('fail' in s) runner.scriptExit(1, '', 'no such session')
      else if ('sent' in s) runner.scriptExit(0, '', '')
      else runner.scriptExit(0, s.pane, '')
    }
    return runner
  }

  const NOOP_OPTS = { pollIntervalMs: 0, maxWaitMs: 5000, sleep: async () => {} }

  test('sends "2" then Enter when both prompts appear in sequence', async () => {
    const runner = script(
      { pane: BYPASS_PROMPT_PANE }, { sent: true },
      { pane: DANGEROUS_PROMPT_PANE }, { sent: true },
      { pane: READY_PANE },
    )
    const sent = await watchAndDismissSpawnPrompts(runner, 'claude-x', { ...NOOP_OPTS, maxPolls: 4 })
    expect(sent).toEqual(['2', 'Enter'])
    expect(runner.calls.filter(c => c[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'claude-x', '2'],
      ['send-keys', '-t', 'claude-x', 'Enter'],
    ])
  })

  test('sends only Enter when bypass is already accepted and only the dangerously-load prompt appears', async () => {
    const runner = script(
      { pane: DANGEROUS_PROMPT_PANE }, { sent: true },
      { pane: READY_PANE },
    )
    const sent = await watchAndDismissSpawnPrompts(runner, 'claude-y', { ...NOOP_OPTS, maxPolls: 3 })
    expect(sent).toEqual(['Enter'])
    expect(runner.calls.filter(c => c[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'claude-y', 'Enter'],
    ])
  })

  test('sends nothing if the main TUI is reached without showing any warning', async () => {
    const runner = script({ pane: READY_PANE })
    const sent = await watchAndDismissSpawnPrompts(runner, 'claude-z', { ...NOOP_OPTS, maxPolls: 2 })
    expect(sent).toEqual([])
    expect(runner.calls.some(c => c[0] === 'send-keys')).toBe(false)
  })

  test('stops polling when capture-pane fails (session died)', async () => {
    const runner = script(
      { pane: BYPASS_PROMPT_PANE }, { sent: true },
      { fail: true },
    )
    const sent = await watchAndDismissSpawnPrompts(runner, 'claude-dead', { ...NOOP_OPTS, maxPolls: 5 })
    expect(sent).toEqual(['2'])
  })

  test('does not double-dismiss: even if the bypass prompt lingers on a later poll, only one "2" goes out', async () => {
    // Simulates the case where the pane still shows the warning on the very
    // next capture (claude hasn't redrawn yet). After we record bypass as
    // dismissed, we must not send "2" again — that would type "2" into the
    // input box once the TUI renders.
    const runner = script(
      { pane: BYPASS_PROMPT_PANE }, { sent: true },
      { pane: BYPASS_PROMPT_PANE },                  // no send this iter
      { pane: READY_PANE },
    )
    const sent = await watchAndDismissSpawnPrompts(runner, 'claude-once', { ...NOOP_OPTS, maxPolls: 5 })
    expect(sent).toEqual(['2'])
  })

  test('respects maxPolls and returns without throwing if no prompt nor ready ever appears', async () => {
    const runner = script(
      { pane: '' }, { pane: '' }, { pane: '' },     // 3 polls of empty pane
    )
    const sent = await watchAndDismissSpawnPrompts(runner, 'claude-idle', { ...NOOP_OPTS, maxPolls: 3 })
    expect(sent).toEqual([])
    // We polled exactly maxPolls times; no send-keys.
    expect(runner.calls.filter(c => c[0] === 'capture-pane')).toHaveLength(3)
    expect(runner.calls.some(c => c[0] === 'send-keys')).toBe(false)
  })
})

describe('ensureCwdTrusted', () => {
  test('creates the file when missing, with minimal trusted project entry', async () => {
    const file = tempConfig()
    rmSync(file, { force: true })
    expect(existsSync(file)).toBe(false)
    await ensureCwdTrusted('/Users/me/repo', file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects['/Users/me/repo'].hasTrustDialogAccepted).toBe(true)
  })

  test('adds entry without touching unrelated top-level keys', async () => {
    const file = tempConfig({ theme: 'light', numStartups: 7, projects: {} })
    await ensureCwdTrusted('/Users/me/repo', file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.theme).toBe('light')
    expect(parsed.numStartups).toBe(7)
    expect(parsed.projects['/Users/me/repo'].hasTrustDialogAccepted).toBe(true)
  })

  test('preserves other existing project entries', async () => {
    const file = tempConfig({
      projects: {
        '/Users/me/other': { hasTrustDialogAccepted: true, lastCost: 1.23 },
      },
    })
    await ensureCwdTrusted('/Users/me/repo', file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects['/Users/me/other'].hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects['/Users/me/other'].lastCost).toBe(1.23)
    expect(parsed.projects['/Users/me/repo'].hasTrustDialogAccepted).toBe(true)
  })

  test('idempotent: no write when already trusted (preserves extra keys)', async () => {
    const file = tempConfig({
      projects: {
        '/Users/me/repo': { hasTrustDialogAccepted: true, lastCost: 9.99 },
      },
    })
    await ensureCwdTrusted('/Users/me/repo', file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects['/Users/me/repo'].hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects['/Users/me/repo'].lastCost).toBe(9.99)
  })

  test('flips false to true while preserving sibling keys on the entry', async () => {
    const file = tempConfig({
      projects: {
        '/Users/me/repo': { hasTrustDialogAccepted: false, allowedTools: ['Edit'] },
      },
    })
    await ensureCwdTrusted('/Users/me/repo', file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects['/Users/me/repo'].hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects['/Users/me/repo'].allowedTools).toEqual(['Edit'])
  })
})

describe('startSpawn calls ensureCwdTrusted', () => {
  test('writes trust entry for cwd before invoking tmux', async () => {
    const file = tempConfig({ projects: {} })
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sid1sid1sid1',
      cwd: '/Users/me/proj',
      claudePath: '/usr/bin/claude',
      claudeConfigPath: file,
    })
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects['/Users/me/proj'].hasTrustDialogAccepted).toBe(true)
    expect(runner.calls).toHaveLength(1)
  })

  test('proceeds with tmux even when trust write throws', async () => {
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    // Point at an unwritable path so ensureCwdTrusted's rename fails — the
    // spawn must still go through.
    await startSpawn({
      runner,
      sessionId: 'sid2sid2sid2',
      cwd: '/Users/me/proj',
      claudePath: '/usr/bin/claude',
      claudeConfigPath: '/nonexistent-dir-spawn-test/.claude.json',
    })
    expect(runner.calls).toHaveLength(1)
  })
})

describe('ensureMcpJsonServersEnabled', () => {
  test('no-op when cwd has no .mcp.json', async () => {
    const cwd = tempCwd()              // no .mcp.json written
    const file = tempConfig({ projects: {} })
    const before = readFileSync(file, 'utf8')
    await ensureMcpJsonServersEnabled(cwd, file)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('no-op when .mcp.json has no mcpServers / empty object', async () => {
    const cwd = tempCwd({})
    const file = tempConfig({ projects: {} })
    const before = readFileSync(file, 'utf8')
    await ensureMcpJsonServersEnabled(cwd, file)
    expect(readFileSync(file, 'utf8')).toBe(before)

    const cwd2 = tempCwd({ mcpServers: {} })
    const before2 = readFileSync(file, 'utf8')
    await ensureMcpJsonServersEnabled(cwd2, file)
    expect(readFileSync(file, 'utf8')).toBe(before2)
  })

  test('creates project entry when missing, listing the .mcp.json server names', async () => {
    const cwd = tempCwd({ mcpServers: { discord: { command: 'bun', args: [] } } })
    const file = tempConfig({ projects: {} })
    await ensureMcpJsonServersEnabled(cwd, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects[cwd].enabledMcpjsonServers).toEqual(['discord'])
    expect(parsed.projects[cwd].disabledMcpjsonServers).toEqual([])
  })

  test('creates ~/.claude.json itself when missing', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {} } })
    const file = tempConfig()
    rmSync(file, { force: true })
    expect(existsSync(file)).toBe(false)
    await ensureMcpJsonServersEnabled(cwd, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects[cwd].enabledMcpjsonServers).toEqual(['discord'])
  })

  test('adds missing names while preserving existing enabled entries', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {}, fs: {} } })
    const file = tempConfig({
      projects: {
        [cwd]: { enabledMcpjsonServers: ['unrelated'], disabledMcpjsonServers: [] },
      },
    })
    await ensureMcpJsonServersEnabled(cwd, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const enabled = new Set(parsed.projects[cwd].enabledMcpjsonServers)
    expect(enabled.has('unrelated')).toBe(true)
    expect(enabled.has('discord')).toBe(true)
    expect(enabled.has('fs')).toBe(true)
  })

  test('idempotent: no write when every name is already enabled', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {} } })
    const file = tempConfig({
      projects: {
        [cwd]: { enabledMcpjsonServers: ['discord'], disabledMcpjsonServers: [] },
      },
    })
    const mtimeBefore = statSync(file).mtimeMs
    // mkdtempSync's filesystem-mtime resolution can be coarse; force a delay
    // bigger than the worst-case (HFS+'s 1-second granularity).
    await new Promise(r => setTimeout(r, 1100))
    await ensureMcpJsonServersEnabled(cwd, file)
    expect(statSync(file).mtimeMs).toBe(mtimeBefore)
  })

  test('moves a previously-disabled server back into enabled', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {} } })
    const file = tempConfig({
      projects: {
        [cwd]: { enabledMcpjsonServers: [], disabledMcpjsonServers: ['discord'] },
      },
    })
    await ensureMcpJsonServersEnabled(cwd, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects[cwd].enabledMcpjsonServers).toEqual(['discord'])
    expect(parsed.projects[cwd].disabledMcpjsonServers).toEqual([])
  })

  test('does not touch unrelated project entries or top-level keys', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {} } })
    const file = tempConfig({
      theme: 'light',
      numStartups: 9,
      projects: {
        '/Users/me/other': { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['foo'] },
      },
    })
    await ensureMcpJsonServersEnabled(cwd, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.theme).toBe('light')
    expect(parsed.numStartups).toBe(9)
    expect(parsed.projects['/Users/me/other'].hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects['/Users/me/other'].enabledMcpjsonServers).toEqual(['foo'])
  })

  test('preserves sibling fields on the project entry (e.g. hasTrustDialogAccepted)', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {} } })
    const file = tempConfig({
      projects: {
        [cwd]: {
          hasTrustDialogAccepted: true,
          allowedTools: ['Edit'],
          lastCost: 4.2,
        },
      },
    })
    await ensureMcpJsonServersEnabled(cwd, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects[cwd].hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects[cwd].allowedTools).toEqual(['Edit'])
    expect(parsed.projects[cwd].lastCost).toBe(4.2)
    expect(parsed.projects[cwd].enabledMcpjsonServers).toEqual(['discord'])
  })
})

describe('startSpawn calls ensureMcpJsonServersEnabled', () => {
  test('enables .mcp.json servers for cwd before invoking tmux', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {} } })
    const file = tempConfig({ projects: {} })
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sidmcpe2e1234',
      cwd,
      claudePath: '/usr/bin/claude',
      claudeConfigPath: file,
    })
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects[cwd].hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects[cwd].enabledMcpjsonServers).toEqual(['discord'])
    expect(runner.calls).toHaveLength(1)
  })

  test('proceeds with tmux even when mcp-enable write throws', async () => {
    const cwd = tempCwd({ mcpServers: { discord: {} } })
    const runner = new FakeTmuxRunner()
    runner.scriptExit(0)
    await startSpawn({
      runner,
      sessionId: 'sidmcpfail1234',
      cwd,
      claudePath: '/usr/bin/claude',
      claudeConfigPath: '/nonexistent-dir-spawn-mcp-test/.claude.json',
    })
    expect(runner.calls).toHaveLength(1)
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
