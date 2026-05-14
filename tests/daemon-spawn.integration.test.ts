import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
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
    threadCwdRoot: '/',   // permissive default for existing create_thread tests
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

async function registerDm(sockPath: string, session_id: string): Promise<{ sock: Socket; it: AsyncIterator<unknown> }> {
  const sock = await connect(sockPath)
  const it = frameIt(sock)
  writeFrame(sock, { type: 'register', id: 1, session_id, mode: 'dm', cwd: '/tmp' })
  const ack = await recv(it)
  expect(ack.type).toBe('register_ack')
  return { sock, it }
}

async function simulateChildRegister(sockPath: string, session_id: string, cwd: string): Promise<{ sock: Socket; it: AsyncIterator<unknown>; ack: any }> {
  const sock = await connect(sockPath)
  const it = frameIt(sock)
  writeFrame(sock, { type: 'register', id: 1, session_id, mode: 'thread', cwd, thread_id: 'auto' })
  const ack = await recv(it)
  return { sock, it, ack }
}

describe('daemon: create_thread happy path', () => {
  test('forwards claudeArgs into the tmux command when create_thread spawns', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    tmuxRunner.scriptExit(0)
    const localDaemon = await startDaemon({
      stateDir: dir,
      ops,
      idleExitMs: 60_000,
      tmuxRunner,
      claudeConfigPath: join(dir, 'fake-claude.json'),
      claudeArgs: ['--channels', 'plugin:discord@dancer430-discord'],
    })
    try {
      const sockPath = join(dir, 'daemon.sock')
      const mgr = await registerDm(sockPath, 'mgr-claudeargs')
      const cwd = '/tmp'
      const { sessionId: childSid } = computeSessionId(cwd)
      writeFrame(mgr.sock, { type: 'tool_call', id: 7, name: 'create_thread', args: { cwd } })
      await simulateChildRegister(sockPath, childSid, cwd)
      await recv(mgr.it)
      const tmuxCommand = tmuxRunner.calls[0][4]
      expect(tmuxCommand).toContain("'--channels' 'plugin:discord@dancer430-discord'")
    } finally {
      await localDaemon.shutdown()
    }
  })

  test('spawns tmux, child registers via auto, returns thread info, binding becomes managed', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    tmuxRunner.scriptExit(0)  // tmux new-session
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')

    const mgr = await registerDm(sockPath, 'mgr-session')

    const cwd = '/tmp'
    const { sessionId: childSid } = computeSessionId(cwd)

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd } })

    const child = await simulateChildRegister(sockPath, childSid, cwd)
    expect(child.ack.type).toBe('register_ack')
    expect(child.ack.thread_id).toBeTruthy()
    const newThreadId = child.ack.thread_id

    const result = await recv(mgr.it)
    expect(result.type).toBe('tool_result')
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text)
    expect(payload.thread_id).toBe(newThreadId)
    expect(payload.tmux_session).toBe(tmuxSessionName(childSid))
    expect(payload.session_id).toBe(childSid)

    const bindings = loadBindings(join(dir, 'bindings.json'))
    expect(bindings[childSid].managed).toBe(true)
    expect(bindings[childSid].tmux_session).toBe(tmuxSessionName(childSid))

    expect(tmuxRunner.calls[0].slice(0, 3)).toEqual(['new-session', '-d', '-s'])
  })

  test('rejects when access.parentChannelId is unset', async () => {
    writeFileSync(join(dir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
    }))
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-2')

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd: '/tmp' } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('create_thread_parent_unset')
    expect(tmuxRunner.calls).toHaveLength(0)
  })

  test('rejects when tmux fails; no binding written, no thread created', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    tmuxRunner.scriptExit(1, '', 'tmux: unable to start')
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
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
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-4')

    const cwd = '/tmp'
    const { sessionId } = computeSessionId(cwd)
    const tmuxSession = tmuxSessionName(sessionId)
    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      [sessionId]: { thread_id: 't-old', cwd, created_at: 1, last_seen_at: 2, managed: true, tmux_session: tmuxSession },
    }))
    tmuxRunner.scriptExit(0)  // pre-check isAlive → alive
    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('create_thread_already_running')
  })

  test('rejects second concurrent create_thread for the same sessionId', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    tmuxRunner.scriptExit(0)  // first create_thread's tmux ok
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')

    // The DM session acts as the first manager.
    const mgr1 = await registerDm(sockPath, 'mgr-conc-1')

    // Register a second session as thread-mode using auto so FakeDiscordOps
    // creates a Discord thread for us (parentChannelId is set in beforeEach).
    const mgr2Sock = await connect(sockPath)
    const mgr2It = frameIt(mgr2Sock)
    writeFrame(mgr2Sock, { type: 'register', id: 1, session_id: 'mgr-conc-2', mode: 'thread', cwd: '/home', thread_id: 'auto' })
    const mgr2Ack = await recv(mgr2It)
    expect(mgr2Ack.type).toBe('register_ack')

    const cwd = '/tmp'
    // Fire both create_thread calls from different connections before either
    // child registers.  The daemon processes each connection concurrently, so
    // the second one will hit the spawnPending guard.
    //
    // Both recv() calls are started concurrently. We collect both results,
    // which avoids the dangling-promise unhandled-rejection that a one-shot
    // Promise.race would leave when the "loser" recv is later rejected by
    // afterEach socket teardown.
    writeFrame(mgr1.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd } })
    writeFrame(mgr2Sock, { type: 'tool_call', id: 3, name: 'create_thread', args: { cwd } })

    // Drive the child registration concurrently so the blocking call can
    // complete while we wait for both results.
    const { sessionId: childSid } = computeSessionId(cwd)
    const childRegisterPromise = simulateChildRegister(sockPath, childSid, cwd)

    const [result1, result2] = await Promise.all([
      recv(mgr1.it),
      recv(mgr2It),
    ])
    const child = await childRegisterPromise
    expect(child.ack.type).toBe('register_ack')

    // Exactly one must be the already_spawning error; the other must succeed.
    const results = [result1, result2]
    const errorResult = results.find(r => r.isError)
    const successResult = results.find(r => !r.isError)
    expect(errorResult).toBeDefined()
    expect(successResult).toBeDefined()
    expect(JSON.parse(errorResult!.content[0].text).error).toBe('create_thread_already_spawning')
    const payload = JSON.parse(successResult!.content[0].text)
    expect(payload.session_id).toBe(childSid)
  })
})

