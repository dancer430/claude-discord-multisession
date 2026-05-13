# Spawned-thread MCP tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `create_thread`, `close_thread`, and `list_threads` MCP tools so a manager session can spawn, list, and tear down child Claude sessions in dedicated Discord threads, each running in a detached tmux session.

**Architecture:** A new `spawn-manager` module wraps `tmux` for the daemon. `create_thread` spawns a tmux session running `claude` with `DISCORD_THREAD_ID=auto` plus optional `CLAUDE_SESSION_ID` (for `label` siblings); the existing register handler creates the Discord thread, and a small pending-registration hook in the daemon resolves the in-flight `create_thread` call. `close_thread` does the inverse via `tmux kill-session` + `archiveThread` + `removeBinding`. `list_threads` reads `bindings.json` and decorates with tmux liveness. Bindings persist managed-ness via three new optional fields.

**Tech Stack:** TypeScript (Bun runtime), `bun:test`, existing FakeDiscordOps pattern, `node:child_process` to shell out to `tmux`.

**Spec:** `docs/superpowers/specs/2026-05-13-spawned-thread-mcp-tools-design.md`

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/bindings.ts` | modify | Add 3 optional fields to `BindingEntry`; add `removeBinding` writer. |
| `src/spawn-manager.ts` | create | `TmuxRunner` interface, real & fake; `computeSessionId`, `tmuxSessionName`, `startSpawn`, `killSpawn`, `isAlive`. |
| `src/discord-ops.ts` | modify | Add `archiveThread` to interface + `FakeDiscordOps`. |
| `src/discord-ops-real.ts` | modify | Real `archiveThread` via `thread.setArchived(true)`. |
| `src/protocol.ts` | modify | Extend `ToolCallMsg.name` enum with the three tool names. |
| `src/shim.ts` | modify | Add three tool descriptors to `ListToolsRequestSchema`. |
| `src/daemon.ts` | modify | `DaemonOpts.spawnManager?` injection; `runTool` cases; pending-registration hook; watcher; reconcile. |
| `tests/bindings.test.ts` | modify | Tests for `removeBinding` and schema round-trip. |
| `tests/spawn-manager.test.ts` | create | Tests for `computeSessionId`, `startSpawn` shell composition, `killSpawn`/`isAlive` via fake `TmuxRunner`. |
| `tests/discord-ops.fake.test.ts` | modify | Test `archiveThread` on fake. |
| `tests/daemon-spawn.integration.test.ts` | create | End-to-end create/close/list/watcher/reconcile via fake ops + fake tmux runner. |
| `README.md` | modify | Add `brew install tmux` to prerequisites. |

---

## Task 1: bindings.ts — schema fields + `removeBinding`

**Files:**
- Modify: `src/bindings.ts`
- Modify: `tests/bindings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/bindings.test.ts` inside the `describe('bindings', () => {` block:

```ts
  test('roundtrips managed/tmux_session/label fields', async () => {
    const b: Bindings = {
      sess1: {
        thread_id: 't1',
        cwd: '/a',
        created_at: 100,
        last_seen_at: 200,
        managed: true,
        tmux_session: 'claude-sess1',
        label: 'feat-A',
      },
    }
    await saveBindings(file, b)
    expect(loadBindings(file)).toEqual(b)
  })

  test('removeBinding deletes the entry and preserves others', async () => {
    await upsertBinding(file, 'keep', { thread_id: 't1', cwd: '/a', created_at: 1, last_seen_at: 2 })
    await upsertBinding(file, 'gone', { thread_id: 't2', cwd: '/b', created_at: 3, last_seen_at: 4 })
    await removeBinding(file, 'gone')
    expect(loadBindings(file)).toEqual({
      keep: { thread_id: 't1', cwd: '/a', created_at: 1, last_seen_at: 2 },
    })
  })

  test('removeBinding on missing key is a no-op', async () => {
    await upsertBinding(file, 'keep', { thread_id: 't1', cwd: '/a', created_at: 1, last_seen_at: 2 })
    await removeBinding(file, 'never-existed')
    expect(loadBindings(file)).toEqual({
      keep: { thread_id: 't1', cwd: '/a', created_at: 1, last_seen_at: 2 },
    })
  })
```

Add `removeBinding` to the import at the top:
```ts
import {
  loadBindings,
  saveBindings,
  upsertBinding,
  removeBinding,
  migrateBindingKey,
  type Bindings,
} from '../src/bindings'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bindings.test.ts`
Expected: TypeScript error or test failure — `removeBinding` does not exist; `managed`/`tmux_session`/`label` not on `BindingEntry`.

- [ ] **Step 3: Extend `BindingEntry` and add `removeBinding`**

In `src/bindings.ts`, extend `BindingEntry`:

```ts
export type BindingEntry = {
  thread_id: string
  cwd: string
  created_at: number
  last_seen_at: number
  /**
   * The path that was actually sha1'd to produce this binding's key.
   * Present iff CLAUDE_DISCORD_CWD_REWRITE rewrote `cwd` at register
   * time. Absence implies the legacy contract (key = sha1(cwd)) and
   * doubles as the "this entry has not been migrated yet" marker.
   */
  canonical_cwd?: string
  /** Set iff the binding was authored via create_thread MCP tool. */
  managed?: true
  /** tmux session name (e.g. "claude-<sid>") when a child claude is live. Cleared by reconcile when tmux is gone. */
  tmux_session?: string
  /** Free-form disambiguator passed to create_thread; folded into session_id when present. */
  label?: string
}
```

Add `removeBinding` right after `upsertBinding`:

```ts
/**
 * Delete a single binding entry, preserving everything else on disk.
 * Mirrors upsertBinding's queued load-merge-write under the per-file mutex.
 * No-op if the entry does not exist.
 */
export function removeBinding(file: string, sessionId: string): Promise<void> {
  return enqueue(file, () => {
    const current = loadBindings(file)
    if (!(sessionId in current)) return
    delete current[sessionId]
    writeAtomic(file, JSON.stringify(current, null, 2) + '\n')
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bindings.test.ts`
Expected: all bindings tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bindings.ts tests/bindings.test.ts
git commit -m "feat(bindings): add managed/tmux_session/label fields and removeBinding writer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: TmuxRunner interface + real impl + fake

**Files:**
- Create: `src/spawn-manager.ts` (partial — TmuxRunner only)
- Test: `tests/spawn-manager.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/spawn-manager.test.ts`:

```ts
import { test, expect, describe } from 'bun:test'
import { type TmuxRunner, FakeTmuxRunner } from '../src/spawn-manager'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/spawn-manager.test.ts`
Expected: file-not-found / cannot-resolve-module error.

- [ ] **Step 3: Create `src/spawn-manager.ts` with TmuxRunner and FakeTmuxRunner**

```ts
import { spawn } from 'child_process'

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/spawn-manager.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/spawn-manager.ts tests/spawn-manager.test.ts
git commit -m "feat(spawn-manager): TmuxRunner interface with real and fake impls

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: spawn-manager helpers — `computeSessionId`, `tmuxSessionName`, `startSpawn`, `killSpawn`, `isAlive`

**Files:**
- Modify: `src/spawn-manager.ts`
- Modify: `tests/spawn-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/spawn-manager.test.ts`:

```ts
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

describe('computeSessionId', () => {
  test('without label matches deriveSessionId', () => {
    const cwd = '/tmp'  // realpath /tmp exists everywhere
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
    // No CLAUDE_SESSION_ID when no label.
    expect(command).not.toContain('CLAUDE_SESSION_ID=')
    // No DISCORD_THREAD_NAME when no override or label.
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/spawn-manager.test.ts`
Expected: many failures — `computeSessionId`, `startSpawn`, `killSpawn`, `isAlive`, `PROXY_ENV`, `TMUX_PREFIX` not exported.

- [ ] **Step 3: Implement the spawn-manager helpers**

Append to `src/spawn-manager.ts`:

```ts
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { deriveSessionId, deriveThreadName } from './session-id'

export const PROXY_ENV = {
  http_proxy: 'http://127.0.0.1:7897',
  https_proxy: 'http://127.0.0.1:7897',
  all_proxy: 'socks5://127.0.0.1:7897',
} as const

export const TMUX_PREFIX = 'claude-'

/** Conservative whitelist: same characters deriveThreadName tolerates, plus `/` (already in path). */
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
  // Resolve the thread name override using the existing sanitizer; append
  // [label] for human readability when both are present.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/spawn-manager.test.ts`
Expected: all spawn-manager tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/spawn-manager.ts tests/spawn-manager.test.ts
git commit -m "feat(spawn-manager): add computeSessionId, startSpawn, killSpawn, isAlive

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `DiscordOps.archiveThread`

**Files:**
- Modify: `src/discord-ops.ts`
- Modify: `src/discord-ops-real.ts`
- Modify: `tests/discord-ops.fake.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/discord-ops.fake.test.ts` (inside the existing describe block):

```ts
  test('archiveThread records and marks thread archived', async () => {
    const fake = new FakeDiscordOps()
    const { thread_id } = await fake.createThread('parent-1', 'topic')
    await fake.archiveThread(thread_id)
    expect(fake.calls.some(c => c.kind === 'archiveThread' && c.thread_id === thread_id)).toBe(true)
    expect(fake.isArchived(thread_id)).toBe(true)
  })
```

(If the existing test file does not import `FakeDiscordOps`, add the import as in the file's current pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/discord-ops.fake.test.ts`
Expected: `fake.archiveThread is not a function` / `fake.isArchived is not a function`.

- [ ] **Step 3: Extend interface + fake**

In `src/discord-ops.ts`, add to `DiscordOps` interface:

```ts
  archiveThread(thread_id: string): Promise<void>
```

Add to `FakeDiscordOps` (alongside the other fake methods):

```ts
  private archivedThreads = new Set<string>()

  async archiveThread(thread_id: string) {
    this.calls.push({ kind: 'archiveThread', thread_id })
    this.archivedThreads.add(thread_id)
  }

  isArchived(thread_id: string): boolean {
    return this.archivedThreads.has(thread_id)
  }
```

- [ ] **Step 4: Implement real archiveThread**

In `src/discord-ops-real.ts`, add (next to `createThread`):

```ts
  async archiveThread(thread_id: string): Promise<void> {
    const ch: any = await this.client.channels.fetch(thread_id)
    if (!ch || typeof ch.setArchived !== 'function') {
      throw new Error(`channel ${thread_id} is not an archivable thread`)
    }
    await ch.setArchived(true, 'close_thread')
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/discord-ops.fake.test.ts`
Expected: archive test passes; other tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/discord-ops.ts src/discord-ops-real.ts tests/discord-ops.fake.test.ts
git commit -m "feat(discord-ops): add archiveThread

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: protocol.ts — extend tool name enum

**Files:**
- Modify: `src/protocol.ts`
- Modify: `tests/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/protocol.test.ts`:

```ts
import { parseShimMsg } from '../src/protocol'

test('parseShimMsg accepts new spawn tool names', () => {
  for (const name of ['create_thread', 'close_thread', 'list_threads'] as const) {
    const parsed = parseShimMsg({ type: 'tool_call', id: 1, name, args: {} })
    expect(parsed.type).toBe('tool_call')
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/protocol.test.ts`
Expected: zod validation error (invalid enum value).

- [ ] **Step 3: Extend the enum**

In `src/protocol.ts`, change:

```ts
  name: z.enum(['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment']),
```

to:

```ts
  name: z.enum([
    'reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment',
    'create_thread', 'close_thread', 'list_threads',
  ]),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/protocol.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts tests/protocol.test.ts
git commit -m "feat(protocol): allow create_thread/close_thread/list_threads tool names

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: shim.ts — expose three new tool descriptors

**Files:**
- Modify: `src/shim.ts`

- [ ] **Step 1: Add the three tool descriptors**

In `src/shim.ts`, locate the `tools: [` array inside `mcp.setRequestHandler(ListToolsRequestSchema, ...)`. Append three entries after the existing `fetch_messages` descriptor:

```ts
    {
      name: 'create_thread',
      description: 'Spawn a new Claude Code session in the given cwd, paired to a freshly created Discord thread. The spawned claude runs inside a detached tmux session named claude-<session_id>. Returns thread_id/thread_url/tmux_session/session_id.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Absolute path to the project directory the spawned claude should run in.' },
          label: { type: 'string', description: 'Optional disambiguator when you want multiple sessions in the same cwd.' },
          thread_name: { type: 'string', description: 'Override the auto-derived thread name.' },
        },
        required: ['cwd'],
      },
    },
    {
      name: 'close_thread',
      description: 'Tear down a managed thread: kill its tmux session, archive the Discord thread, remove the binding. Pass thread_id OR cwd (with optional label).',
      inputSchema: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          cwd: { type: 'string' },
          label: { type: 'string' },
        },
      },
    },
    {
      name: 'list_threads',
      description: 'List all managed (create_thread-spawned) sessions with cwd, tmux liveness, and Discord thread metadata.',
      inputSchema: { type: 'object', properties: {} },
    },
```

- [ ] **Step 2: Verify the shim type-checks and lists three new tools**

Run: `bun test tests/daemon-shim.integration.test.ts`
Expected: still green (no behavior change yet — daemon side returns "unknown tool" until Task 7).

If the integration test enumerates expected tools, leave it; if it asserts a fixed count, adjust the assertion.

- [ ] **Step 3: Commit**

```bash
git add src/shim.ts
git commit -m "feat(shim): expose create_thread/close_thread/list_threads tool descriptors

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Daemon scaffold — `spawnManager` injection + runTool cases returning "not_implemented"

**Files:**
- Modify: `src/daemon.ts`

This task wires the surface area into the daemon so Task 8/9/10/11/12 can fill in real behavior. The three new tool cases each return a structured "not_implemented" error so manual end-to-end smoke is possible immediately.

- [ ] **Step 1: Add DaemonOpts.spawnManager injection**

At the top of `src/daemon.ts`, add imports:

```ts
import {
  type TmuxRunner,
  RealTmuxRunner,
} from './spawn-manager'
```

Extend `DaemonOpts`:

```ts
export type DaemonOpts = {
  stateDir: string
  ops: DiscordOps
  idleExitMs: number
  /** Injectable tmux runner; defaults to RealTmuxRunner. Tests pass FakeTmuxRunner. */
  tmuxRunner?: TmuxRunner
  /** Override the claude binary path used by create_thread spawn. Defaults to 'claude' from PATH. */
  claudePath?: string
  onShutdown?: () => void | Promise<void>
}
```

Inside `startDaemon`, near the top:

```ts
  const tmuxRunner: TmuxRunner = opts.tmuxRunner ?? new RealTmuxRunner()
  const claudePath = opts.claudePath ?? 'claude'
```

- [ ] **Step 2: Add three runTool cases returning structured "not_implemented"**

In `runTool`'s switch, before `default:`, add:

```ts
        case 'create_thread':
        case 'close_thread':
        case 'list_threads':
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'not_implemented', tool: name }) }],
            isError: true,
          }
```

- [ ] **Step 3: Smoke run the daemon tests to ensure nothing broke**

Run: `bun test`
Expected: every existing test still green.

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "feat(daemon): scaffold spawnManager injection and create/close/list_threads stubs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Daemon `create_thread` — pending-registration hook + full happy path

**Files:**
- Modify: `src/daemon.ts`
- Create: `tests/daemon-spawn.integration.test.ts`

This is the largest task. It introduces the pending-registration plumbing that's reused by the watcher/reconcile tasks.

- [ ] **Step 1: Write the failing integration test**

Create `tests/daemon-spawn.integration.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection, type Socket } from 'net'
import { startDaemon, type DaemonHandle } from '../src/daemon'
import { FakeDiscordOps } from '../src/discord-ops'
import { FakeTmuxRunner, tmuxSessionName, computeSessionId } from '../src/spawn-manager'
import { writeFrame, readFrames } from '../src/framing'
import { loadBindings } from '../src/bindings'

let dir: string
let daemon: DaemonHandle | null = null
const sockets: Socket[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-spawn-'))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
    parentChannelId: 'parent-123',
  }))
})
afterEach(async () => {
  for (const s of sockets) { try { s.destroy() } catch {} }
  sockets.length = 0
  if (daemon) { await daemon.shutdown(); daemon = null }
  rmSync(dir, { recursive: true, force: true })
})

async function connect(sockPath: string): Promise<Socket> {
  const s = await new Promise<Socket>((res, rej) => {
    const c = createConnection(sockPath)
    c.once('connect', () => res(c)); c.once('error', rej)
  })
  sockets.push(s); return s
}
function frameIt(sock: Socket) { return readFrames(sock)[Symbol.asyncIterator]() as AsyncIterator<unknown> }
async function recv(it: AsyncIterator<unknown>): Promise<any> {
  const { value, done } = await it.next()
  if (done) throw new Error('iterator ended unexpectedly')
  return value
}

/** Helper: register as a DM session so we can issue tool_calls. */
async function registerDm(sockPath: string, session_id: string): Promise<{ sock: Socket; it: AsyncIterator<unknown> }> {
  const sock = await connect(sockPath)
  const it = frameIt(sock)
  writeFrame(sock, { type: 'register', id: 1, session_id, mode: 'dm', cwd: '/tmp' })
  const ack = await recv(it)
  expect(ack.type).toBe('register_ack')
  return { sock, it }
}

/** Helper: simulate the child shim that create_thread spawns. */
async function simulateChildRegister(sockPath: string, session_id: string, cwd: string): Promise<{ sock: Socket; it: AsyncIterator<unknown>; ack: any }> {
  const sock = await connect(sockPath)
  const it = frameIt(sock)
  writeFrame(sock, { type: 'register', id: 1, session_id, mode: 'thread', cwd, thread_id: 'auto' })
  const ack = await recv(it)
  return { sock, it, ack }
}

describe('daemon: create_thread happy path', () => {
  test('spawns tmux, child registers via auto, returns thread info, binding becomes managed', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    // tmux new-session succeeds; later isAlive checks return 0 (alive).
    tmuxRunner.scriptExit(0)
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')

    // Manager session.
    const mgr = await registerDm(sockPath, 'mgr-session')

    // Pre-compute the expected child session_id so the test can drive the
    // child's register synchronously.
    const cwd = '/tmp'
    const { sessionId: childSid } = computeSessionId(cwd)

    // Fire create_thread (manager → daemon).
    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd } })

    // The daemon spawns tmux, then awaits child registration. Simulate the
    // child connecting + registering with thread_id=auto.
    // Small delay so the daemon's tmux scriptExit is consumed first.
    await new Promise(r => setTimeout(r, 10))
    const child = await simulateChildRegister(sockPath, childSid, cwd)
    expect(child.ack.type).toBe('register_ack')
    expect(child.ack.thread_id).toBeTruthy()
    const newThreadId = child.ack.thread_id

    // Now create_thread should resolve.
    const result = await recv(mgr.it)
    expect(result.type).toBe('tool_result')
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text)
    expect(payload.thread_id).toBe(newThreadId)
    expect(payload.tmux_session).toBe(tmuxSessionName(childSid))
    expect(payload.session_id).toBe(childSid)

    // Binding on disk has managed + tmux_session.
    const bindings = loadBindings(join(dir, 'bindings.json'))
    expect(bindings[childSid].managed).toBe(true)
    expect(bindings[childSid].tmux_session).toBe(tmuxSessionName(childSid))

    // tmux runner saw the new-session call.
    expect(tmuxRunner.calls[0].slice(0, 3)).toEqual(['new-session', '-d', '-s'])
  })

  test('rejects when access.parentChannelId is unset', async () => {
    // Overwrite access.json to drop parentChannelId.
    writeFileSync(join(dir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
    }))
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-2')

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd: '/tmp' } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('create_thread_parent_unset')
    // tmux must NOT have been invoked.
    expect(tmuxRunner.calls).toHaveLength(0)
  })

  test('rejects when tmux fails; no binding written, no thread created', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    tmuxRunner.scriptExit(1, '', 'tmux: unable to start')
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-3')

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd: '/tmp' } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('create_thread_spawn_failed')

    expect(loadBindings(join(dir, 'bindings.json'))).toEqual({})
    expect(ops.calls.some(c => c.kind === 'createThread')).toBe(false)
  })

  test('rejects when binding already exists and tmux alive (already_running)', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-4')

    // Seed an existing managed binding.
    const cwd = '/tmp'
    const { sessionId } = computeSessionId(cwd)
    const tmuxSession = tmuxSessionName(sessionId)
    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      [sessionId]: { thread_id: 't-old', cwd, created_at: 1, last_seen_at: 2, managed: true, tmux_session: tmuxSession },
    }))
    // First call: pre-check isAlive → alive (exit 0).
    tmuxRunner.scriptExit(0)
    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('create_thread_already_running')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/daemon-spawn.integration.test.ts`
Expected: failures — `not_implemented` returned, or pending hook missing.

- [ ] **Step 3: Add the pending-registration map + hook in the register handler**

In `src/daemon.ts`, near the other top-level daemon state in `startDaemon` (around where `sessions`, `threadIndex` are declared), add:

```ts
  type PendingSpawn = {
    resolve: (binding: { thread_id: string; thread_name?: string; thread_url?: string }) => void
    reject: (err: Error) => void
  }
  const spawnPending = new Map<string, PendingSpawn>()
```

Find the **success site** of thread-mode register (the line that calls `writeFrame(sock, { type: 'register_ack', ... thread_id: threadId })` for thread mode, near line ~543). Immediately after the `committed = true` assignment in that block, add:

```ts
            // Pending spawn-flow promise resolves here so create_thread can
            // patch the just-persisted binding with managed/tmux_session.
            const pending = spawnPending.get(msg.session_id)
            if (pending) {
              spawnPending.delete(msg.session_id)
              const persisted = loadBindings(bindingsFile)[msg.session_id]
              pending.resolve({
                thread_id: threadId,
                thread_name: persisted?.canonical_cwd, // placeholder — see hook arg below
                thread_url: undefined,
              })
            }
```

Wait — the daemon doesn't currently capture thread_name/thread_url from `ops.createThread`. We need to surface them through the register flow. Update the `auto` branch (around line 408) to remember the `ThreadInfo` returned by `ops.createThread`:

In the `auto`-branch fresh-create block, replace:

```ts
                  const t = await ops.createThread(access.parentChannelId, name)
                  threadId = t.thread_id
```

with:

```ts
                  const t = await ops.createThread(access.parentChannelId, name)
                  threadId = t.thread_id
                  freshThreadInfo = t  // captured for the spawn-pending hook below
```

And declare `let freshThreadInfo: { thread_id: string; thread_name?: string; thread_url?: string } | null = null` above the `try` block, alongside the other per-register locals (next to `let reservedThreadId`, etc.).

Then change the spawnPending block to use `freshThreadInfo` (and fall back to a `bindings.json` re-read for explicit-thread_id and reuse paths):

```ts
            const pending = spawnPending.get(msg.session_id)
            if (pending) {
              spawnPending.delete(msg.session_id)
              pending.resolve({
                thread_id: threadId,
                thread_name: freshThreadInfo?.thread_name,
                thread_url: freshThreadInfo?.thread_url,
              })
            }
```

(For the create_thread flow this is always the `auto` path, so `freshThreadInfo` will be set.)

- [ ] **Step 4: Add a helper for the create_thread logic**

Inside `startDaemon`, after the `runTool` declaration, add a private helper:

```ts
  async function handleCreateThread(args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const cwd = String(args.cwd ?? '')
    const label = args.label !== undefined ? String(args.label) : undefined
    const threadNameOverride = args.thread_name !== undefined ? String(args.thread_name) : undefined
    if (!cwd) return errText('create_thread_invalid_cwd', 'cwd is required')

    // Validate cwd exists and is a directory.
    try {
      const { statSync } = await import('fs')
      const st = statSync(cwd)
      if (!st.isDirectory()) return errText('create_thread_invalid_cwd', `${cwd} is not a directory`)
    } catch (e) {
      return errText('create_thread_invalid_cwd', `${cwd}: ${String((e as Error).message)}`)
    }

    const access = loadAccess(accessFile)
    if (!access.parentChannelId) {
      return errText('create_thread_parent_unset', 'access.parentChannelId is not set')
    }

    const { computeSessionId, tmuxSessionName, startSpawn, killSpawn, isAlive } = await import('./spawn-manager')
    const { sessionId } = computeSessionId(cwd, label)
    const tmuxSession = tmuxSessionName(sessionId)
    const bindings = loadBindings(bindingsFile)
    const existing = bindings[sessionId]
    if (existing?.managed && existing.tmux_session) {
      if (await isAlive(tmuxRunner, existing.tmux_session)) {
        return errText('create_thread_already_running', `binding for ${sessionId} already alive in ${existing.tmux_session}`)
      }
      // Stale managed binding — clear tmux_session before continuing.
      await upsertBinding(bindingsFile, sessionId, { ...existing, tmux_session: undefined })
    } else if (existing && !existing.managed) {
      return errText('create_thread_cwd_has_manual_session', `non-managed binding exists for ${cwd}; pass a label to disambiguate`)
    }

    // Register a pending entry BEFORE invoking tmux so a fast child cannot
    // beat us to the hook.
    const registered = new Promise<{ thread_id: string; thread_name?: string; thread_url?: string }>((resolve, reject) => {
      spawnPending.set(sessionId, { resolve, reject })
    })

    try {
      await startSpawn({ runner: tmuxRunner, sessionId, cwd, label, threadNameOverride, claudePath })
    } catch (e) {
      spawnPending.delete(sessionId)
      return errText('create_thread_spawn_failed', String((e as Error).message))
    }

    let info: { thread_id: string; thread_name?: string; thread_url?: string }
    try {
      info = await Promise.race([
        registered,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('register timed out')), 30_000)),
      ])
    } catch {
      spawnPending.delete(sessionId)
      await killSpawn(tmuxRunner, tmuxSession)
      return errText('create_thread_register_timeout', 'child claude did not register within 30s')
    }

    // Patch the just-persisted binding to mark it managed.
    const fresh = loadBindings(bindingsFile)[sessionId]
    if (fresh) {
      await upsertBinding(bindingsFile, sessionId, {
        ...fresh,
        managed: true,
        tmux_session: tmuxSession,
        ...(label ? { label } : {}),
      })
    }

    return okJson({
      session_id: sessionId,
      thread_id: info.thread_id,
      thread_name: info.thread_name,
      thread_url: info.thread_url,
      tmux_session: tmuxSession,
      cwd,
      label,
    })
  }

  function errText(code: string, message: string) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }) }], isError: true }
  }
  function okJson(obj: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] }
  }
```

Replace the `case 'create_thread':` arm in `runTool` (currently returning `not_implemented`) with:

```ts
        case 'create_thread':
          return await handleCreateThread(args)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "create_thread"`
Expected: all `create_thread` integration tests pass.

If the "happy path" test races (child registers before `spawnPending.set`), add a tiny lead time in the test (already done — 10 ms sleep). If still flaky, increase to 50 ms.

- [ ] **Step 6: Run full test suite to catch regressions**

Run: `bun test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts tests/daemon-spawn.integration.test.ts
git commit -m "feat(daemon): implement create_thread with pending-registration hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Daemon `close_thread`

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-spawn.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/daemon-spawn.integration.test.ts`:

```ts
describe('daemon: close_thread', () => {
  async function seedManaged(opts: {
    ops: FakeDiscordOps
    sessionId: string
    threadId: string
    cwd: string
    tmuxSession: string
  }) {
    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      [opts.sessionId]: {
        thread_id: opts.threadId,
        cwd: opts.cwd,
        created_at: 1,
        last_seen_at: 2,
        managed: true,
        tmux_session: opts.tmuxSession,
      },
    }))
  }

  test('close by thread_id kills tmux, archives thread, removes binding', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-c1')

    const sessionId = 'sid-close-1'
    await seedManaged({ ops, sessionId, threadId: 't-1', cwd: '/tmp', tmuxSession: 'claude-' + sessionId })

    tmuxRunner.scriptExit(0)  // kill-session ok
    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'close_thread', args: { thread_id: 't-1' } })
    const result = await recv(mgr.it)
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0].text)).toEqual({ closed: 't-1' })

    expect(ops.isArchived('t-1')).toBe(true)
    expect(loadBindings(join(dir, 'bindings.json'))).toEqual({})
    expect(tmuxRunner.calls.some(c => c[0] === 'kill-session' && c[2] === 'claude-' + sessionId)).toBe(true)
  })

  test('close by cwd resolves via computeSessionId', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-c2')

    const cwd = '/tmp'
    const { sessionId } = computeSessionId(cwd)
    await seedManaged({ ops, sessionId, threadId: 't-2', cwd, tmuxSession: tmuxSessionName(sessionId) })

    tmuxRunner.scriptExit(0)
    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'close_thread', args: { cwd } })
    const result = await recv(mgr.it)
    expect(result.isError).toBeFalsy()
    expect(ops.isArchived('t-2')).toBe(true)
  })

  test('close refuses non-managed bindings', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-c3')

    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      'sid-manual': { thread_id: 't-manual', cwd: '/tmp', created_at: 1, last_seen_at: 2 },
    }))
    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'close_thread', args: { thread_id: 't-manual' } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('close_thread_unmanaged')
  })

  test('close not_found when target missing', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-c4')

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'close_thread', args: { thread_id: 't-ghost' } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('close_thread_not_found')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "close_thread"`
Expected: failures (returns `not_implemented`).

- [ ] **Step 3: Implement `handleCloseThread`**

Add to `startDaemon`, alongside `handleCreateThread`:

```ts
  async function handleCloseThread(args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const { computeSessionId, killSpawn } = await import('./spawn-manager')
    const { removeBinding } = await import('./bindings')

    const threadIdArg = args.thread_id !== undefined ? String(args.thread_id) : undefined
    const cwdArg = args.cwd !== undefined ? String(args.cwd) : undefined
    const labelArg = args.label !== undefined ? String(args.label) : undefined

    const bindings = loadBindings(bindingsFile)
    let sessionId: string | undefined
    let entry: typeof bindings[string] | undefined

    if (threadIdArg) {
      for (const [k, v] of Object.entries(bindings)) {
        if (v.thread_id === threadIdArg) { sessionId = k; entry = v; break }
      }
    } else if (cwdArg) {
      const computed = computeSessionId(cwdArg, labelArg).sessionId
      sessionId = computed
      entry = bindings[computed]
    } else {
      return errText('close_thread_not_found', 'must pass thread_id or cwd')
    }

    if (!entry) return errText('close_thread_not_found', 'no binding matches the target')
    if (!entry.managed) return errText('close_thread_unmanaged', 'binding is not managed; cannot close via close_thread')

    if (entry.tmux_session) {
      await killSpawn(tmuxRunner, entry.tmux_session)
    }
    try {
      await ops.archiveThread(entry.thread_id)
    } catch (e) {
      process.stderr.write(`close_thread: archiveThread failed for ${entry.thread_id}: ${String((e as Error).message)}\n`)
    }
    await removeBinding(bindingsFile, sessionId!)

    // Clean in-memory routing for the just-closed session.
    threadIndex.delete(entry.thread_id)
    sessions.delete(sessionId!)

    return okJson({ closed: entry.thread_id })
  }
```

Replace the `case 'close_thread':` arm with:

```ts
        case 'close_thread':
          return await handleCloseThread(args)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "close_thread"`
Expected: all close_thread tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon-spawn.integration.test.ts
git commit -m "feat(daemon): implement close_thread

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Daemon `list_threads`

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-spawn.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/daemon-spawn.integration.test.ts`:

```ts
describe('daemon: list_threads', () => {
  test('lists only managed bindings with tmux_alive decoration', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-l1')

    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      'sid-managed-alive': {
        thread_id: 't-a', cwd: '/tmp/a', created_at: 100, last_seen_at: 200,
        managed: true, tmux_session: 'claude-sid-managed-alive', label: 'feat-A',
      },
      'sid-managed-dead': {
        thread_id: 't-b', cwd: '/tmp/b', created_at: 50, last_seen_at: 150,
        managed: true, tmux_session: 'claude-sid-managed-dead',
      },
      'sid-manual': {
        thread_id: 't-c', cwd: '/tmp/c', created_at: 10, last_seen_at: 20,
      },
    }))
    // Two isAlive calls; first alive, second dead.
    tmuxRunner.scriptExit(0)
    tmuxRunner.scriptExit(1)

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'list_threads', args: {} })
    const result = await recv(mgr.it)
    expect(result.isError).toBeFalsy()
    const arr = JSON.parse(result.content[0].text) as any[]
    expect(arr).toHaveLength(2)
    // Sorted by created_at desc → managed-alive (100) before managed-dead (50).
    expect(arr[0].session_id).toBe('sid-managed-alive')
    expect(arr[0].tmux_alive).toBe(true)
    expect(arr[0].label).toBe('feat-A')
    expect(arr[1].session_id).toBe('sid-managed-dead')
    expect(arr[1].tmux_alive).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "list_threads"`
Expected: failures (returns `not_implemented`).

- [ ] **Step 3: Implement `handleListThreads`**

Add to `startDaemon`:

```ts
  async function handleListThreads(): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const { isAlive } = await import('./spawn-manager')
    const bindings = loadBindings(bindingsFile)
    const rows: Array<{
      session_id: string
      thread_id: string
      cwd: string
      label?: string
      tmux_session?: string
      tmux_alive: boolean
      created_at: number
    }> = []
    for (const [sid, b] of Object.entries(bindings)) {
      if (b.managed !== true) continue
      const alive = b.tmux_session ? await isAlive(tmuxRunner, b.tmux_session) : false
      rows.push({
        session_id: sid,
        thread_id: b.thread_id,
        cwd: b.cwd,
        label: b.label,
        tmux_session: b.tmux_session,
        tmux_alive: alive,
        created_at: b.created_at,
      })
    }
    rows.sort((a, b) => b.created_at - a.created_at)
    return okJson(rows)
  }
