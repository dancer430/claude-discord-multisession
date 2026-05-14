import { readdir } from 'fs/promises'
import { statSync } from 'fs'
import { join } from 'path'

const BLACKLIST = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv', 'vendor',
])
const DEFAULT_MAX_RESULTS = 50
const DEFAULT_TIMEOUT_MS = 5000

export type ProjectDirMatch = {
  /** Absolute path to the git-repo directory. */
  cwd: string
  /** Last path component, used for substring matching. */
  basename: string
  /** Path relative to the scan root, forward-slash separated. */
  relative: string
}

export type ScanResult = {
  matches: ProjectDirMatch[]
  truncated: boolean
}

export type ScanOpts = {
  query?: string
  maxResults?: number
  timeoutMs?: number
}

/**
 * Recursively walk `root` and collect every directory that contains a `.git`
 * subdirectory. The root itself is never returned as a match — it's a
 * container, not a project. A directory's basename is matched against
 * `query` case-insensitively (substring); empty query matches all.
 *
 * Recursion stops at every git-repo boundary so submodules nested inside
 * a superproject don't appear as separate entries.
 *
 * Symlinks are not followed (prevents loops and prevents the scan from
 * escaping the root). Common noise directories (node_modules, build, dist,
 * .git, .next, target, .venv, vendor) are skipped wholesale.
 */
export async function scanProjectDirs(root: string, opts: ScanOpts): Promise<ScanResult> {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const q = (opts.query ?? '').toLowerCase()

  const rootStat = statSync(root)
  if (!rootStat.isDirectory()) throw new Error(`scanProjectDirs: not a directory: ${root}`)

  const found: ProjectDirMatch[] = []
  let truncated = false
  const deadline = Date.now() + timeoutMs

  async function visit(absDir: string, relDir: string): Promise<void> {
    if (Date.now() >= deadline) {
      throw new Error(`scanProjectDirs: timeout after ${timeoutMs}ms`)
    }

    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return  // permission denied or transient — skip silently
    }

    // root itself is a container, not a candidate match
    if (relDir !== '' && entries.some(e => e.isDirectory() && e.name === '.git')) {
      const basename = relDir.split('/').pop()!
      if (q === '' || basename.toLowerCase().includes(q)) {
        if (found.length < maxResults) {
          found.push({ cwd: absDir, basename, relative: relDir })
        } else {
          truncated = true
        }
      }
      return  // stop at repo boundary
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue   // Dirent.isDirectory() returns false for symlinks; that's the intent
      if (BLACKLIST.has(e.name)) continue
      const sub = join(absDir, e.name)
      const subRel = relDir === '' ? e.name : `${relDir}/${e.name}`
      await visit(sub, subRel)
    }
  }

  await visit(root, '')

  found.sort((a, b) => a.relative.localeCompare(b.relative))
  return { matches: found, truncated }
}
