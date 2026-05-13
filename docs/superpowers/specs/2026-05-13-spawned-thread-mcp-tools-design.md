# Spawned-thread MCP tools: `create_thread`, `close_thread`, `list_threads`

**Status:** draft
**Date:** 2026-05-13
**Owner:** ruiqiu

## Goal

Let a running Claude Code session — typically the "manager" session in the DM channel — spawn additional Claude Code sessions on the same host without the user opening a terminal. Each spawned session runs `claude` in a tmux-backed working directory and auto-pairs with a freshly created Discord thread, so the user can chat with each child session in its own thread. The manager can also list and shut down spawned sessions on request.

This extends the existing daemon (see `docs/superpowers/specs/2026-05-06-discord-multisession-design.md`) with three new MCP tools and a thin process-lifecycle layer around tmux. The daemon's existing `register` flow already knows how to create Discord threads on demand (`thread_id === 'auto'` branch); the new tools ride on top of that machinery instead of duplicating it.

## Non-goals

- **Multi-machine spawn.** All spawned `claude` processes run on the same host as the daemon. Remote spawn is out of scope.
- **Discord-message-driven spawn.** A message from a Discord user cannot directly trigger a spawn. Only an MCP-tool call from an already-authorized Claude Code session can. The prompt-injection surface matches every other MCP tool the session exposes.
- **General process supervisor.** No restart-on-crash, no resource limits, no log rotation. Tmux's scrollback is the log.
- **Replacing the manual-launch path.** Users can still run `claude` from a terminal and pair manually; spawned sessions are an additional entry point, not a replacement.

## Constraints and existing invariants this design must preserve

1. **Daemon is the single owner of the Discord gateway connection.** Spawned children must not log in to Discord themselves — they continue to use the shim/UDS path like every other session.
2. **`session_id` is normally the sha1 of the (rewritten) `cwd`.** Two sessions in the same `cwd` collide unless one explicitly pins `CLAUDE_SESSION_ID`. The spawn flow uses that env to disambiguate labeled siblings instead of bypassing the rule.
3. **`bindings.json` is the on-disk source of truth for session → thread mappings.** `upsertBinding` is the only safe writer; it load-merges under a per-file mutex. New fields must round-trip through the same writer.
4. **`access.parentChannelId`** is the single parent channel under which `thread_id='auto'` registers create new threads. Spawn reuses that; it does not invent its own access rules.
5. **The shim → daemon protocol is versioned by additive zod schemas.** New tool names go in `ToolCallMsg.name`; no register-frame changes needed for v1 — the spawn flow uses the existing `mode='thread'`, `thread_id='auto'` register variant.

## User-facing flow

In the manager session (DM channel) the user says, e.g.:

> "起一个子区，进入 `/Users/qiurui/work/fork_dir/connectors-operator/connectors-operator`"

The manager calls `create_thread(cwd=…)`. The daemon:

1. Computes the expected `session_id` (cwd-derived; if `label` was supplied, sha1 of `canonical_cwd + ':' + label`).
2. Rejects if a managed binding for that `session_id` already exists with a live tmux session.
3. Starts a detached tmux session named `claude-<session_id>` whose initial command is:
   ```
   cd <cwd> &&
   export http_proxy=http://127.0.0.1:7897 \
          https_proxy=http://127.0.0.1:7897 \
          all_proxy=socks5://127.0.0.1:7897 &&
   [CLAUDE_SESSION_ID=<sid>] \
   [DISCORD_THREAD_NAME=<name>] \
   DISCORD_THREAD_ID=auto \
   claude
   ```
   `CLAUDE_SESSION_ID` is exported only when `label` is provided (so the cwd-default hash continues to apply for unlabeled spawns). `DISCORD_THREAD_NAME` is exported only when caller supplied `thread_name` or when `label` is present (in which case we append `[label]` for human readability).
