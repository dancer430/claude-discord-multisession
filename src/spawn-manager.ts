import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { deriveSessionId, deriveThreadName } from './session-id'

export type TmuxResult = { exitCode: number; stdout: string; stderr: string }

/**
 * Abstraction over the `tmux` CLI so unit tests can substitute a fake
 * without shelling out. The real implementation invokes `tmux` from PATH.
 */
export interface TmuxRunner {
  run(args: string[]): Promise<TmuxResult>
}

/**
 * Production TmuxRunner: shells out to `tmux`. Captures stdout/stderr;
 * resolves with the exit code (does NOT throw on non-zero) so callers
 * can branch on `has-session` cleanly.
 */
export class RealTmuxRunner implements TmuxRunner {
  run(args: string[]): Promise<TmuxResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => { stdout += d.toString() })
      child.stderr.on('data', d => { stderr += d.toString() })
      child.on('error', reject)
      child.on('exit', code => resolve({ exitCode: code ?? -1, stdout, stderr }))
    })
  }
}

/**
 * Test double. `calls` records each argv; `scriptExit` queues the exit
 * code for upcoming invocations (FIFO). When the queue is empty, falls
 * back to exit 0.
 */
export class FakeTmuxRunner implements TmuxRunner {
  calls: string[][] = []
  private exits: number[] = []
  private stdouts: string[] = []
  private stderrs: string[] = []

  scriptExit(code: number, stdout = '', stderr = ''): void {
    this.exits.push(code)
    this.stdouts.push(stdout)
    this.stderrs.push(stderr)
  }

  async run(args: string[]): Promise<TmuxResult> {
    this.calls.push(args)
    const exitCode = this.exits.length ? this.exits.shift()! : 0
    const stdout = this.stdouts.length ? this.stdouts.shift()! : ''
    const stderr = this.stderrs.length ? this.stderrs.shift()! : ''
    return { exitCode, stdout, stderr }
  }
}

// ---------------------------------------------------------------------------
// Spawn-manager helpers
// ---------------------------------------------------------------------------

/**
 * Proxy env injected into every spawned `claude` process. Hardcoded by
 * design (per the project owner): every spawn assumes a local proxy at
 * 127.0.0.1:7897. Spawned sessions will fail to reach the network on
 * machines without that proxy — change this constant (or PR a config
 * surface) before deploying anywhere else.
 */
export const PROXY_ENV = {
  http_proxy: 'http://127.0.0.1:7897',
  https_proxy: 'http://127.0.0.1:7897',
  all_proxy: 'socks5://127.0.0.1:7897',
} as const

export const TMUX_PREFIX = 'claude-'

/** Conservative whitelist: alphanumerics, space, `_`, `.`, `-`, `/`. */
const SAFE_CWD = /^[A-Za-z0-9 _.\-/]+$/

function sha12(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

export function tmuxSessionName(sessionId: string): string {
  return TMUX_PREFIX + sessionId
}

/**
 * Build a session_id. Without label: matches deriveSessionId(cwd) so an
 * unlabeled spawn lands on the same key as a manual `claude` launch in
 * the same cwd. With label: sha1(canonical_cwd + ':' + label) so siblings
 * never collide.
 */
export function computeSessionId(cwd: string, label?: string): {
  sessionId: string
  canonicalCwd: string
} {
  let real: string
  try { real = realpathSync(cwd) } catch { real = cwd }
  if (!label) {
    return { sessionId: deriveSessionId(cwd), canonicalCwd: real }
  }
  return { sessionId: sha12(real + ':' + label), canonicalCwd: real }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

export interface SpawnInput {
  runner: TmuxRunner
  sessionId: string
  cwd: string
  label?: string
  threadNameOverride?: string
  claudePath: string
}

/**
 * `tmux new-session -d -s <name> <shell-script>`. Returns the tmux session
 * name on success. Throws with the tmux stderr on non-zero exit. Throws
 * before invoking tmux if cwd contains shell-unsafe characters.
 */
export async function startSpawn(input: SpawnInput): Promise<string> {
  const { runner, sessionId, cwd, label, threadNameOverride, claudePath } = input
  if (!SAFE_CWD.test(cwd)) {
    throw new Error(`invalid cwd: contains characters outside [A-Za-z0-9 _.-/]`)
  }
  const name = tmuxSessionName(sessionId)
  const exports: string[] = [
    `export http_proxy=${PROXY_ENV.http_proxy}`,
    `export https_proxy=${PROXY_ENV.https_proxy}`,
    `export all_proxy=${PROXY_ENV.all_proxy}`,
  ]
  const prefixes: string[] = []
  if (label) {
    prefixes.push(`CLAUDE_SESSION_ID=${sessionId}`)
  }
  let threadName: string | undefined
  if (threadNameOverride) {
    threadName = deriveThreadName(cwd, sessionId, threadNameOverride)
  } else if (label) {
    threadName = deriveThreadName(cwd, sessionId) + ` [${label}]`
  }
  if (threadName) {
    prefixes.push(`DISCORD_THREAD_NAME=${shellEscape(threadName)}`)
  }
  prefixes.push('DISCORD_THREAD_ID=auto')
  const launch = `${prefixes.join(' ')} ${shellEscape(claudePath)}`
  const command = `cd ${shellEscape(cwd)} && ${exports.join(' && ')} && ${launch}`
  const r = await runner.run(['new-session', '-d', '-s', name, command])
  if (r.exitCode !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`)
  }
  return name
}

export async function killSpawn(runner: TmuxRunner, tmuxSession: string): Promise<boolean> {
  const r = await runner.run(['kill-session', '-t', tmuxSession])
  return r.exitCode === 0
}

export async function isAlive(runner: TmuxRunner, tmuxSession: string): Promise<boolean> {
  const r = await runner.run(['has-session', '-t', tmuxSession])
  return r.exitCode === 0
}
