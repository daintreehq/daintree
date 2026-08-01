import type { CommandIdentity } from "./types.js";
import { getProcessToolPriority } from "../../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES, PROCESS_ICON_MAP } from "./registries.js";

const WINDOWS_LAUNCHER_EXTENSION_PATTERN = /\.(?:exe|cmd|bat|com|ps1)$/i;
const SCRIPT_EXTENSION_PATTERN = /\.(?:m?jsx?|cjs|tsx?|py|rb|php|pl)$/i;
const SHELL_CONTROL_TOKENS = new Set(["&", "&&", "|", "||", ";"]);

export function stripCommandExecutableExtension(name: string): string {
  return name.replace(WINDOWS_LAUNCHER_EXTENSION_PATTERN, "").replace(SCRIPT_EXTENSION_PATTERN, "");
}

function splitShellLikeCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | `"` | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === `"`) && quote === null) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (quote === null && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    parts.push(current);
  }

  return parts;
}

/**
 * Extract non-flag command name candidates from a full `command` line in
 * argv order. Used when `comm` basename doesn't match a known CLI — most
 * commonly for Node-hosted CLIs where `comm = "node"` and argv[1] is the
 * agent script path (`node /path/to/claude --resume`).
 *
 * Shell quotes and path separators are stripped so
 * `'/Users/me/.local/bin/claude' --flag` resolves to `claude`.
 * Extensions like .js / .py / .rb are stripped so "claude.mjs" → "claude".
 * Returns argv[0], argv[1], argv[2] basenames.
 *
 * NOTE: if a process sets `process.title` after launch, macOS `ps` reports
 * the rewritten argv — the original invocation is NOT preserved in the
 * `command` column. Callers should not rely on this to recover identity
 * after a process has rewritten its title.
 */
export function extractCommandNameCandidates(command: string | undefined): string[] {
  if (!command) return [];
  const parts = splitShellLikeCommand(command);
  const candidates: string[] = [];
  for (let i = 0; i < parts.length && candidates.length < 5; i++) {
    const arg = parts[i];
    if (!arg || arg.startsWith("-")) continue;
    if (SHELL_CONTROL_TOKENS.has(arg)) continue;
    if (/^-?\d+(\.\d+)?$/.test(arg)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    const basename = arg.split(/[\\/]/).pop();
    if (!basename) continue;
    const withoutExt = stripCommandExecutableExtension(basename);
    if (withoutExt) candidates.push(withoutExt);
  }
  return candidates;
}

/** @deprecated Use extractCommandNameCandidates — retained for test import. */
export function extractScriptBasenameFromCommand(command: string | undefined): string | null {
  const all = extractCommandNameCandidates(command);
  // Previous behaviour: skip argv[0], return argv[1]. Preserved so older
  // tests that assume "only the script, not the runtime" still pass.
  return all[1] ?? null;
}

// Diagnostic logs must never carry full argv — users can legitimately pass
// secrets inline (e.g. `claude --api-key=…`, `gh auth --token …`). Keep only
// argv[0]'s basename so log noise still identifies the runtime without
// leaking credentials into console or into window.__daintreeIdentityEvents().
export function redactArgv(command: string | undefined): string {
  if (!command) return "";
  const first = splitShellLikeCommand(command)[0];
  if (!first) return "";
  const basename = first.split(/[\\/]/).pop() ?? first;
  return JSON.stringify(basename);
}

/**
 * Best-effort identity resolution from a shell command line.
 *
 * Used by the runtime shell-command fallback in TerminalProcess when the PTY
 * process tree is blind or a CLI rewrites its own process title. This shares
 * the same agent/process icon registry as the process-tree detector so chrome
 * stays consistent regardless of which signal produced the identity.
 */
export function detectCommandIdentity(command: string | undefined): CommandIdentity | null {
  const candidates = extractCommandNameCandidates(command);
  let iconMatch: { name: string; icon: string; priority: number } | null = null;

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
    if (candidateAgent) {
      return {
        agentType: candidateAgent,
        processIconId: PROCESS_ICON_MAP[lowerCandidate],
        processName: candidate,
      };
    }

    const candidateIcon = PROCESS_ICON_MAP[lowerCandidate];
    if (candidateIcon) {
      // Same tier preference as the process-tree path, so a typed `npx vitest`
      // reports Vitest rather than npm. Strict `<` keeps argv order on ties.
      const priority = getProcessToolPriority(candidateIcon);
      if (!iconMatch || priority < iconMatch.priority) {
        iconMatch = { name: candidate, icon: candidateIcon, priority };
      }
    }
  }

  if (!iconMatch) {
    return null;
  }

  return {
    processIconId: iconMatch.icon,
    processName: iconMatch.name,
  };
}