4. Inside the tmux session, `claude` starts, the shim auto-spawns or reuses the daemon, and `register` arrives with `mode='thread'`, `thread_id='auto'`. The **existing** register handler creates the Discord thread under `access.parentChannelId` and writes the binding via `upsertBinding`.
5. The daemon notices that this `session_id` matches an outstanding `create_thread` request (held in an in-memory pending map) and resolves the request with the newly-minted thread info. The pending map handler then patches the binding via `upsertBinding` to add `managed: true`, `tmux_session: 'claude-<sid>'`, and `label` (if any).
6. `create_thread` returns `{ thread_id, thread_url, thread_name, tmux_session, session_id }` to the manager.

To shut down, the user says e.g. "关掉 connectors-operator". The manager calls `close_thread(cwd=…)`:

1. Daemon resolves `cwd` (plus optional `label`) to a `session_id` → managed binding via `bindings.json`.
2. `tmux kill-session -t claude-<sid>`. The child shim disconnects.
3. Daemon archives the Discord thread (`thread.setArchived(true)`) via a new `ops.archiveThread`.
4. Daemon removes the binding via a new `removeBinding` writer.
5. Returns `{ closed: thread_id }`.

`list_threads` returns one row per managed binding: `{ session_id, thread_id, thread_name, cwd, label, tmux_session, tmux_alive, created_at }`. Non-managed (manually-launched) bindings are excluded.

## Design

### 1. New MCP tools (shim → daemon → ops)

`src/shim.ts` adds three entries to its `ListToolsRequestSchema` tool list. Inputs:

- `create_thread`: `{ cwd: string; label?: string; thread_name?: string }`
- `close_thread`: `{ thread_id?: string; cwd?: string; label?: string }` — must supply `thread_id` OR `cwd`; if both are present, `thread_id` wins and `label` is ignored; `label` only meaningful with `cwd`.
- `list_threads`: `{}`

`src/protocol.ts` extends `ToolCallMsg.name`'s enum to include the three names. Shim is otherwise unchanged — it still forwards `tool_call` blindly.

`src/daemon.ts`'s `runTool` switch grows three new cases that call into a new `spawn-manager` module. Tool results are JSON-stringified text:
```
{ content: [{ type: 'text', text: JSON.stringify(result) }] }
```

### 2. `spawn-manager` module (new file `src/spawn-manager.ts`)

Single responsibility: tmux-session lifecycle for managed `claude` children. Stateless helpers; the in-memory index lives in the daemon.

```ts
export const PROXY_ENV = {
  http_proxy: 'http://127.0.0.1:7897',
  https_proxy: 'http://127.0.0.1:7897',
  all_proxy: 'socks5://127.0.0.1:7897',
} as const
export const TMUX_PREFIX = 'claude-'  // tmux session name = TMUX_PREFIX + session_id

export function tmuxSessionName(sessionId: string): string

// sha1(canonical_cwd + ':' + label).slice(0,12) when label supplied,
// otherwise deriveSessionId(cwd) (i.e. matches the cwd-only default).
export function computeSessionId(cwd: string, label?: string): {
  sessionId: string
  canonicalCwd: string
}

// Compose and run `tmux new-session -d -s <name> '<shell-script>'`.
// Returns the tmux session name when tmux exits 0; throws otherwise.
// All interpolated strings are passed through a small shellEscape helper.
export interface SpawnInput {
  sessionId: string
  cwd: string
  label?: string
  threadNameOverride?: string
  claudePath: string
}
export function startSpawn(input: SpawnInput): Promise<string>

// `tmux kill-session -t <name>`. Resolves false if the session was already gone.
export function killSpawn(tmuxSession: string): Promise<boolean>

// `tmux has-session -t <name>` → boolean.
export function isAlive(tmuxSession: string): Promise<boolean>
```

Process model: `tmux new-session -d`. The `-d` flag detaches; the daemon does **not** retain a child handle. Tmux is the registry — daemons can be replaced and we don't lose track. `tmux has-session` is the liveness probe; PIDs are not tracked at the daemon level.

