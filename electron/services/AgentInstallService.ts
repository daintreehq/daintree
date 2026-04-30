import { spawn } from "child_process";
import { getAgentConfig, type AgentInstallBlock } from "../../shared/config/agentRegistry.js";
import type {
  AgentInstallPayload,
  AgentInstallResult,
  AgentInstallProgressEvent,
} from "../../shared/types/ipc/system.js";
import { buildInstallEnv } from "../utils/spawnEnv.js";
import { scrubSecrets } from "../utils/secretScrubber.js";

function isManualOnlyCommand(command: string): boolean {
  return /\|\s*(bash|sh|zsh)\b/.test(command) || /\|\s*iex\b/.test(command);
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

export async function runAgentInstall(
  payload: AgentInstallPayload,
  onProgress: (event: AgentInstallProgressEvent) => void
): Promise<AgentInstallResult> {
  const config = getAgentConfig(payload.agentId);
  if (!config) {
    return { success: false, exitCode: null, error: `Unknown agent: ${payload.agentId}` };
  }

  const os = detectOS();
  const osBlocks = config.install?.byOs?.[os];
  const blocks = osBlocks && osBlocks.length > 0 ? osBlocks : config.install?.byOs?.generic;
  if (!blocks || blocks.length === 0) {
    return { success: false, exitCode: null, error: `No install blocks for ${payload.agentId}` };
  }

  const methodIndex = payload.methodIndex ?? 0;
  const block = blocks[methodIndex] ?? blocks[0];

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
