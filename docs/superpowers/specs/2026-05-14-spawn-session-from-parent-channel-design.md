# Spawn Claude session from parent-channel command

**Date:** 2026-05-14
**Status:** Draft — awaiting user review
**Author:** brainstormed via Discord with qiurui

## Goal

Let an authorized user post a single Discord message in a parent channel — e.g. `起子区 /Users/qiurui/Projects/foo` — and have the daemon launch a new `claude` process in that working directory. The new process auto-registers through the existing shim flow, which transparently creates a Discord thread named after the cwd and posts its own greeting. The user sees the thread spawn and start talking to them; they never need to touch a terminal.

This adds **one** new code path. The post-spawn lifecycle (thread creation, session binding, message routing, permission prompts, teardown) is unchanged — the new `claude` process is just another shim, indistinguishable from one started by hand.

## Non-goals

- **Not** a remote-execution shell. The trigger only spawns `claude`, never arbitrary commands.
- **Not** a cross-machine launcher. The daemon spawns on its own host; there is no SSH leg.
- **Not** a thread-management interface. Stopping, renaming, or relisting sessions still uses the existing mechanisms.
- **Not** changing `create_thread`'s semantics. That tool still produces an empty thread; this feature is the *real* "spawn a working Claude" path.

## User flow

1. User posts `起子区 /abs/path` in a parent channel the bot is in.
2. Daemon validates: sender is in `access.allowFrom`; path is absolute, exists, is a directory, falls under `access.spawnAllowedRoots`.
3. Daemon replies in the parent channel: `正在为 /abs/path 启动 Claude…` (acknowledgement only).
4. Daemon spawns a `claude` subprocess with `cwd=/abs/path`, env carrying `DISCORD_THREAD_ID=auto` and `DISCORD_THREAD_NAME=<basename>`.
5. The new shim connects to the daemon, registers in `thread` mode, the daemon creates the thread (existing `daemon.ts:685` path), and the new process posts its greeting inside it.
6. On any validation failure (path missing, not in allowlist, sender not allowed, `claude` binary not found, spawn rejected by OS), the daemon replies in the parent channel with a single-line error explaining which check failed. No thread is created.

## Architecture

### Trigger detection

In `daemon-entry.ts`'s `messageCreate` handler, before the existing `deliverInbound` path:

```ts
const isParentChannel = !isDM && !msg.channel.isThread()
const isOptedIn = isParentChannel && (
  msg.channelId === access.parentChannelId || msg.channelId in access.groups
)
if (isOptedIn) {
  const m = parseSpawnCommand(msg.content, access.spawnTrigger ?? '起子区')
  if (m) {
    await handleSpawnCommand(m.rawPath, msg)
    return   // do NOT fall through to deliverInbound
  }
}
```

Two gates here matter:
- **Channel opt-in** — only react to spawn triggers in channels the operator already configured via `/discord:access group add` (or as the auto-create parent). Stops the bot from reacting to random text channels it happens to be invited to.
- **Early return** — once we recognize a spawn command we MUST NOT also call `deliverInbound`, or the existing "non-thread guild message → fall back to DM session" path (`daemon.ts:288`) routes the same message into a DM session as well.

`parseSpawnCommand(content, trigger)` returns `{ rawPath }` when `content` starts with `trigger` (case-sensitive, optionally followed by whitespace and a single non-empty argument) and `null` otherwise. Trailing/leading whitespace is trimmed. Multi-line messages are rejected (only the first line counts).

### Validation (`src/spawn-session.ts`)

A pure-data module so it can be unit-tested without booting Discord:

```ts
export type SpawnValidation =
  | { ok: true; cwd: string; threadName: string }
  | { ok: false; code: SpawnRejectCode; message: string }

export function validateSpawnRequest(args: {
  rawPath: string
  senderId: string
  parentChannelId: string
  access: Access
  // Injected for testability:
  statSync: (p: string) => { isDirectory(): boolean }
}): SpawnValidation
```

Reject codes (each one produces a distinct parent-channel error):

| code | trigger |
|---|---|
| `not_authorized` | sender not in `access.allowFrom` (same global gate the permission-reply intercept at `daemon-entry.ts:108` already uses) |
| `path_not_absolute` | `rawPath` is empty or doesn't start with `/` (or `~`, which we expand against the daemon's `$HOME`) |
| `path_not_found` | `statSync` throws ENOENT |
| `path_not_directory` | path exists but isn't a directory |
| `path_outside_allowlist` | path doesn't fall under any `access.spawnAllowedRoots[i]` |
| `allowlist_empty` | `access.spawnAllowedRoots` is missing or empty → spawn is fully disabled |