Shell-escape rule: `cwd` and `claudePath` are quoted with single-quotes and `'` → `'\''` substitution. `sessionId` is `[a-f0-9]{12}` (sha1-prefix) so a regex guard plus literal use is sufficient. `thread_name` override (if any) is passed through `deriveThreadName`'s existing whitelist before quoting.

### 3. `bindings.json` schema extension

`src/bindings.ts` `BindingEntry` gains three optional fields:

```ts
managed?: true        // set iff binding was authored via create_thread
tmux_session?: string // tmux session name; cleared by reconcile when tmux is dead
label?: string        // optional disambiguator supplied to create_thread
```

Backward compatibility: a binding with none of these three fields is indistinguishable from a manually-launched one. Existing entries are preserved verbatim across load/write.

**Writer changes:**

- `upsertBinding` already replaces the whole entry under `current[sessionId] = snapshot`. The new tools always pass the full intended entry, so no semantics change.
- New `removeBinding(file, sessionId): Promise<void>` mirrors `upsertBinding`'s queued load-merge-write pattern, deleting the keyed entry inside the same per-file critical section.

### 4. `create_thread` flow inside daemon

```
1. Validate cwd is absolute and exists (statSync → isDirectory).
2. const { sessionId, canonicalCwd } = computeSessionId(cwd, label)
3. const existing = bindings[sessionId]
   if existing?.managed:
     if await isAlive(existing.tmux_session): reject create_thread_already_running
     else: clear stale tmux_session (reconcile leftover) and continue
   else if existing:
     reject create_thread_cwd_has_manual_session
4. const pending = new Promise that resolves on register-ack for sessionId.
   Register it in spawnPending: Map<sessionId, {resolve, reject, label, threadNameOverride}>.
5. try {
     await startSpawn({ sessionId, cwd, label, threadNameOverride: thread_name, claudePath })
   } catch (e) {
     spawnPending.delete(sessionId); reject create_thread_spawn_failed
   }
6. const result = await Promise.race([pending, timeout(30s)])
   if timeout: tmux kill-session, spawnPending.delete; reject create_thread_register_timeout
7. // 'result' contains the freshly written binding's thread_id, thread_name, thread_url.
   await upsertBinding(file, sessionId, {
     ...result.bindingFromRegister,
     managed: true,
     tmux_session: tmuxSessionName(sessionId),
     ...(label ? { label } : {}),
   })
8. Return { session_id, thread_id, thread_name, thread_url, tmux_session, cwd, label }
```

Hook in the register handler: at each successful exit of the thread-mode register (both the `auto` branch and the explicit-`thread_id` branch), after `upsertBinding` commits, the daemon checks `spawnPending` and, if a promise is registered for that `session_id`, resolves it with the just-persisted binding. The hook is a 3-line addition near the existing `register_ack` write — strictly additive, no behavior change for non-spawned registers.

Rollback policy: if step 6 times out, the daemon kills the tmux session but does **not** attempt to archive the Discord thread, because the register might still be in flight (race). The next `create_thread` for the same `cwd` will find no binding and proceed cleanly; the orphaned thread, if any, can be archived manually via `close_thread thread_id=…`.

### 5. `close_thread` flow

```
1. Resolve target → session_id:
   - thread_id supplied: scan bindings for a managed entry with that thread_id.
   - else: session_id = computeSessionId(cwd, label).sessionId
2. Load binding. Require managed === true → else close_thread_unmanaged.
                 Require binding exists → else close_thread_not_found.
3. await killSpawn(binding.tmux_session) (idempotent; false return is fine).
4. try { await ops.archiveThread(binding.thread_id) } catch logs warning, continues.
5. await removeBinding(file, sessionId)
6. threadIndex.delete(thread_id); sessions.delete(sessionId).
7. Return { closed: thread_id }
```

