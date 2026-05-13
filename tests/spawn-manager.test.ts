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
