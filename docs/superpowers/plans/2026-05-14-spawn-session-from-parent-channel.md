# Spawn Claude Session From Parent-Channel Command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authorized Discord user post `起子区 /abs/path` in a parent channel and have the daemon launch a `claude` subprocess in that cwd, which then auto-registers and creates its own thread via the existing shim flow.

**Architecture:** Add `spawnAllowedRoots` / `spawnTrigger` to `access.json`; new `src/spawn-session.ts` module owns parsing, validation, spawning, and orchestration as pure-ish functions with injected deps (so they're unit-testable without booting discord.js). `daemon-entry.ts` becomes a thin wire-up: when a message in an opted-in parent channel matches the trigger, call `handleSpawnCommand`.

**Tech Stack:** TypeScript, Bun (test runner via `bun:test`), discord.js v14, Node `child_process.spawn`, existing `DiscordOps` interface.

**Spec:** `docs/superpowers/specs/2026-05-14-spawn-session-from-parent-channel-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/access.ts` | Modify | Add `spawnAllowedRoots?: string[]` and `spawnTrigger?: string` to `Access`, plumb through `loadAccess` |
| `src/spawn-session.ts` | Create | `parseSpawnCommand`, `validateSpawnRequest`, `spawnClaude`, `logSpawn`, `handleSpawnCommand` — pure functions + orchestrator with injected deps |
| `src/daemon-entry.ts` | Modify | In `messageCreate`, branch to `handleSpawnCommand` for parent-channel trigger messages from opt-in channels |
| `tests/access.test.ts` | Modify | Add roundtrip cases for the two new fields |
| `tests/spawn-session.test.ts` | Create | Unit tests for everything in `spawn-session.ts` |
| `README.md` | Modify | Document `spawnAllowedRoots`, `spawnTrigger`, `CLAUDE_DISCORD_SPAWN_CMD`, security model |

`daemon.ts` is **not** modified — `logSpawn` lives in `spawn-session.ts` next to its only callers. `daemon-shim.integration.test.ts` is **not** modified — the spawn flow is fully covered by unit tests on `handleSpawnCommand` (the daemon-entry side is a 3-line glue, trivial enough to skip integration coverage).

---

### Task 1: Extend `Access` schema with spawn fields

**Files:**
- Modify: `src/access.ts`
- Test: `tests/access.test.ts`

- [ ] **Step 1: Add failing roundtrip test for `spawnAllowedRoots`**

Append to `tests/access.test.ts` inside the `describe('access', () => { ... })` block (after the existing `reactionGuidance is absent when not set` test):

```ts
  test('roundtrips spawnAllowedRoots and spawnTrigger', () => {
    const a: Access = {
      ...defaultAccess(),
      spawnAllowedRoots: ['/Users/me/Projects', '/tmp'],
      spawnTrigger: '/spawn',
    }
    saveAccess(file, a)
    const loaded = loadAccess(file)
    expect(loaded.spawnAllowedRoots).toEqual(['/Users/me/Projects', '/tmp'])
    expect(loaded.spawnTrigger).toBe('/spawn')
  })

  test('spawn fields are absent when not set', () => {
    saveAccess(file, defaultAccess())
    const loaded = loadAccess(file)
    expect(loaded.spawnAllowedRoots).toBeUndefined()
    expect(loaded.spawnTrigger).toBeUndefined()
  })
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test tests/access.test.ts`
Expected: the two new tests fail because `Access` type doesn't have the fields and `loadAccess` doesn't pass them through. Type-check errors are also acceptable failure.

- [ ] **Step 3: Add fields to `Access` type and `loadAccess`**

In `src/access.ts`, inside the `Access` type (just before the closing `}`), add:

```ts
  /**
   * Absolute path prefixes under which `起子区 <path>` in a parent channel
   * may spawn a `claude` subprocess. Prefix-with-boundary matching (so
   * `/Users/me/Projects` allows `/Users/me/Projects/foo` but rejects
   * `/Users/me/ProjectsEvil`). Missing or empty disables the spawn
   * feature entirely.
   */
  spawnAllowedRoots?: string[]
  /**
   * Trigger keyword for the parent-channel spawn command. Defaults to
   * `起子区`. Operator-configurable so English channels can use e.g.
   * `/spawn`.
   */
  spawnTrigger?: string
```

In `loadAccess`, extend the returned object literal to pass both new fields through (right after `askUserQuestionHook: parsed.askUserQuestionHook,`):

```ts
      spawnAllowedRoots: parsed.spawnAllowedRoots,
      spawnTrigger: parsed.spawnTrigger,
```

- [ ] **Step 4: Run tests, confirm green**

Run: `bun test tests/access.test.ts`
Expected: all tests pass, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts tests/access.test.ts
git commit -m "feat(access): add spawnAllowedRoots and spawnTrigger fields"
```

---

### Task 2: `parseSpawnCommand` — pure trigger-line parser

**Files:**
- Create: `src/spawn-session.ts`
- Create: `tests/spawn-session.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/spawn-session.test.ts`:

```ts
import { test, expect, describe } from 'bun:test'
import { parseSpawnCommand } from '../src/spawn-session'

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
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test tests/spawn-session.test.ts`
Expected: module-not-found error or all tests fail.

- [ ] **Step 3: Implement `parseSpawnCommand`**

Create `src/spawn-session.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, confirm green**

Run: `bun test tests/spawn-session.test.ts`
Expected: all 8 `parseSpawnCommand` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/spawn-session.ts tests/spawn-session.test.ts
git commit -m "feat(spawn-session): parseSpawnCommand"
```

---

### Task 3: `validateSpawnRequest` — authorization + path checks

**Files:**
- Modify: `src/spawn-session.ts`
- Modify: `tests/spawn-session.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/spawn-session.test.ts`:

```ts
import { validateSpawnRequest } from '../src/spawn-session'
import { defaultAccess, type Access } from '../src/access'

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
```

- [ ] **Step 2: Run, confirm failures**

Run: `bun test tests/spawn-session.test.ts`
Expected: 12 new validate tests fail; parse tests still pass.

- [ ] **Step 3: Implement `validateSpawnRequest`**

Append to `src/spawn-session.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, confirm green**

Run: `bun test tests/spawn-session.test.ts`
Expected: all parse + validate tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/spawn-session.ts tests/spawn-session.test.ts
git commit -m "feat(spawn-session): validateSpawnRequest"
```

---

### Task 4: `spawnClaude` — wraps `child_process.spawn` with deps injected

**Files:**
- Modify: `src/spawn-session.ts`
- Modify: `tests/spawn-session.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/spawn-session.test.ts`:

```ts
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
      command: ['claude', '--channels', 'plugin:discord@danielfbm-discord'],
      env: { PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080' },
      logPath: '/tmp/spawned-abc.log',
      spawn: spawnStub,
      openSync: openSyncStub,
    })
    expect(r).toEqual({ ok: true, pid: 12345 })
    expect(spawnStub.calls).toHaveLength(1)
    const call = spawnStub.calls[0]
    expect(call.cmd).toBe('claude')
    expect(call.args).toEqual(['--channels', 'plugin:discord@danielfbm-discord'])
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
```

- [ ] **Step 2: Run, confirm failures**

Run: `bun test tests/spawn-session.test.ts`
Expected: 4 new spawn tests fail; earlier tests still pass.

- [ ] **Step 3: Implement `spawnClaude`**

Append to `src/spawn-session.ts`:

```ts
import type { spawn as NodeSpawn } from 'child_process'
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
    return { ok: false, code: 'spawn_failed', message: (err as Error).message }
  }
}
```

- [ ] **Step 4: Run tests, confirm green**

Run: `bun test tests/spawn-session.test.ts`
Expected: every test in the file passes.

- [ ] **Step 5: Commit**

```bash
git add src/spawn-session.ts tests/spawn-session.test.ts
git commit -m "feat(spawn-session): spawnClaude with injected deps"
```

---

### Task 5: `handleSpawnCommand` orchestrator + `logSpawn`

**Files:**
- Modify: `src/spawn-session.ts`
- Modify: `tests/spawn-session.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/spawn-session.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, confirm failures**