```

Replace the `case 'list_threads':` arm with:

```ts
        case 'list_threads':
          return await handleListThreads()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "list_threads"`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon-spawn.integration.test.ts
git commit -m "feat(daemon): implement list_threads

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Natural-exit watcher

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-spawn.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/daemon-spawn.integration.test.ts`:

```ts
describe('daemon: natural-exit watcher', () => {
  test('posts [session exited] and clears tmux_session when isAlive flips to false', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    // Seed a managed binding; watcher polls and gets exit=1 (dead).
    daemon = await startDaemon({
      stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner,
      watcherIntervalMs: 20,  // tight loop for tests
    })
    const sessionId = 'sid-watch'
    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      [sessionId]: {
        thread_id: 't-watch', cwd: '/tmp/w', created_at: 1, last_seen_at: 2,
        managed: true, tmux_session: 'claude-' + sessionId,
      },
    }))
    // Reload bindings into daemon's watch set: the daemon's reconcile runs
    // at startup (Task 12). For this test, simulate by setting tmuxRunner
    // to return alive on the first poll then dead on the second.
    tmuxRunner.scriptExit(0)  // startup reconcile sees alive
    tmuxRunner.scriptExit(1)  // first watcher tick sees dead

    // Wait long enough for one watcher tick.
    await new Promise(r => setTimeout(r, 80))

    // archiveThread NOT called (watcher does NOT auto-close); reply IS called.
    expect(ops.calls.some(c => c.kind === 'archiveThread')).toBe(false)
    expect(ops.calls.some(c => c.kind === 'reply' && c.chat_id === 't-watch' && String(c.text).includes('[session exited]'))).toBe(true)
    const after = loadBindings(join(dir, 'bindings.json'))[sessionId]
    expect(after.managed).toBe(true)
    expect(after.tmux_session).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "watcher"`
