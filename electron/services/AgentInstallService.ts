import { spawn } from "child_process";
import { getAgentConfig, type AgentInstallBlock } from "../../shared/config/agentRegistry.js";
import type {
  AgentInstallPayload,
  AgentInstallResult,
  AgentInstallProgressEvent,
} from "../../shared/types/ipc/system.js";

function isManualOnlyCommand(command: string): boolean {
  return /\|\s*(bash|sh|zsh)\b/.test(command) || /\|\s*iex\b/.test(command);
}

export function isBlockExecutable(block: AgentInstallBlock): boolean {
  if (!block.commands || block.commands.length === 0) return false;
  return block.commands.every((cmd) => !isManualOnlyCommand(cmd));
}

function parseCommand(command: string): { bin: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  let bin = parts[0];

  if (bin === "npm" && process.platform === "win32") {
    bin = "npm.cmd";
  }

  const args = parts.slice(1);

  if (bin === "npm" || bin === "npm.cmd") {
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

  return { bin, args };
}

function runSingleCommand(
  command: string,
  jobId: string,
  onProgress: (event: AgentInstallProgressEvent) => void
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    const { bin, args } = parseCommand(command);
    let finalized = false;

    const env = {
      ...process.env,
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
    };

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: false,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      onProgress({ jobId, chunk: chunk.toString(), stream: "stdout" });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      onProgress({ jobId, chunk: chunk.toString(), stream: "stderr" });
    });

    const finalize = (exitCode: number | null) => {
      if (finalized) return;
      finalized = true;
      resolve({ exitCode });
    };

    child.on("close", (code) => finalize(code));
    child.on("error", (err) => {
      onProgress({ jobId, chunk: err.message + "\n", stream: "stderr" });
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
  const blocks = config.install?.byOs?.[os] ?? config.install?.byOs?.generic;
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