The child shim, on tmux kill, has its stdin closed and runs its `shutdown` path. Daemon's UDS read loop sees EOF and cleans `sessionMap`/`threadIndex` — but `close_thread` cleans authoritatively in step 6 so we don't rely on ordering.

### 6. `list_threads` flow

Read `bindings.json` once, filter to entries with `managed === true`, decorate each with `tmux_alive = await isAlive(tmux_session)` (parallel). Sort by `created_at` descending. Return JSON-stringified array of:
```
{ session_id, thread_id, thread_name, cwd, label, tmux_session, tmux_alive, created_at }
```

### 7. Natural child exit (not triggered by `close_thread`)

The daemon runs a `setInterval(poll, 5_000)` that, for each tracked managed binding, calls `isAlive`. On a transition from alive → dead without a matching `close_thread` call in flight:

1. Look up the binding.
2. `ops.reply(thread_id, '[session exited]')` — plain message, no embed.
3. `upsertBinding` to clear `tmux_session` (preserve everything else, including `managed: true`).
4. Log a structured `session_exited` event.

The poll set is the union of {bindings with `managed: true` and `tmux_session` set}. Cost: one `tmux has-session` per managed binding per 5 s, all local.

### 8. Daemon restart reconcile

In `runDaemon` startup, after `loadBindings`:

```
for [sessionId, entry] of bindings:
  if entry.managed === true and entry.tmux_session:
    if await isAlive(entry.tmux_session):
      add to in-memory watch set
    else:
      await upsertBinding(file, sessionId, { ...entry, tmux_session: undefined })
      // binding kept for list_threads visibility; close_thread can still remove it.
```

Bounded by the number of managed bindings; runs once on startup; uses the existing locked-write helper.

### 9. `DiscordOps` extension

`src/discord-ops.ts` adds one method:
```ts
archiveThread(thread_id: string): Promise<void>
```
Real impl (`discord-ops-real.ts`): fetch the thread channel, call `setArchived(true, 'close_thread')`. Fake impl: record the call and mark the fake thread archived in an internal set so tests can assert.

### 10. Error strings

Returned in the `tool_result` `text` field as JSON `{ error: "<code>", message: "..." }` so callers can branch on the code:

- `create_thread_invalid_cwd` — `cwd` missing or not a directory.
- `create_thread_parent_unset` — `access.parentChannelId` not configured. (Distinguished from `create_thread_spawn_failed` because the fix is "run /discord:configure", not a transient retry.)
- `create_thread_already_running` — managed binding exists and tmux session alive.
- `create_thread_cwd_has_manual_session` — non-managed binding holds this `cwd`'s `session_id`.
- `create_thread_spawn_failed` — `tmux new-session` returned non-zero.
- `create_thread_register_timeout` — child claude failed to register within 30 s; tmux killed; no binding written.
- `close_thread_not_found` — no managed binding for the supplied target.
- `close_thread_unmanaged` — binding exists but `managed !== true`.

Tmux-not-installed surfaces during step 5 (`startSpawn` throws). We do **not** preflight tmux at daemon startup, because manual-launch users without spawn needs should not be blocked.

### 11. Tests

Following the existing pattern (FakeDiscordOps + bun test):

- Unit-test `computeSessionId`: with `label`, distinct from no-label; without `label`, matches `deriveSessionId(cwd)`.
- Unit-test `create_thread` happy path with a fake `tmuxRunner` (no real tmux invocation):
  - tmux invoked with the expected argv (proxy env, optional CLAUDE_SESSION_ID, DISCORD_THREAD_ID=auto).
  - Simulated child register lands; binding ends up with `managed: true`, `tmux_session`, and the `label` if supplied.
  - FakeDiscordOps.createThread was called by the register handler.