Expected: failure — `watcherIntervalMs` not in DaemonOpts; no watcher exists.

- [ ] **Step 3: Add watcher to DaemonOpts and startDaemon**

Extend `DaemonOpts`:

```ts
  /** Test hook: poll interval (ms) for the natural-exit watcher. Default 5_000. */
  watcherIntervalMs?: number
```

Inside `startDaemon`, near where `idleTimer` is set up, add:

```ts
  const watcherIntervalMs = opts.watcherIntervalMs ?? 5_000
  const watchSet = new Set<string>()  // session_ids whose tmux we believe is alive

  async function reconcileOnStartup(): Promise<void> {
    const { isAlive } = await import('./spawn-manager')
    const bindings = loadBindings(bindingsFile)
    for (const [sid, b] of Object.entries(bindings)) {
      if (b.managed !== true || !b.tmux_session) continue
      if (await isAlive(tmuxRunner, b.tmux_session)) {
        watchSet.add(sid)
      } else {
        await upsertBinding(bindingsFile, sid, { ...b, tmux_session: undefined })
      }
    }
  }

  async function watcherTick(): Promise<void> {
    const { isAlive } = await import('./spawn-manager')
    const bindings = loadBindings(bindingsFile)
    for (const sid of Array.from(watchSet)) {
      const b = bindings[sid]
      if (!b || !b.managed || !b.tmux_session) {
        watchSet.delete(sid)
        continue
      }
      if (!(await isAlive(tmuxRunner, b.tmux_session))) {
        watchSet.delete(sid)
        try { await ops.reply(b.thread_id, '[session exited]') }
        catch (e) { process.stderr.write(`watcher: reply failed for ${b.thread_id}: ${String((e as Error).message)}\n`) }
        await upsertBinding(bindingsFile, sid, { ...b, tmux_session: undefined })
        process.stderr.write(`discord daemon: session_exited session_id=${sid} thread_id=${b.thread_id}\n`)
      }
    }
  }

  await reconcileOnStartup()
  const watchTimer = setInterval(() => { void watcherTick() }, watcherIntervalMs)
  watchTimer.unref?.()
```

