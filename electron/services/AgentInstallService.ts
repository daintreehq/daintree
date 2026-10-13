import { spawn } from "child_process";
import { getAgentConfig, type AgentInstallBlock } from "../../shared/config/agentRegistry.js";
import { getBaselinePrerequisites } from "./baselinePrerequisites.js";
import type {
  AgentInstallPayload,
  AgentInstallResult,
  AgentInstallProgressEvent,
} from "../../shared/types/ipc/system.js";
import { buildInstallEnv } from "../utils/spawnEnv.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { isWindowsShellShim, unwrapWindowsShim } from "../utils/windowsCliSpawn.js";
import {
  findWindowsCommand,
  resolveWindowsExecutable,
  windowsExecutableNotFound,
  windowsSystemTool,
} from "../utils/windowsExecutable.js";

function isManualOnlyCommand(command: string): boolean {
  if (/\|\s*(sudo\s+)?(bash|sh|zsh|pwsh)\b|\|\s*(iex|Invoke-Expression)\b/i.test(command)) {
    return true;
  }
  // A leading `sudo` has no pipe to catch it, but spawning it with piped stdio
  // hangs forever on a password prompt the user can never see. The baseline
  // Linux blocks (`sudo apt-get install git`, `sudo dnf install git`, …) are
  // exactly this shape, so they stay copy-paste only.
  return /^\s*sudo\b/i.test(command);
}

export function isBlockExecutable(block: AgentInstallBlock): boolean {
  if (!block.commands || block.commands.length === 0) return false;
  return block.commands.every((cmd) => !isManualOnlyCommand(cmd));
}

function parseCommand(command: string): { bin: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);
  const isWindows = process.platform === "win32";

  if (bin === "npm" || (isWindows && bin === "npm.cmd")) {
    // `--loglevel=error`, not `--silent`: silent drops npm's error report too,
    // and the stderr it leaves behind is the failure the user sees — an
    // EACCES on a root-owned global prefix was only ever "exit code 243".
    const suppressFlags = [
      "--loglevel=error",
      "--no-progress",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
    ];
    for (const flag of suppressFlags) {
      if (!args.includes(flag)) args.push(flag);
    }
  }

  return { bin, args };
}

interface InstallSpawn {
  command: string;
  args: string[];
  windowsVerbatimArguments?: true;
  /** Added to the install env: what an unwrapped shim would have set, or the batch path. */
  env?: Record<string, string>;
}

// What cmd.exe would read as syntax rather than text.
const CMD_SYNTAX = /["%^!&|<>\r\n]/;

// cmd.exe expands `%VAR%` once and never re-reads the result, so a batch path
// handed over in a variable reaches the quoted command as plain text, whatever
// it holds (`C:\Users\Jane & John`, a `%` or `^` in a folder name).
const BATCH_FILE_VAR = "DAINTREE_INSTALL_BATCH_FILE";

/**
 * What an install command starts on Windows (elsewhere it is the command as
 * written). The program is looked up in PATH only, since a bare name would
 * otherwise be searched for in the working directory first, and asynchronously,
 * so a stalled PATH entry cannot block Main. An `.exe` (winget, choco, uv, pip)
 * starts directly. A `.cmd` shim npm, pnpm or Yarn wrote is unwrapped to Node
 * and its script (or the executable it wraps) and started with an argument
 * vector, so neither its path nor its arguments pass through cmd.exe. Any other
 * batch file (Node's own `npm.cmd`) runs through the in-box cmd.exe with its
 * path in a variable; the command lines come from the registry, never the
 * renderer, but an argument cmd.exe would read as syntax is refused there.
 */
async function windowsInstallSpawn(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<InstallSpawn> {
  const file = /[\\/:]/.test(bin) ? bin : await findWindowsCommand(bin, env);
  if (file === null) throw windowsExecutableNotFound(bin);
  if (!isWindowsShellShim(file)) return { command: file, args };
  const node = (await resolveWindowsExecutable("node.exe", env)) ?? undefined;
  let unwrapped: Awaited<ReturnType<typeof unwrapWindowsShim>>;
  try {
    unwrapped = await unwrapWindowsShim(file, { env, node });
  } catch {
    // Unreadable, or naming a script or Node that is not there: let the batch
    // file run and report that itself.
    unwrapped = undefined;
  }
  if (unwrapped) {
    return {
      command: unwrapped.command,
      args: [...unwrapped.args, ...args],
      ...(unwrapped.env ? { env: unwrapped.env } : {}),
    };
  }
  if (/["\r\n]/.test(file) || args.some((arg) => !arg || /\s/.test(arg) || CMD_SYNTAX.test(arg))) {
    throw new Error(`Refusing to run ${bin} through cmd.exe: unsupported characters`);
  }
  return {
    command: windowsSystemTool("cmd.exe", env),
    args: ["/d", "/s", "/v:off", "/c", `""%${BATCH_FILE_VAR}%" ${args.join(" ")}"`],
    windowsVerbatimArguments: true,
    env: { [BATCH_FILE_VAR]: file },
  };
}

function runSingleCommand(
  command: string,
  jobId: string,
  onProgress: (event: AgentInstallProgressEvent) => void
): Promise<{ exitCode: number | null }> {
  const { bin, args } = parseCommand(command);
  const env = {
    ...buildInstallEnv(),
    CI: "1",
    NO_UPDATE_NOTIFIER: "1",
  };

  if (process.platform !== "win32") {
    return runInstallTarget({ command: bin, args }, env, jobId, onProgress);
  }
  return windowsInstallSpawn(bin, args, env).then(
    (target) => runInstallTarget(target, env, jobId, onProgress),
    (err: unknown) => {
      // Reported the way a failed spawn is: the message on stderr, exit 1.
      onProgress({ jobId, chunk: scrubSecrets((err as Error).message) + "\n", stream: "stderr" });
      return { exitCode: 1 };
    }
  );
}

function runInstallTarget(
  target: InstallSpawn,
  env: NodeJS.ProcessEnv,
  jobId: string,
  onProgress: (event: AgentInstallProgressEvent) => void
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    let finalized = false;
    const child = spawn(target.command, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: target.env ? { ...env, ...target.env } : env,
      shell: false,
      windowsHide: true,
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      onProgress({ jobId, chunk: scrubSecrets(chunk.toString()), stream: "stdout" });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      onProgress({ jobId, chunk: scrubSecrets(chunk.toString()), stream: "stderr" });
    });

    const finalize = (exitCode: number | null) => {
      if (finalized) return;
      finalized = true;
      resolve({ exitCode });
    };

    child.on("close", (code) => finalize(code));
    child.on("error", (err) => {
      onProgress({ jobId, chunk: scrubSecrets(err.message) + "\n", stream: "stderr" });
      finalize(1);
    });
  });
}

