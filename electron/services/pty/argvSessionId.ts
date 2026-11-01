import type { AgentResumeArgv } from "../../../shared/config/agentRegistry.js";
import { stripCommandExecutableExtension } from "../ProcessDetector/commandParser.js";

/** Runtimes that run an agent as a script: the script names the agent, not argv[0]. */
const SCRIPT_RUNTIMES = new Set(["node", "nodejs", "bun"]);

/**
 * Split a command line as the OS reports it (`ps`, Win32 `CommandLine`).
 * Double quotes group, because Windows quotes a path with spaces; a backslash
 * is a path separator, never an escape. POSIX `ps` joins argv with spaces and
 * keeps no quoting at all, so an argument that held spaces comes back as
 * several tokens: parsing below only ever misses on that, since an id has to
 * match its pattern in full.
 */
function splitReportedCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quoted = false;
  for (const char of command) {
    if (char === '"') {
      quoted = !quoted;
      inToken = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += char;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

function commandName(token: string): string {
  const basename = token.split(/[\\/]/).pop() ?? "";
  return stripCommandExecutableExtension(basename).toLowerCase();
}

/** Index of the first argument after the agent's own executable, or null if it isn't one. */
function argumentsStart(tokens: string[], executable: string): number | null {
  const name = executable.toLowerCase();
  const first = tokens[0];
  if (first === undefined) return null;
  if (commandName(first) === name) return 1;
  if (!SCRIPT_RUNTIMES.has(commandName(first))) return null;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].startsWith("-")) continue;
    return commandName(tokens[i]) === name ? i + 1 : null;
  }
  return null;
}

function isExcluded(token: string, excluded: readonly string[]): boolean {
  const name = token.split("=", 1)[0];
  // A short flag can carry its value attached (`-ifile.png`).
  return excluded.some((flag) => name === flag || (/^-[^-]$/.test(flag) && token.startsWith(flag)));
}

/**
 * The session id a process's command line resumes, read positionally per the
 * agent's {@link AgentResumeArgv} (#15994): the declared subcommand must be the
 * first positional, and the id is the positional right after it. Anything this
 * can't read with certainty — an unknown launcher, an option it doesn't know
 * taking a value, an excluded flag, an id of the wrong shape — is null.
 *
 * The command line is a resume credential and may hold other secrets: callers
 * keep it inside the pty-host and never log it.
 */
export function readArgvSessionId(
  command: string,
  executable: string,
  spec: AgentResumeArgv
): string | null {
  const tokens = splitReportedCommandLine(command);
  const start = argumentsStart(tokens, executable);
  if (start === null) return null;

  const excluded = spec.excludedFlags ?? [];
  const args = tokens.slice(start);
  if (args.some((token) => token.startsWith("-") && isExcluded(token, excluded))) return null;

  let pattern: RegExp;
  try {
    pattern = new RegExp(spec.sessionIdPattern);
  } catch {
    return null;
  }

  const withValue = new Set(spec.optionsWithValue ?? []);
  let subcommandSeen = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    // After `--` every token is positional, which the walk below can't tell
    // from an option's value; rare enough to read as no id.
    if (token === "--") return null;
    if (token.startsWith("-") && token.length > 1) {
      if (!token.includes("=") && withValue.has(token)) i++;
      continue;
    }
    if (!subcommandSeen) {
      if (token !== spec.subcommand) return null;
      subcommandSeen = true;
      continue;
    }
    const match = pattern.exec(token);
    return match !== null && match[0] === token ? token : null;
  }
  return null;
}
