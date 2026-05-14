import { resolve, basename, sep } from 'path'
import type { Access } from './access'

export type SpawnRejectCode =
  | 'not_authorized'
  | 'allowlist_empty'
  | 'path_not_absolute'
  | 'path_not_found'
  | 'path_not_directory'
  | 'path_outside_allowlist'

export type SpawnValidation =
  | { ok: true; cwd: string; threadName: string }
  | { ok: false; code: SpawnRejectCode; message: string }

type StatLike = { isDirectory(): boolean }
type StatFn = (path: string) => StatLike

/**
 * Authorize + canonicalize a spawn request. Pure aside from the injected
 * `statSync`. Rejection codes map 1:1 to the parent-channel error replies
 * (`handleSpawnCommand` formats the message for the user).
 *
 * Allowlist matching is prefix-with-boundary on resolved paths:
 *   allowed root `/root` → accepts `/root` and `/root/*`,
 *                          rejects `/rootEvil`.
 */
export function validateSpawnRequest(args: {
  rawPath: string
  senderId: string
  parentChannelId: string
  access: Access
  statSync: StatFn
  homeDir: string
}): SpawnValidation {
  const { rawPath, senderId, access, statSync, homeDir } = args

  if (!access.allowFrom.includes(senderId)) {
    return { ok: false, code: 'not_authorized', message: `${senderId} not in allowFrom` }
  }

  const roots = access.spawnAllowedRoots ?? []
  if (roots.length === 0) {
    return { ok: false, code: 'allowlist_empty', message: 'spawnAllowedRoots is empty or unset' }
  }

  // ~ expansion.
  let expanded = rawPath
  if (rawPath === '~' || rawPath.startsWith('~/')) {
    expanded = homeDir + rawPath.slice(1)
  }

  if (!expanded.startsWith('/')) {
    return { ok: false, code: 'path_not_absolute', message: `${rawPath} is not an absolute path` }
  }

  const cwd = resolve(expanded)

  // Prefix-with-boundary against each allowed root. A trailing separator
  // is appended to both sides so `/root` doesn't match `/rootEvil`.
  const allowed = roots.some(r => {
    const root = resolve(r)
    if (cwd === root) return true
    const withSep = root.endsWith(sep) ? root : root + sep
    return cwd.startsWith(withSep)
  })
  if (!allowed) {
    return { ok: false, code: 'path_outside_allowlist', message: `${cwd} is not under any spawnAllowedRoots entry` }
  }

  let st: StatLike
  try {
    st = statSync(cwd)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, code: 'path_not_found', message: `${cwd} does not exist` }
    }
    return { ok: false, code: 'path_not_found', message: `${cwd} stat failed: ${(err as Error).message}` }
  }
  if (!st.isDirectory()) {
    return { ok: false, code: 'path_not_directory', message: `${cwd} is not a directory` }
  }

  return { ok: true, cwd, threadName: basename(cwd) }
}

/**
 * Parses a parent-channel message looking for `<trigger> <path>`.
 * Returns `{ rawPath }` on match, `null` otherwise. The path argument is
 * the whole remainder of the line — we do not split on further whitespace,
 * because directories can contain spaces and we'd rather validate later
 * than reject a legitimate path here.
 *
 * Rejects multi-line messages outright: someone pasting a code block that
 * happens to start with the trigger word shouldn't accidentally spawn.
 */
export function parseSpawnCommand(
  content: string,
  trigger: string,
): { rawPath: string } | null {
  if (content.includes('\n')) return null
  const trimmed = content.trim()
  if (!trimmed.startsWith(trigger)) return null
  const rest = trimmed.slice(trigger.length)
  // After the trigger, there MUST be at least one whitespace character —
  // otherwise `起子区abc` would match.
  if (rest.length === 0 || !/^\s/.test(rest)) return null
  const rawPath = rest.trim()
  if (rawPath.length === 0) return null
  return { rawPath }
}

import type { spawn as NodeSpawn } from 'child_process'
import { closeSync } from 'fs'
import type { openSync as NodeOpenSync } from 'fs'
import type { DiscordOps } from './discord-ops'

export type SpawnOk = { ok: true; pid: number }
export type SpawnErr = { ok: false; code: 'spawn_failed'; message: string }
export type SpawnResult = SpawnOk | SpawnErr

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

/**
 * Spawns `claude` inside a detached `tmux new-session -d`. The tmux wrap
 * gives claude a PTY; without one, claude 2.x infers `--print` from a
 * non-TTY stdout and exits with "Input must be provided either through
 * stdin or as a prompt argument when using --print" before it can
 * register with the daemon — see the audit note on this branch.
 *
 * Env handling: `DISCORD_THREAD_ID=auto` and `DISCORD_THREAD_NAME=<name>`
 * are INLINED into the shell command tmux runs, NOT passed via `env`.
 * That keeps the property that a hostile caller's `env` cannot smuggle a
 * different thread id/name in even if tmux's environment passthrough is
 * unexpected (tmux server captures env from its first invocation only).
 *
 * Logs: `tmux new-session -d` daemonizes immediately, so the `logPath` fd
 * only captures tmux's own startup output. The child claude's stdout/stderr
 * live inside the tmux session; attach with `tmux attach -t claude-spawn-…`
 * to inspect. The audit trail in `daemon.log` (`register outcome=...`) is
 * the load-bearing signal for whether the child came up.
 */
