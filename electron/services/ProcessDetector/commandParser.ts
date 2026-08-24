import type { CommandIdentity } from "./types.js";
import {
  getProcessToolConfig,
  getProcessToolPriority,
  PROCESS_TOOL_ICON_BY_COMMAND,
} from "../../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES, getProcessIconMap } from "./registries.js";

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

// Package-manager subcommands whose next argument is a real binary rather than
// a user-defined script name. `run` is deliberately absent: `npm run docker`
// runs whatever the "docker" script says, which is usually not Docker.
/**
 * Package-manager subcommands that run *another* binary rather than being one.
 * Exported because the plugin-manifest schema reserves these names: a plugin
 * that registered `exec` as its own command would match at argv[1] of
 * `npm exec vite` and win the tie against Vite at argv[2] (leftmost wins on
 * equal tier), reporting the plugin for a process it never launched.
 */
export const BINARY_EXEC_SUBCOMMANDS = new Set(["exec", "dlx", "x"]);

/**
 * Commands that run another program named in their arguments but carry no
 * process-tool registry entry: shells, environment/privilege prefixes, and
 * version-manager shims. Registry entries at `runtime` or `package-manager`
 * tier already mean exactly this, so those are derived instead of relisted.
 */
const SHELL_AND_PREFIX_EXECUTORS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ash",
  "ksh",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "env",
  "sudo",
  "doas",
  "nohup",
  "nice",
  "time",
  "stdbuf",
  "setsid",
  "command",
  "exec",
  "script",
  "mise",
  "asdf",
  "rtx",
  "direnv",
  "pipx",
  "rye",
  "pdm",
  "hatch",
]);

/**
 * Does this command run *another* program named in its arguments? Only then
 * can a later argv token be the executable.
 *
 * Built-in registry tiers only. A plugin-contributed command must not be able
 * to widen how far right an agent name is allowed to sit — that is the
 * positional guard this feeds, and plugins carry no tier to justify it.
 */
function isExecutorCommand(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (SHELL_AND_PREFIX_EXECUTORS.has(lower)) return true;
  // Own-key check: this table is a plain object, so a process literally named
  // `constructor` would otherwise index an inherited function.
  if (!Object.hasOwn(PROCESS_TOOL_ICON_BY_COMMAND, lower)) return false;
  const tier = getProcessToolConfig(PROCESS_TOOL_ICON_BY_COMMAND[lower])?.tier;
  return tier === "runtime" || tier === "package-manager";
}

/**
 * Highest candidate index that can still name the tool being run.
 *
 * argv[0] always can. Anything further right counts only when argv[0] is a
 * command that runs another program named in its arguments — a shell, a
 * runtime, a package manager, an env/privilege prefix. For everything else
 * the remaining tokens are operands: `cat shared/config/agents/opencode.ts`,
 * `git log -- …/opencode.ts` and an editor opened on that file all name a
 * path, not an executable, and must not resolve to the agent. #11931
 *
 * A package manager's exec subcommand shifts the window one further right
 * (`pnpm exec vitest`).
 *
 * This is positional, not a full argv grammar — a flag that takes a value
 * (`node --require ts-node/register app.js`) still consumes a slot, so the
 * process-tree walk remains the primary signal.
 */
export function executablePositionLimit(candidates: string[]): number {
  if (!isExecutorCommand(candidates[0])) return 0;
  return candidates[1] && BINARY_EXEC_SUBCOMMANDS.has(candidates[1].toLowerCase()) ? 2 : 1;
}

/**
 * Chromium's own multi-process children, which every Electron app spawns and
 * which all carry a `--type=` switch naming their role.
 */
const CHROMIUM_CHILD_PROCESS_TYPES = new Set([
  "renderer",
  "utility",
  "gpu-process",
  "zygote",
  "sandbox-ipc",
  "crashpad-handler",
]);

/**
 * Is this process one of Chromium's internal helpers?
 *
 * Such a helper is never the identity of the terminal that launched the app,
 * and everything below it belongs to that app's own process scope. A nested
 * Daintree's pty-host is exactly this node, so its descendants are the *inner*
 * instance's agent terminals — walking into them brands the outer terminal
 * with an agent it never ran. #11931
 *
 * Matched on an exact argv token so an unrelated `--type=json` flag, a path
 * containing the string, or an operand after `--` cannot trip it.
 */
export function isChromiumChildProcess(command: string | undefined): boolean {
  if (!command || !command.includes("--type=")) return false;
  for (const token of splitShellLikeCommand(command)) {
    // Everything after a bare `--` is an operand, not a switch.
    if (token === "--") return false;
    if (!token.startsWith("--type=")) continue;
    if (CHROMIUM_CHILD_PROCESS_TYPES.has(token.slice("--type=".length).toLowerCase())) {
      return true;
    }
  }
  return false;
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
  const positionLimit = executablePositionLimit(candidates);
  let iconMatch: { name: string; icon: string; priority: number } | null = null;
  // Captured once so every lookup in this resolution sees one consistent map,
  // even if a plugin loads mid-pass.
  const processIconMap = getProcessIconMap();

  for (const [index, candidate] of candidates.entries()) {
    // Same executable-position rule as the process-tree path, and it binds
    // agents too: an argument that happens to name an agent is still an
    // argument. Candidates are in argv order, so nothing past the limit
    // qualifies either. #11931
    if (index > positionLimit) break;

    const lowerCandidate = candidate.toLowerCase();
    const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
    if (candidateAgent) {
      return {
        agentType: candidateAgent,
        processIconId: processIconMap[lowerCandidate],
        processName: candidate,
      };
    }

    const candidateIcon = processIconMap[lowerCandidate];
    if (candidateIcon) {
      // Tier preference, so a typed `npx vitest` reports Vitest rather than
      // npm. Strict `<` keeps argv order on ties.
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
