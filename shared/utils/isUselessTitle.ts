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
  // Absolute/home paths
  /^[~/]/,
  /^[A-Z]:\\/i,
  // user@host:path shell prompts
  /^[\w.-]+@[\w.-]+:/,
  // Trailing shell prompt characters
  /[~$#>]\s*$/,
];

export function isUselessTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  return USELESS_TITLE_PATTERNS.some((re) => re.test(trimmed));
}