`spawnAllowedRoots` matching is **prefix-with-boundary**: `/Users/qiurui/Projects` matches `/Users/qiurui/Projects/foo` but not `/Users/qiurui/ProjectsExtra`. We normalize both sides with `path.resolve()` before comparing.

### Spawning (`src/spawn-session.ts`)

```ts
export type SpawnResult =
  | { ok: true; pid: number }
  | { ok: false; code: 'spawn_failed'; message: string }

export function spawnClaude(args: {
  cwd: string
  threadName: string
  command: string[]    // ['claude', '--channels', 'plugin:discord@danielfbm-discord'] by default
  env: NodeJS.ProcessEnv
  logPath: string      // ~/.claude/channels/discord/spawned/<short-id>.log
  // Injected:
  spawn: typeof import('child_process').spawn
  openSync: typeof import('fs').openSync
}): SpawnResult
```

Behavior:
- Opens `logPath` (append, 0600), uses the fd for both stdout and stderr of the child.
- Calls `spawn(command[0], command.slice(1), { cwd, env: { ...env, DISCORD_THREAD_ID: 'auto', DISCORD_THREAD_NAME: threadName }, detached: true, stdio: ['ignore', fd, fd] })`.
- Calls `child.unref()` so daemon idle-exit isn't blocked.
- Returns `{ ok: true, pid }` synchronously after `spawn` succeeds. Returns `{ ok: false, code: 'spawn_failed', message }` if `spawn` throws (ENOENT for missing `claude` binary, EACCES, etc.).

The default `command` is read from env `CLAUDE_DISCORD_SPAWN_CMD` (shell-split), falling back to `['claude', '--channels', 'plugin:discord@danielfbm-discord']`. This lets operators on dev installs override to `claude --dangerously-load-development-channels plugin:discord@danielfbm-discord`.

**Note on TTY:** `claude` is normally an interactive CLI. Running it with `stdio=['ignore', fd, fd]` may cause it to exit immediately on some installs that expect a TTY. The escape hatch is `CLAUDE_DISCORD_SPAWN_CMD`: operators who need a PTY wrapper can set e.g. `tmux new-session -d -s claude-{cwd} -- claude --channels ...`. (No placeholder expansion in v1 — keep it simple; operators write a literal command.) If this turns out to be a regular failure mode in practice, v1.1 adds `tmux`/`screen` integration. For v1, surface the child's exit code in the log file and document the workaround.

### `access.json` schema additions

Two new optional fields in `Access`:

```ts
spawnAllowedRoots?: string[]   // absolute path prefixes. Empty/missing disables spawn entirely.
spawnTrigger?: string          // command keyword. Default '起子区'. Configurable so English users can pick e.g. '/spawn'.
```

Both flow through `loadAccess` / `saveAccess` with the existing pattern (parse-with-fallback). No migration needed — old `access.json` files keep working with spawn disabled.

### Acknowledgement and error reply

Both go through `RealDiscordOps.reply` (existing path). Daemon writes the acknowledgement BEFORE calling `spawn` so the user sees "we got it" even if spawn fails (in which case a second message reports the failure). On success, no further message is needed — the child's auto-thread-creation produces its own greeting visible to the user.

### Spawn audit log

Every spawn attempt logs one line to `daemon.log` in the existing `discord daemon: spawn outcome=<ok|err> ...` format (matching the `logRegister` style). Fields: `outcome`, `sender_id`, `parent_id`, `rawPath`, `cwd` (resolved), `code` (on err), `pid` (on ok). This is the forensic record for "who spawned what when."

## Security model

The threat is operator-side: a Discord member with chat access could otherwise launch arbitrary `claude` instances anywhere on the daemon's host, then use those Claude instances to read/write any file the daemon's UID can touch.

Defenses, in order:

1. **`allowFrom` gate.** Only allow-listed senders trigger anything. Same gate that already governs permission replies (`daemon-entry.ts:108`).
2. **`spawnAllowedRoots` allowlist.** Without this field set, spawn is fully off. Operator must explicitly opt in to which directories are reachable. Prefix-with-boundary matching, normalized paths.
3. **No shell.** `spawn` is called with `command[0]` as the executable and an arg array — no shell interpolation. `rawPath` is passed as a single `cwd` value to `spawn`, never concatenated into a command string.
4. **No relative paths.** Reject anything not starting with `/` or `~`. (`~` is expanded against `$HOME` before validation.)
5. **No env smuggling.** The daemon overrides `DISCORD_THREAD_ID` and `DISCORD_THREAD_NAME` after merging `process.env` — the sender can't override them from the message.