- Unit-test `create_thread` rejects when binding already exists managed+alive.
- Unit-test `create_thread` register-timeout: simulated child never registers → `tmux kill-session` invoked, no binding remains.
- Unit-test `close_thread` by both `thread_id` and `cwd` paths; assert `archiveThread`, `kill-session`, and binding deletion.
- Unit-test `close_thread` refuses to close non-managed bindings.
- Unit-test `list_threads` filters out non-managed entries and reports `tmux_alive` accurately.
- Unit-test natural-exit watcher: with simulated `isAlive=false` after start, assert `ops.reply` posted `[session exited]` and binding has `tmux_session` cleared but `managed: true` intact.
- Unit-test reconcile on startup: pre-seed bindings.json with one alive (`isAlive` returns true) and one dead managed entry; after daemon boot, alive one is in the watch set, dead one has `tmux_session` cleared.

`SpawnManager`'s real implementation shells out to `tmux`. To keep tests hermetic, we extract a `TmuxRunner` interface (`run(args: string[]): Promise<{stdout, stderr, exitCode}>`) and inject it; tests use an in-memory fake. No tests shell out to real tmux.

## Implementation order (sketch — full plan goes to writing-plans)

1. `removeBinding` + tests; bindings.json schema fields documented.
2. `TmuxRunner` interface + real impl + fake; `spawn-manager` exports `tmuxSessionName`, `computeSessionId`, `startSpawn`, `killSpawn`, `isAlive`.
3. `DiscordOps.archiveThread` + real impl + fake.
4. `protocol.ts` enum extension; `shim.ts` tool descriptors.
5. `daemon.ts`: pending-registration hook, three `runTool` cases, watcher tick, startup reconcile.
6. Wire `brew install tmux` into the README's install steps.
7. End-to-end smoke: real daemon, real shim spawning, fake `claude` binary (a 1-line bash that just runs `sleep infinity`) to exercise create/list/close without depending on real Claude Code.

## Open questions / explicitly deferred

- **`label` collisions.** Two `create_thread` calls with identical `(cwd, label)` collide on `session_id`; the second sees `create_thread_already_running` if the first is still alive, or reuses the binding if the first has exited (because we leave the binding around per Q3). That's intentional but worth flagging.
- **Stderr/stdout of the child claude.** Tmux retains scrollback (default 2000 lines); deeper debugging uses `tmux attach -t claude-<sid>`. No separate log file in v1.
- **Race between manual `claude` and `create_thread` for the same cwd.** The step-3 pre-check catches this synchronously. A concurrent race (manual claude's register and our `create_thread` overlapping) is bounded by the existing `threadIndex.has()` post-await recheck in the register handler; one of the two surfaces `thread_session_taken`, matching existing behavior.
- **Stale manual binding blocks unlabeled spawn.** If the user ran `claude` manually in `cwd` weeks ago and never reused that thread, the dead-but-persisted binding causes `create_thread` to return `create_thread_cwd_has_manual_session`. The error message should suggest the workaround: pass a `label`, which derives a different `session_id` and bypasses the collision. Alternatively the user can prune the stale entry from `bindings.json` by hand.
- **Register-after-timeout edge.** If the child registers in (timeout, ∞), the register handler will still write its (unmanaged) binding because the pending entry was cleared on timeout. The result is an orphan unmanaged binding for a Discord thread whose tmux session we already killed. v1 accepts this as a known corner — 30 s is generous, so this requires a tmux/claude pathology to hit, and the user can recover by deleting the entry from `bindings.json` or running `create_thread` with a label.
- **Multi-line cwds and shell escaping.** We forbid `cwd` containing characters outside `[A-Za-z0-9 _.\-/]` (the same whitelist `deriveThreadName` uses). Anything else returns `create_thread_invalid_cwd`. This is conservative but avoids a class of escape bugs entirely.

## Out-of-scope reminders

- No restart-on-crash. Crash = `[session exited]` notice; user decides whether to recreate.
- No log rotation. Tmux scrollback is the log.
- No remote/cross-machine support.
- No new access-policy layer; the spawn rides on existing `access.parentChannelId` + DM/group gates.
