import { spawn } from "child_process";
import { getAgentConfig, type AgentInstallBlock } from "../../shared/config/agentRegistry.js";
import { BASELINE_PREREQUISITES } from "./baselinePrerequisites.js";
import type {
  AgentInstallPayload,
  AgentInstallResult,
  AgentInstallProgressEvent,
} from "../../shared/types/ipc/system.js";
import { buildInstallEnv } from "../utils/spawnEnv.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";

function isManualOnlyCommand(command: string): boolean {
  if (/\|\s*(sudo\s+)?(bash|sh|zsh|pwsh)\b|\|\s*(iex|Invoke-Expression)\b/i.test(command)) {
    return true;
  }
  // A leading `sudo` has no pipe to catch it, but spawning it with piped stdio
  // hangs forever on a password prompt the user can never see. The baseline
  // Linux blocks (`sudo apt-get install git`) are exactly this shape, so they
  // stay copy-paste only.
  return /^\s*sudo\b/i.test(command);
}

export function isBlockExecutable(block: AgentInstallBlock): boolean {
  if (!block.commands || block.commands.length === 0) return false;
  return block.commands.every((cmd) => !isManualOnlyCommand(cmd));
}

// Windows shell shims (.cmd/.ps1) need shell: true to resolve
const WINDOWS_CMD_BINS = new Set(["npm", "scoop", "choco", "pnpm", "yarn"]);

function parseCommand(command: string): { bin: string; args: string[]; useShell: boolean } {
  const parts = command.trim().split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);
  const isWindows = process.platform === "win32";

  if (bin === "npm" || (isWindows && bin === "npm.cmd")) {
    const suppressFlags = [
      "--silent",
      "--no-progress",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
    ];
    for (const flag of suppressFlags) {
      if (!args.includes(flag)) args.push(flag);
    }
  }

  // On Windows, shell shims need shell: true to resolve .cmd extensions
  const useShell = isWindows && WINDOWS_CMD_BINS.has(bin);

  return { bin, args, useShell };
}

function runSingleCommand(
  command: string,
  jobId: string,
  onProgress: (event: AgentInstallProgressEvent) => void
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    const { bin, args, useShell } = parseCommand(command);
    let finalized = false;

    const env = {
      ...buildInstallEnv(),
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
    };

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: useShell,
      windowsHide: true,
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
    const spec = BASELINE_PREREQUISITES.find((s) => s.tool === payload.prerequisiteTool);
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
