import { AGENT_REGISTRY } from "../config/agentRegistry.js";

/**
 * Heuristic filter for OSC-emitted terminal titles.
 *
 * Agents (Claude, Codex, Gemini) often reset the terminal title to the binary
 * name or a path right before shutdown. Those labels aren't useful for
 * disambiguating closed sessions in the trash bin or resume history. We track
 * the last _non-useless_ title so the UI can surface a meaningful label like
 * "Fixing auth bug" instead of "claude".
 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every registered agent's binary name ("claude", "codex", "opencode", …) is
// a useless title — agents reset the window title to their own binary right
// before shutdown. Derived from the registry so new agents are covered
// without touching this list. Falls back to a no-match pattern when the
// registry is empty (unit tests mock it away); the static list below still
// covers the common binaries in that case.
let agentBinaries: string[] = [];
try {
  agentBinaries = [
    ...new Set(
      Object.values(AGENT_REGISTRY ?? {})
        .map((a) => a.command?.trim())
        .filter((c): c is string => !!c)
    ),
  ];
} catch {
  // Unit tests that mock the registry module away land here; the static
  // pattern below still covers the common agent binaries.
}
const AGENT_BINARY_PATTERN =
  agentBinaries.length > 0
    ? new RegExp(`^(${agentBinaries.map(escapeRegExp).join("|")})(\\.exe)?$`, "i")
    : /^claude$|^codex$|^gemini$/i;

const USELESS_TITLE_PATTERNS: readonly RegExp[] = [
  // Shell binaries
  /^(bash|zsh|fish|sh|cmd|powershell|pwsh|dash)(\.exe)?$/i,
  // Agent binary names (registry-derived; static core when the registry is mocked/empty)
  /^(claude|codex|gemini)$/i,
  AGENT_BINARY_PATTERN,
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
