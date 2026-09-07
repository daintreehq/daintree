/**
 * Normalise an on-disk executable path to the lowercase, extension-stripped
 * basename the detector's candidate builder keys on (`AGENT_CLI_NAMES`,
 * `getProcessIconMap()`).
 *
 * Splits on both separators rather than using `path.basename` so a Windows
 * path resolves correctly while running on macOS or Linux — the Windows census
 * carries `ExecutablePath` strings that unit tests parse on POSIX, and
 * `path.basename` honours the running platform's separator only.
 */
export function toExecutableBasename(fullPath: string): string | null {
  const trimmed = fullPath.trim();
  if (!trimmed) return null;
  // A trailing separator leaves an empty last segment. Falling back to the
  // whole path there would hand "/" back as its own basename.
  const baseRaw = trimmed.split(/[\\/]/).pop();
  if (!baseRaw) return null;
  const lower = baseRaw.toLowerCase();
  const stripped = lower.replace(/\.(exe|cmd|bat|com|ps1)$/u, "");
  return stripped || null;
}
