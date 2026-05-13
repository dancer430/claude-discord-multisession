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
  test('spawns tmux, child registers via auto, returns thread info, binding becomes managed', async () => {
    const ops = new FakeDiscordOps()
    const tmuxRunner = new FakeTmuxRunner()
    tmuxRunner.scriptExit(0)  // tmux new-session
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
    const sockPath = join(dir, 'daemon.sock')

    const mgr = await registerDm(sockPath, 'mgr-session')

    const cwd = '/tmp'
    const { sessionId: childSid } = computeSessionId(cwd)

    writeFrame(mgr.sock, { type: 'tool_call', id: 2, name: 'create_thread', args: { cwd } })

    await new Promise(r => setTimeout(r, 50))
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
    daemon = await startDaemon({ stateDir: dir, ops, idleExitMs: 60_000, tmuxRunner })
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
})