describe('daemon: close_thread', () => {
  async function seedManaged(opts: {
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
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-c1')

    const sessionId = 'sid-close-1'
    await seedManaged({ sessionId, threadId: 't-1', cwd: '/tmp', tmuxSession: 'claude-' + sessionId })

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
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-c2')

    const cwd = '/tmp'
    const { sessionId } = computeSessionId(cwd)
    await seedManaged({ sessionId, threadId: 't-2', cwd, tmuxSession: tmuxSessionName(sessionId) })

    tmuxRunner.scriptExit(0)
    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'close_thread', args: { cwd } })
    const result = await recv(mgr.it)
    expect(result.isError).toBeFalsy()
    expect(ops.isArchived('t-2')).toBe(true)
  })

  test('close refuses non-managed bindings', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
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
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-c4')

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'close_thread', args: { thread_id: 't-ghost' } })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('close_thread_not_found')
  })
})

describe('daemon: list_threads', () => {
  test('lists only managed bindings with tmux_alive decoration', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
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
    tmuxRunner.scriptExit(0)  // alive
    tmuxRunner.scriptExit(1)  // dead

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'list_threads', args: {} })
    const result = await recv(mgr.it)
    expect(result.isError).toBeFalsy()
    const arr = JSON.parse(result.content[0].text) as any[]
    expect(arr).toHaveLength(2)
    expect(arr[0].session_id).toBe('sid-managed-alive')
    expect(arr[0].tmux_alive).toBe(true)
    expect(arr[0].label).toBe('feat-A')
    expect(arr[1].session_id).toBe('sid-managed-dead')
    expect(arr[1].tmux_alive).toBe(false)
  })
})

describe('daemon: natural-exit watcher', () => {
  test('posts [session exited] and clears tmux_session when isAlive flips to false', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    const sessionId = 'sid-watch'
    writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
      [sessionId]: {
        thread_id: 't-watch', cwd: '/tmp/w', created_at: 1, last_seen_at: 2,
        managed: true, tmux_session: 'claude-' + sessionId,
      },
    }))
    // Startup reconcile sees alive (exit 0); first watcher tick sees dead (exit 1).
    tmuxRunner.scriptExit(0)
    tmuxRunner.scriptExit(1)

    daemon = await startDaemon({
      stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner,
      watcherIntervalMs: 20,
    })

    // Wait long enough for one watcher tick.
    await new Promise(r => setTimeout(r, 100))

    expect(ops.calls.some(c => c.kind === 'archiveThread')).toBe(false)
    expect(ops.calls.some(c => c.kind === 'reply' && c.chat_id === 't-watch' && String(c.text).includes('[session exited]'))).toBe(true)
    const after = loadBindings(join(dir, 'bindings.json'))[sessionId]
    expect(after.managed).toBe(true)
    expect(after.tmux_session).toBeUndefined()
  })
})

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