After the existing `shutdown()` body, ensure `clearInterval(watchTimer)` is called (add a line near `if (idleTimer) clearTimeout(idleTimer)`).

Also extend `create_thread` to add the new session_id into `watchSet` after the binding is patched. At the end of `handleCreateThread`, right before the final `return okJson(...)`:

```ts
    watchSet.add(sessionId)
```

And `close_thread` should remove it:

```ts
    watchSet.delete(sessionId!)
```

(Placed right before the final `return okJson({ closed: ... })`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "watcher"`
Expected: pass.

If flaky, increase the test sleep from 80ms to 200ms.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts tests/daemon-spawn.integration.test.ts
git commit -m "feat(daemon): add natural-exit watcher for managed tmux sessions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Daemon-startup reconcile (covered partly by Task 11)

Task 11 already added `reconcileOnStartup`, but did not add a dedicated test asserting the "alive entry registered + dead entry tmux_session cleared" behavior in isolation. This task locks that in.

**Files:**
- Modify: `tests/daemon-spawn.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/daemon-spawn.integration.test.ts`:

```ts
describe('daemon: startup reconcile', () => {
  test('alive managed binding stays watched; dead one has tmux_session cleared', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      'sid-alive': {
        thread_id: 't-alive', cwd: '/tmp/a', created_at: 1, last_seen_at: 2,
        managed: true, tmux_session: 'claude-sid-alive',
      },
      'sid-dead': {
        thread_id: 't-dead', cwd: '/tmp/d', created_at: 1, last_seen_at: 2,
        managed: true, tmux_session: 'claude-sid-dead',
      },
    }))
    // Reconcile pings has-session once per managed entry: alive first, dead next.
    tmuxRunner.scriptExit(0)
    tmuxRunner.scriptExit(1)

    daemon = await startDaemon({
      stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner,
      watcherIntervalMs: 60_000,  // suppress watcher ticks during this test
    })

    const after = loadBindings(join(dir, 'bindings.json'))
    expect(after['sid-alive'].tmux_session).toBe('claude-sid-alive')
    expect(after['sid-dead'].tmux_session).toBeUndefined()
    expect(after['sid-dead'].managed).toBe(true)  // managed flag preserved
  })
})
```

- [ ] **Step 2: Run test**

Run: `bun test tests/daemon-spawn.integration.test.ts -t "startup reconcile"`
Expected: pass on first run (logic already implemented in Task 11).

If fails, debug `reconcileOnStartup`: verify the `await isAlive` order matches scripted exits and that `upsertBinding` with `tmux_session: undefined` actually drops the key. (`upsertBinding` stores the whole entry, so `tmux_session: undefined` lands as a JSON omission — that's the intended behavior.)

- [ ] **Step 3: Commit**

```bash
git add tests/daemon-spawn.integration.test.ts
git commit -m "test(daemon): cover startup reconcile of managed bindings

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: README — `brew install tmux` prerequisite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add tmux to Prerequisites**

