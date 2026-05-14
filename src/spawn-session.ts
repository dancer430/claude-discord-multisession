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
