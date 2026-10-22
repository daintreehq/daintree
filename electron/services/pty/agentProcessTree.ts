import path from "node:path";
import type { AgentProcessTreeKind } from "../../../shared/types/processes.js";
import type { ProcessInfo } from "../ProcessTreeCache.js";
import {
  detectCommandIdentity,
  stripCommandExecutableExtension,
} from "../ProcessDetector/commandParser.js";
import { AGENT_CLI_NAMES } from "../ProcessDetector/registries.js";

/**
 * Interactive shells, by executable basename. A root process outside this set
 * is something the terminal was launched straight into (a REPL, `ssh`, a dev
 * server), which is running work even with no children.
 */
const PLAIN_SHELLS = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ksh",
  "mksh",
  "tcsh",
  "csh",
  "nu",
  "elvish",
  "xonsh",
  "pwsh",
  "powershell",
  "cmd",
]);

function executableName(comm: string): string {
  let name = path.basename(comm.replace(/\\/g, "/")).toLowerCase();
  // A login shell's argv[0] is prefixed with `-` (`-zsh`).
  if (name.startsWith("-")) name = name.slice(1);
  return name;
}

export function isPlainShellName(comm: string): boolean {
  let name = executableName(comm);
  if (name.endsWith(".exe")) name = name.slice(0, -4);
  return PLAIN_SHELLS.has(name);
}

/**
 * Agents whose process tree has been checked against a running CLI: every
 * tool call, background shell and Monitor task it starts runs in a shell
 * directly under it, and its other children are MCP servers and its own
 * helpers. Any other agent's tree can't be told apart, so it reads `unknown`.
 */
const VERIFIED_AGENT_TREES: ReadonlySet<string> = new Set(["claude"]);

/** The slice of the census a classification reads. */
export interface AgentTreeCensus {
  getProcess(pid: number): Pick<ProcessInfo, "pid" | "comm" | "command"> | undefined;
  getChildPids(pid: number): number[];
}

function runsAgent(proc: Pick<ProcessInfo, "comm" | "command">, agentId: string): boolean {
  const name = stripCommandExecutableExtension(executableName(proc.comm));
  if (AGENT_CLI_NAMES[name] === agentId) return true;
  return detectCommandIdentity(proc.command)?.agentType === agentId;
}

/**
 * What a launched agent's terminal holds, read from the full census rather
 * than the capped resource breakdown (#13854). The PTY root is the launch
 * wrapper shell, and the agent its only child. Below the agent, a shell is
 * work the agent started (a tool call, a background shell, a Monitor) that
 * dies with it and doesn't come back on resume; anything else is an MCP
 * server or the runtime's own helper. A server's own launcher may run
 * through `sh -c` (`npm exec` does), so nothing below a server is read.
 */
export function classifyAgentTree(
  census: AgentTreeCensus,
  rootPid: number,
  launchAgentId: string
): AgentProcessTreeKind {
  if (!VERIFIED_AGENT_TREES.has(launchAgentId)) return "unknown";
  const root = census.getProcess(rootPid);
  if (!root?.comm) return "unknown";
  if (!isPlainShellName(root.comm)) return "other";
  const rootChildren = census.getChildPids(rootPid);
  if (rootChildren.length !== 1) return "other";
  const runtime = census.getProcess(rootChildren[0]);
  if (!runtime?.comm) return "unknown";
  if (!runsAgent(runtime, launchAgentId)) return "other";
  for (const pid of census.getChildPids(runtime.pid)) {
    const child = census.getProcess(pid);
    if (!child?.comm) return "unknown";
    if (isPlainShellName(child.comm)) return "other";
  }
  return "runtime-and-servers";
}