Out of scope: protecting against a malicious operator who configured `spawnAllowedRoots: ["/"]`. That's documented as "don't."

## Failure modes

| Scenario | Behavior |
|---|---|
| Sender not authorized | Silently ignored (don't leak that the bot saw the message). Logged as `outcome=err code=not_authorized`. |
| Path doesn't exist | Parent-channel reply: `❌ /path 不存在` |
| Path not in allowlist | Parent-channel reply: `❌ /path 不在 spawnAllowedRoots 白名单内` |
| `claude` binary missing | Parent-channel reply: `❌ 启动失败：claude 命令未找到（CLAUDE_DISCORD_SPAWN_CMD: <command>）` |
| Spawn throws other error | Parent-channel reply: `❌ 启动失败：<error.message>` |
| Spawn succeeds, child crashes before register | No thread appears; daemon doesn't know. User sees only the ack. Log file at `spawned/<id>.log` has the child's output for diagnosis. v1 accepts this — adding a "watchdog timeout" complicates the daemon for what should be a rare event. |
| Two simultaneous spawns for the same cwd | Both spawn; both register with different `session_id` (per-process); both get their own thread. The existing daemon already supports this. |

## Testing

### Unit tests — `tests/spawn-session.test.ts`

- `parseSpawnCommand` parses `起子区 /abs/path`, rejects multi-line, rejects missing arg, rejects unknown trigger
- `validateSpawnRequest` covers every reject code (one test each) plus the happy path
- `validateSpawnRequest` prefix-with-boundary: accepts `/root/sub`, rejects `/rootEvil`
- `spawnClaude` happy path with mocked `spawn` + `openSync`: asserts argv, cwd, env (DISCORD_THREAD_ID/NAME set), detached, stdio shape, `.unref()` called
- `spawnClaude` spawn-throws → returns `{ ok: false, code: 'spawn_failed' }`

### Integration test — extend `tests/daemon-shim.integration.test.ts` (or a new file)

- Boot daemon with a fake `DiscordOps` and an `access.json` with `spawnAllowedRoots: [<tmp dir>]`
- Inject a parent-channel `messageCreate` with `起子区 <tmp dir>/sub`
- Stub `child_process.spawn` to record the call and immediately fake a subsequent shim `register` over the UDS
- Assert: (a) ack reply observed via fake ops; (b) `spawn` called with expected cwd + env; (c) register succeeds, thread created, child's greeting reply observed
- Negative test: same setup but path outside allowlist → ack absent, error reply observed, `spawn` never called

## File map

| File | Change |
|---|---|
| `src/access.ts` | Add `spawnAllowedRoots?`, `spawnTrigger?` to `Access`, plumbing in `loadAccess` |
| `src/spawn-session.ts` | **New.** `parseSpawnCommand`, `validateSpawnRequest`, `spawnClaude` |
| `src/daemon-entry.ts` | In `messageCreate`, branch to spawn flow when message is in a parent channel and starts with the trigger word |
| `src/daemon.ts` | Add `logSpawn(...)` helper next to `logRegister` |
| `tests/spawn-session.test.ts` | **New.** Unit tests |
| `tests/daemon-shim.integration.test.ts` | Extend with spawn end-to-end case |
| `README.md` | Document `spawnAllowedRoots`, `spawnTrigger`, `CLAUDE_DISCORD_SPAWN_CMD`, security guidance |

## Open questions to surface during review

- Is `起子区` the right default trigger? Current pick. Chinese-language default matches the only known operator (qiurui); English users override via `spawnTrigger: "/spawn"` etc.
- Do we want a per-spawn override for proxy env? (Current design: inherit `process.env` only — keep it simple.)
- TTY problem: ship `tmux` integration in v1 or document the workaround? (Current design: document only; ship integration in v1.1 if needed.)

## Out of scope for v1

- Listing live spawned sessions from Discord
- Stopping a spawned session from Discord (existing thread-archive flow stays)
- Per-cwd proxy/env overrides
- PTY wrapping built into the daemon
- Cross-host spawning