function selectOsBlocks(
  byOs: Partial<Record<"macos" | "windows" | "linux" | "generic", AgentInstallBlock[]>> | undefined
): AgentInstallBlock[] | undefined {
  const os = detectOS();
  const osBlocks = byOs?.[os];
  return osBlocks && osBlocks.length > 0 ? osBlocks : byOs?.generic;
}

/**
 * Resolves the install blocks for a payload. The renderer names a target — an
 * agent id or a baseline prerequisite tool — and main owns the mapping to
 * commands; renderer-supplied command strings are never accepted.
 */
function resolveInstallBlocks(
  payload: AgentInstallPayload
): { blocks: AgentInstallBlock[]; error?: never } | { blocks?: never; error: string } {
  if (payload.prerequisiteTool !== undefined) {
    const spec = getBaselinePrerequisites().find((s) => s.tool === payload.prerequisiteTool);
    if (!spec) {
      return { error: `Unknown prerequisite: ${payload.prerequisiteTool}` };
    }
    const blocks = selectOsBlocks(spec.installBlocks);
    if (!blocks || blocks.length === 0) {
      return { error: `No install blocks for ${payload.prerequisiteTool}` };
    }
    return { blocks };
  }

  const config = getAgentConfig(payload.agentId);
  if (!config) {
    return { error: `Unknown agent: ${payload.agentId}` };
  }
  const blocks = selectOsBlocks(config.install?.byOs);
  if (!blocks || blocks.length === 0) {
    return { error: `No install blocks for ${payload.agentId}` };
  }
  return { blocks };
}

// Installs in flight, keyed by target. The renderer guards against starting a
// second install of the same thing, but each project view is its own
// WebContentsView with its own store, so that guard is blind to the other
// views. Main is the only place that can see them all.
const inFlightTargets = new Set<string>();

/** Test seam — clears the in-flight install registry. */
export function resetInFlightInstalls(): void {
  inFlightTargets.clear();
}

export async function runAgentInstall(
  payload: AgentInstallPayload,
  onProgress: (event: AgentInstallProgressEvent) => void
): Promise<AgentInstallResult> {
  const resolved = resolveInstallBlocks(payload);
  if (resolved.error !== undefined) {
    return { success: false, exitCode: null, error: resolved.error };
  }
  const { blocks } = resolved;

  const methodIndex = payload.methodIndex ?? 0;
  // A prerequisite's blocks are not interchangeable — on macOS index 0 is
  // `brew install git` and index 1 hands off to Apple's installer — so an
  // out-of-range index must fail rather than silently run a different install.
  // The agent path keeps its long-standing fall back to index 0.
  if (payload.prerequisiteTool !== undefined) {
    if (!Number.isInteger(methodIndex) || methodIndex < 0 || methodIndex >= blocks.length) {
      return {
        success: false,
        exitCode: null,
        error: `No install method ${methodIndex} for ${payload.prerequisiteTool}`,
      };
    }
  }
  const block = blocks[methodIndex] ?? blocks[0];

  // Re-checked here even though the renderer gates the button: renderer gating
  // is presentation, main is the security boundary.
  if (!isBlockExecutable(block)) {
    return {
      success: false,
      exitCode: null,
      error:
        "This install method requires manual execution (copy the command and run it in your terminal)",
    };
  }

  if (!block.commands || block.commands.length === 0) {
    return { success: false, exitCode: null, error: "No commands in install block" };
  }

  const target =
    payload.prerequisiteTool !== undefined
      ? `prerequisite:${payload.prerequisiteTool}`
      : `agent:${payload.agentId}`;
  if (inFlightTargets.has(target)) {
    return { success: false, exitCode: null, error: "That install is already running" };
  }
  inFlightTargets.add(target);

  try {
    for (const command of block.commands) {
      const result = await runSingleCommand(command, payload.jobId, onProgress);
      if (result.exitCode !== 0) {
        return {
          success: false,
          exitCode: result.exitCode,
          error: `Command failed with exit code ${result.exitCode}: ${command}`,
        };
      }
    }
  } finally {
    inFlightTargets.delete(target);
  }

  return { success: true, exitCode: 0 };
}

function detectOS(): "macos" | "windows" | "linux" | "generic" {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "generic";
  }
}