Run: `bun test tests/spawn-session.test.ts`
Expected: 6 new orchestrator tests fail; earlier tests pass.

- [ ] **Step 3: Implement `logSpawn` and `handleSpawnCommand`**

Append to `src/spawn-session.ts`:

```ts
import type { DiscordOps } from './discord-ops'

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
    await args.ops.reply(args.parentChannelId, `❌ 启动失败：${result.message}`)
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
```

You will also need to ensure the spawned-log directory exists on disk before `openSync` is called. Add at the top of `handleSpawnCommand`, after the validation passes but before computing `logPath`:

```ts
// (handled by openSync if directory exists — but tests inject openSync, so
// we don't mkdir here; the daemon-entry wire-up creates ~/.claude/.../spawned
// on startup, see Task 6.)
```

(That comment is for the reader; no code change at this point.)

- [ ] **Step 4: Run tests, confirm green**

Run: `bun test tests/spawn-session.test.ts`
Expected: all tests in the file pass.

- [ ] **Step 5: Run the whole test suite to catch regressions**

Run: `bun test`
Expected: all tests pass, no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/spawn-session.ts tests/spawn-session.test.ts
git commit -m "feat(spawn-session): handleSpawnCommand + logSpawn"
```

---

### Task 6: Wire trigger detection into `daemon-entry.ts`

**Files:**
- Modify: `src/daemon-entry.ts`

This task has no new automated test — the helper it calls is fully tested, and the wire-up itself is a few lines of glue against discord.js types. After implementing, verify by typechecking + a short manual smoke note for the operator (Step 4).

- [ ] **Step 1: Add imports and helpers near the top of `daemon-entry.ts`**

In `src/daemon-entry.ts`, after the existing `import { getStateDir } from './state-dir'` line, add:

```ts
import { spawn as nodeSpawn } from 'child_process'
import { openSync, statSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { handleSpawnCommand, logSpawn, parseSpawnCommand } from './spawn-session'
```

Note `mkdirSync` is already imported on the existing `from 'fs'` line — merge rather than duplicate. (`statSync` and `openSync` are new from `fs`; if the existing import line already imports from `fs`, extend it rather than adding a second `import from 'fs'`.)

- [ ] **Step 2: Pre-create the spawned-log directory on daemon startup**

In `runDaemon`, right after the existing `mkdirSync(stateDir, { recursive: true, mode: 0o700 })` call (line ~31), add:

```ts
  mkdirSync(join(stateDir, 'spawned'), { recursive: true, mode: 0o700 })
```

- [ ] **Step 3: Compute the spawn `command` once, near `ops` construction**

After the existing `const ops = new RealDiscordOps(...)` line (around line 66), add:

```ts
  // Operator can override the full `claude` invocation via env. Default
  // matches the README's plugin-install form. Shell-split is intentionally
  // naive (whitespace-only) — operators who need quoting should pre-split.
  const spawnCommand = (process.env.CLAUDE_DISCORD_SPAWN_CMD ?? 'claude --channels plugin:discord@danielfbm-discord')
    .trim()
    .split(/\s+/)
    .filter(s => s.length > 0)
```

- [ ] **Step 4: Branch into spawn handling inside `messageCreate`**

In the `client.on('messageCreate', ...)` handler, after the existing `const access = loadAccess(accessFile)` line (currently used for the permission-reply intercept ~line 107), and BEFORE the `if (access.allowFrom.includes(msg.author.id)) { const m = PERMISSION_REPLY_RE.exec(...) ... }` block, insert:

```ts
      // Spawn-trigger intercept: parent-channel message starting with
      // access.spawnTrigger from an authorized sender. Must early-return
      // so deliverInbound below doesn't also route this into a DM session.
      {
        const isParentChannel = !isDM && !('isThread' in msg.channel && msg.channel.isThread())
        const isOptedIn = isParentChannel && (
          msg.channelId === access.parentChannelId
          || msg.channelId in access.groups
        )
        if (isOptedIn) {
          const m = parseSpawnCommand(msg.content, access.spawnTrigger ?? '起子区')
          if (m) {
            await handleSpawnCommand({
              rawPath: m.rawPath,
              senderId: msg.author.id,
              parentChannelId: msg.channelId,
              access,
              ops,
              command: spawnCommand,
              env: process.env,
              stateDir,
              statSync,
              spawn: nodeSpawn,
              openSync,
              log: logSpawn,
              homeDir: homedir(),
            })
            return
          }
        }
      }
```

- [ ] **Step 5: Typecheck**

Run: `bun --bun tsc --noEmit` (or `bunx tsc --noEmit` if that fails)
Expected: no type errors.

- [ ] **Step 6: Full test run**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 7: Manual smoke note (for the operator)**

Document this in the commit message — no command to run, but note the steps for the operator to validate post-merge:

1. Set `spawnAllowedRoots` in `~/.claude/channels/discord/access.json` to include a real directory you control.
2. From an authorized Discord user, post `起子区 /that/directory` in the configured parent channel.
3. Expect: a `🚀 正在为 ...` reply, followed within a few seconds by a new thread appearing under the parent channel containing the new Claude session's greeting.
4. Negative: post `起子区 /elsewhere`; expect a single `❌ 启动失败：路径不在 spawnAllowedRoots 白名单内 ...` reply and no thread.

- [ ] **Step 8: Commit**

```bash
git add src/daemon-entry.ts
git commit -m "feat(daemon-entry): wire parent-channel spawn trigger

When an authorized user posts \`<trigger> <abs-path>\` in an opted-in
parent channel, the daemon now spawns a \`claude\` subprocess in that
cwd. The subprocess registers via the existing shim flow and creates
its own thread.

Operator validation:
1. Set spawnAllowedRoots in access.json to a real directory.
2. Post \`起子区 /that/directory\` in the parent channel.
3. Confirm a thread appears with the new Claude session's greeting.
4. Negative test: post a path outside the allowlist; expect a single
   error reply and no thread."
```

---

### Task 7: README docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the access.json doc section**

Run: `grep -n "spawnAllowedRoots\|access.json\|parentChannelId" README.md | head -10`
Expected: a section mentioning `access.json` keys.

- [ ] **Step 2: Add documentation for the spawn feature**

Find the section that documents `access.json` fields and append the following just after the existing `parentChannelId` documentation (or, if no such section exists, append a new H2 `## Spawning Claude sessions from Discord` at the end of the file):

```markdown
### Spawning Claude sessions from a parent channel

An authorized user can post `起子区 /abs/path` in the configured parent channel and the daemon will launch a `claude` subprocess in that working directory. The new process auto-registers and creates its own thread; the user never has to open a terminal.

**Configuration in `~/.claude/channels/discord/access.json`:**

- `spawnAllowedRoots: ["/Users/you/Projects"]` — array of absolute path prefixes. **Required** to enable the feature; missing or empty disables it entirely. Matching is prefix-with-boundary, so `/Users/you/Projects` allows `/Users/you/Projects/anything` but rejects `/Users/you/ProjectsEvil`.
- `spawnTrigger: "起子区"` — optional. Defaults to `起子区`. Set to `/spawn` (or any keyword) to change the command word.

**Environment overrides:**

- `CLAUDE_DISCORD_SPAWN_CMD` — overrides the spawn argv. Whitespace-split. Default: `claude --channels plugin:discord@danielfbm-discord`. Use this on dev installs (`claude --dangerously-load-development-channels …`) or to wrap in `tmux` if your `claude` binary requires a TTY.

**Security:**

- Only senders listed in `access.allowFrom` can trigger a spawn.
- Only opted-in parent channels (those added via `/discord:access group add`, or the configured `parentChannelId`) respond to the trigger.
- The daemon never invokes a shell; the path is passed verbatim as `cwd` to `child_process.spawn` and is never concatenated into a command string.
- Relative paths are rejected. `~` is expanded against the daemon's `$HOME`.

**Forensic audit:**

Every spawn attempt writes a single line to `daemon.log`:

```
discord daemon: spawn outcome=ok pid=12345 cwd=/Users/you/Projects/foo ...
discord daemon: spawn outcome=err code=path_outside_allowlist raw_path=/etc ...
```

Subprocess stdout/stderr go to `~/.claude/channels/discord/spawned/spawn-<id>.log`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: spawn-session-from-parent-channel"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run the whole test suite**

Run: `bun test`
Expected: every test passes.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit` (or `bun --bun tsc --noEmit`)
Expected: no type errors.

- [ ] **Step 3: Sanity-grep for placeholders left in code**

Run: `grep -rnE "TODO|TBD|FIXME" src/spawn-session.ts src/daemon-entry.ts`
Expected: no matches.

- [ ] **Step 4: Confirm git tree is clean modulo intended changes**

Run: `git status`
Expected: nothing staged, working tree clean (since each task already committed).

- [ ] **Step 5: Report back to user with the summary of commits**

Run: `git log --oneline -10`
Expected: the new commits from Tasks 1, 2, 3, 4, 5, 6, 7 visible.

---

## Self-review notes

- **Spec coverage:** Every reject code in the spec (`not_authorized`, `allowlist_empty`, `path_not_absolute`, `path_not_found`, `path_not_directory`, `path_outside_allowlist`, `spawn_failed`) has a test. Trigger format, channel opt-in gate, ack-before-spawn ordering, audit log, env override, security defenses — all mapped to a task. The "TTY workaround" stays documentation-only per the spec.
- **Type consistency:** `SpawnRejectCode`, `SpawnValidation`, `SpawnResult`, `handleSpawnCommand` signature — all use the same field names (`rawPath`, `senderId`, `parentChannelId`, `cwd`, `threadName`, `command`, `env`, `stateDir`, `logPath`, `pid`) across tasks 2-6.
- **No placeholders:** Every step has full code or full command text; no "implement appropriate handling" filler.
- **One thing not addressed in the spec but caught here:** the spawned-log directory needs to exist before `openSync('a')` is called. Task 6 Step 2 adds `mkdirSync(stateDir + '/spawned')` on daemon startup so the production flow works; unit tests inject `openSync` and don't care.
