/**
 * Heuristic filter for OSC-emitted terminal titles.
 *
 * Agents (Claude, Codex, Gemini) often reset the terminal title to the binary
 * name or a path right before shutdown. Those labels aren't useful for
 * disambiguating closed sessions in the trash bin or resume history. We track
 * the last _non-useless_ title so the UI can surface a meaningful label like
 * "Fixing auth bug" instead of "claude".
 */
const USELESS_TITLE_PATTERNS: readonly RegExp[] = [
  // Shell binaries
  /^(bash|zsh|fish|sh|cmd|powershell|pwsh|dash)(\.exe)?$/i,
  // Agent binary names
  /^claude$/i,
  /^codex$/i,
  /^gemini$/i,
  // Absolute/home paths (reject only when the whole string is path-shaped)
  /^(?:~\/?|\/)[^\s]*$/,
  /^[A-Z]:\\[^\s]*$/i,
  // user@host:path shell prompts followed by path/prompt char (not plain "user@domain: subject")
  /^[\w.-]+@[\w.-]+:[~/][^\s]*[#$>]?\s*$/,
  // PowerShell-style prompts: "PS C:\path>"
  /^PS\s+[A-Z]:\\[^\s]*[#$>]\s*$/i,
  // Path-anchored trailing prompt (e.g. "/home/user#", "~$")
  /^(?:~|\/|[A-Z]:\\)[^\s]*[#$>]\s*$/i,
];

export const MAX_OBSERVED_TITLE_LENGTH = 256;

export function isUselessTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  return USELESS_TITLE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Clamp and normalize an OSC title before we store it. The trust boundary is
 * the IPC handler — a misbehaving or hostile agent can emit arbitrary-length
 * title strings, which would then persist into the 30-day session history
 * file and inflate synchronous reads on every palette open.
 */
export function normalizeObservedTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_OBSERVED_TITLE_LENGTH
    ? trimmed.slice(0, MAX_OBSERVED_TITLE_LENGTH)
    : trimmed;
}
