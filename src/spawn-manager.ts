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