export function spawnClaude(args: {
  cwd: string
  threadName: string
  command: string[]
  env: NodeJS.ProcessEnv
  logPath: string
  spawn: typeof NodeSpawn
  openSync: typeof NodeOpenSync
}): SpawnResult {
  let fd: number
  try {
    fd = args.openSync(args.logPath, 'a', 0o600)
  } catch (err) {
    return { ok: false, code: 'spawn_failed', message: `open ${args.logPath} failed: ${(err as Error).message}` }
  }
  try {
    const tmuxSessionName = `claude-spawn-${randomShortId()}`
    const prefixes = [
      'DISCORD_THREAD_ID=auto',
      `DISCORD_THREAD_NAME=${shellEscape(args.threadName)}`,
    ]
    const claudeBin = shellEscape(args.command[0]!)
    const claudeArgsTail = args.command.length > 1
      ? ' ' + args.command.slice(1).map(shellEscape).join(' ')
      : ''
    const launch = `${prefixes.join(' ')} ${claudeBin}${claudeArgsTail}`
    const shellCommand = `cd ${shellEscape(args.cwd)} && ${launch}`
    const child = args.spawn(
      'tmux',
      ['new-session', '-d', '-s', tmuxSessionName, shellCommand],
      {
        cwd: args.cwd,
        env: args.env,
        detached: true,
        stdio: ['ignore', fd, fd],
      },
    )
    child.unref()
    try { closeSync(fd) } catch {}
    return { ok: true, pid: child.pid ?? -1 }
  } catch (err) {
    try { closeSync(fd) } catch {}
    return { ok: false, code: 'spawn_failed', message: (err as Error).message }
  }
}

/**
 * Single-line audit log matching the `logRegister` style in daemon.ts:
 *   `discord daemon: spawn outcome=ok pid=12345 cwd=/root/sub ...`
 * Quoting rules also match: strings with whitespace / `"` get JSON-quoted,
 * empty strings get rendered as `""` to stay visually distinct from
 * unset fields.
 */
export function logSpawn(fields: Record<string, unknown>): void {
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    const needsQuote = typeof v === 'string' && (v === '' || /[\s"]/.test(v))
    parts.push(`${k}=${needsQuote ? JSON.stringify(v) : String(v)}`)
  }
  process.stderr.write(`discord daemon: spawn ${parts.join(' ')}\n`)
}

const REJECT_MESSAGES: Record<SpawnRejectCode, (detail: string) => string> = {
  not_authorized: () => '',   // silent
  allowlist_empty: () => '❌ 启动失败：管理员尚未配置 `spawnAllowedRoots`，spawn 功能未开启',
  path_not_absolute: (d) => `❌ 启动失败：路径必须是绝对路径（${d}）`,
  path_not_found: (d) => `❌ 启动失败：路径不存在 — ${d}`,
  path_not_directory: (d) => `❌ 启动失败：路径不是目录 — ${d}`,
  path_outside_allowlist: (d) => `❌ 启动失败：路径不在 spawnAllowedRoots 白名单内 — ${d}`,
}

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * End-to-end orchestrator: validates the request, posts an ack on the
 * parent channel, spawns the subprocess, posts a follow-up only on
 * failure, and audit-logs the outcome.
 *
 * All side-effecting deps are injected so this is testable without booting
 * discord.js or touching the real filesystem (aside from a stubbed openSync).
 */
export async function handleSpawnCommand(args: {
  rawPath: string
  senderId: string
  parentChannelId: string
  access: Access
  ops: DiscordOps
  command: string[]
  env: NodeJS.ProcessEnv
  stateDir: string
  statSync: StatFn
  spawn: typeof NodeSpawn
  openSync: typeof NodeOpenSync
  log: (fields: Record<string, unknown>) => void
  homeDir: string
}): Promise<void> {
  const validation = validateSpawnRequest({
    rawPath: args.rawPath,
    senderId: args.senderId,
    parentChannelId: args.parentChannelId,
    access: args.access,
    statSync: args.statSync,
    homeDir: args.homeDir,
  })

  if (!validation.ok) {
    args.log({
      outcome: 'err',
      sender_id: args.senderId,
      parent_id: args.parentChannelId,
      raw_path: args.rawPath,
      code: validation.code,
      message: validation.message,
    })
    const text = REJECT_MESSAGES[validation.code](validation.message)
    if (text) await args.ops.reply(args.parentChannelId, text)
    return
  }

  // Ack BEFORE spawn so the user sees we accepted the command even if the
  // subprocess fails to start.
  await args.ops.reply(args.parentChannelId, `🚀 正在为 \`${validation.cwd}\` 启动 Claude…`)

  const logPath = `${args.stateDir}/spawned/spawn-${randomShortId()}.log`
  const result = spawnClaude({
    cwd: validation.cwd,
    threadName: validation.threadName,
    command: args.command,
    env: args.env,
    logPath,
    spawn: args.spawn,
    openSync: args.openSync,
  })

  if (!result.ok) {
    args.log({
      outcome: 'err',
      sender_id: args.senderId,
      parent_id: args.parentChannelId,
      raw_path: args.rawPath,
      cwd: validation.cwd,
      code: result.code,
      message: result.message,
    })
    const hint = result.message.includes('ENOENT')
      ? `（命令未找到。当前: \`${args.command.join(' ')}\`；可通过 env CLAUDE_DISCORD_SPAWN_CMD 覆盖）`
      : ''
    await args.ops.reply(args.parentChannelId, `❌ 启动失败：${result.message}${hint}`)
    return
  }

  args.log({
    outcome: 'ok',
    sender_id: args.senderId,
    parent_id: args.parentChannelId,
    raw_path: args.rawPath,
    cwd: validation.cwd,
    pid: result.pid,
    log_path: logPath,
  })
}
