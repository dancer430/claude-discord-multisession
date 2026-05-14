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

export type SpawnOk = { ok: true; pid: number }
export type SpawnErr = { ok: false; code: 'spawn_failed'; message: string }
export type SpawnResult = SpawnOk | SpawnErr

/**
 * Detached-spawns `claude` (or whatever `command[0]` resolves to) with cwd
 * set, with logs appended to `logPath`, and with `DISCORD_THREAD_ID=auto`
 * + `DISCORD_THREAD_NAME=<threadName>` forced in env. The daemon's idle-exit
 * does not have to wait for the child (`.unref()`).
 *
 * Env composition order: caller's `env` first, then our two thread vars on
 * top — so a hostile caller cannot smuggle a different thread id/name in
 * via `env`.
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
  const finalEnv = {
    ...args.env,
    DISCORD_THREAD_ID: 'auto',
    DISCORD_THREAD_NAME: args.threadName,
  }
  try {
    const child = args.spawn(args.command[0]!, args.command.slice(1), {
      cwd: args.cwd,
      env: finalEnv,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    return { ok: true, pid: child.pid ?? -1 }
  } catch (err) {
    try { closeSync(fd) } catch {}
    return { ok: false, code: 'spawn_failed', message: (err as Error).message }
  }
}