describe('daemon: list_project_dirs', () => {
  test('returns matches under threadCwdRoot for a substring query', async () => {
    const root = mkdtempSync(join(tmpdir(), 'list-projects-root-'))
    try {
      mkdirSync(join(root, 'connectors-plugin', '.git'), { recursive: true })
      mkdirSync(join(root, 'connectors-operator', '.git'), { recursive: true })
      mkdirSync(join(root, 'unrelated', '.git'), { recursive: true })

      writeFileSync(join(dir, 'access.json'), JSON.stringify({
        dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
        parentChannelId: 'parent-123',
        threadCwdRoot: root,
      }))

      const ops = new FakeDiscordOps()
      const tmuxRunner = new FakeTmuxRunner()
      daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
      const sockPath = join(dir, 'daemon.sock')
      const mgr = await registerDm(sockPath, 'mgr-list-1')

      writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'list_project_dirs', args: { query: 'conn' } })
      const result = await recv(mgr.it)
      expect(result.isError).toBeFalsy()
      const payload = JSON.parse(result.content[0].text)
      expect(payload.root).toBe(root)
      expect(payload.count).toBe(2)
      expect(payload.truncated).toBe(false)
      expect(payload.matches.map((m: any) => m.relative).sort())
        .toEqual(['connectors-operator', 'connectors-plugin'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns root_invalid when threadCwdRoot does not exist', async () => {
    writeFileSync(join(dir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
      parentChannelId: 'parent-123',
      threadCwdRoot: '/nonexistent-root-' + Date.now(),
    }))

    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
    const sockPath = join(dir, 'daemon.sock')
    const mgr = await registerDm(sockPath, 'mgr-list-2')

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'list_project_dirs', args: {} })
    const result = await recv(mgr.it)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('list_project_dirs_root_invalid')
  })
})

describe('daemon: create_thread cwd guard', () => {
  test('rejects cwd outside threadCwdRoot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cwd-guard-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'cwd-guard-outside-'))
    try {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({
        dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
        parentChannelId: 'parent-123',
        threadCwdRoot: root,
      }))

      const ops = new FakeDiscordOps()
      const tmuxRunner = new FakeTmuxRunner()
      daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
      const sockPath = join(dir, 'daemon.sock')
      const mgr = await registerDm(sockPath, 'mgr-guard-1')

      writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd: outside } })
      const result = await recv(mgr.it)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text).error).toBe('create_thread_cwd_outside_root')
      expect(tmuxRunner.calls).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('rejects ../ escape via realpath canonicalization', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cwd-guard-parent-'))
    const root = join(parent, 'root')
    const sibling = join(parent, 'sibling')
    mkdirSync(root)
    mkdirSync(sibling)
    try {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({
        dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
        parentChannelId: 'parent-123',
        threadCwdRoot: root,
      }))

      const ops = new FakeDiscordOps()
      const tmuxRunner = new FakeTmuxRunner()
      daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
      const sockPath = join(dir, 'daemon.sock')
      const mgr = await registerDm(sockPath, 'mgr-guard-2')

      // root/../sibling resolves to a path outside root
      const escape = join(root, '..', 'sibling')
      writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd: escape } })
      const result = await recv(mgr.it)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text).error).toBe('create_thread_cwd_outside_root')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('accepts cwd nested under threadCwdRoot', async () => {
    // Validation passes; spawn proceeds and tmux is invoked. We
    // rely on the existing FakeTmuxRunner happy path to confirm
    // the guard didn't short-circuit.
    const root = mkdtempSync(join(tmpdir(), 'cwd-guard-accept-'))
    const inside = join(root, 'subproject')
    mkdirSync(inside)
    try {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({
        dmPolicy: 'allowlist', allowFrom: ['u1'], groups: {}, pending: {},
        parentChannelId: 'parent-123',
        threadCwdRoot: root,
      }))

      const ops = new FakeDiscordOps()
      const tmuxRunner = new FakeTmuxRunner()
      tmuxRunner.scriptExit(0)
      daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner, claudeConfigPath: join(dir, 'fake-claude.json') })
      const sockPath = join(dir, 'daemon.sock')
      const mgr = await registerDm(sockPath, 'mgr-guard-3')

      const { sessionId: childSid } = computeSessionId(inside)
      writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd: inside } })

      const child = await simulateChildRegister(sockPath, childSid, inside)
      expect(child.ack.type).toBe('register_ack')
      const result = await recv(mgr.it)
      expect(result.isError).toBeFalsy()
      expect(tmuxRunner.calls[0][0]).toBe('new-session')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