In `README.md`, locate the **Prerequisites** section. Add a third bullet:

```markdown
- [tmux](https://github.com/tmux/tmux) — `brew install tmux` on macOS — required only when you use the `create_thread` MCP tool to spawn child sessions; manual `claude` launches do not need it.
```

- [ ] **Step 2: Run `which tmux`; install if missing**

Run: `which tmux || brew install tmux && tmux -V`
Expected: prints a tmux version string; if `brew install` ran, watch for any errors.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(README): document tmux prerequisite for create_thread

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: End-to-end smoke (manual, optional)

This task is **optional manual verification** — do NOT add it to CI. It exercises the real path with a stub `claude` so you can see the wiring work without setting up a Discord bot for every dev iteration.

- [ ] **Step 1: Write a stub claude script**

Create `/tmp/fake-claude.sh`:

```sh
#!/bin/sh
echo "fake-claude started in $(pwd) thread=$DISCORD_THREAD_ID"
exec sleep infinity
```

Make it executable:
```bash
chmod +x /tmp/fake-claude.sh
```

- [ ] **Step 2: Start the daemon in foreground with a fake claude**

In one terminal:
```bash
cd /Users/qiurui/A-project/claude-discord-multisession
DISCORD_BOT_TOKEN=<your-token> bun server.ts --daemon 2>&1
```

In another terminal, exercise `create_thread` directly over the UDS — or simpler: invoke the manager session with `claude` against the daemon and ask it to call `create_thread` via MCP.

- [ ] **Step 3: Verify**

- `tmux list-sessions` shows a `claude-<sid>` session.
- `tmux attach -t claude-<sid>` shows the fake-claude output.
- A new Discord thread exists under your configured parent channel.
- `bindings.json` has the new entry with `managed: true`.
- `close_thread` kills the tmux session and archives the Discord thread.
- `list_threads` returns the expected JSON shape.

- [ ] **Step 4: No commit** — smoke verification produces no source changes.

---

## Final verification

- [ ] Run the full test suite: `bun test`. Expected: all tests pass, no warnings about unhandled promise rejections from the watcher.
- [ ] Confirm no new files outside `src/`, `tests/`, `docs/`, and `README.md` were created.
- [ ] Confirm `bun.lock` is unchanged (no new dependencies were added — `node:child_process` is built-in).
- [ ] Push the branch and open a PR referencing the design doc and this plan.

