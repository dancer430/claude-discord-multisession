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
