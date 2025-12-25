import { execFile } from "child_process";
import { promisify } from "util";
import { AGENT_REGISTRY } from "../../shared/config/agentRegistry.js";
import type { AgentHelpResult } from "../../shared/types/ipc/agent.js";

const execFileAsync = promisify(execFile);

interface CachedResult {
  result: AgentHelpResult;
  timestamp: number;
}

export class AgentHelpService {
  private cache = new Map<string, CachedResult>();
  private readonly CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly TIMEOUT_MS = 5000;
  private readonly MAX_BUFFER = 256 * 1024;

  async getHelp(agentId: string, refresh = false): Promise<AgentHelpResult> {
    const config = AGENT_REGISTRY[agentId];
    if (!config) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    if (!this.isValidCommand(config.command)) {
      throw new Error(`Invalid command: ${config.command}`);
    }

    const cached = this.cache.get(agentId);
    if (!refresh && cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.CACHE_TTL_MS) {
        return cached.result;
      }
    }

    const helpArgs = config.help?.args ?? ["--help"];
    const result = await this.executeHelp(config.command, helpArgs);

    this.cache.set(agentId, {
      result,
      timestamp: Date.now(),
    });

    return result;
  }

  private isValidCommand(command: string): boolean {
    if (typeof command !== "string" || !command.trim()) {
      return false;
    }
    if (command.includes("&&") || command.includes(";") || command.includes("|")) {
      return false;
    }
    return true;
  }

  private async executeHelp(command: string, args: string[]): Promise<AgentHelpResult> {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let truncated = false;

    try {
      const { stdout: out, stderr: err } = await execFileAsync(command, args, {
        timeout: this.TIMEOUT_MS,
        maxBuffer: this.MAX_BUFFER,
        shell: false,
        windowsHide: true,
      });

      stdout = out || "";
      stderr = err || "";
      exitCode = 0;
    } catch (error: any) {
      if (error.killed || error.code === "ETIMEDOUT") {
        timedOut = true;
      }

      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        truncated = true;
      }

      stdout = error.stdout?.toString() || "";
      stderr = error.stderr?.toString() || "";

      if (typeof error.code === "number") {
        exitCode = error.code;
      } else if (error.code === "ENOENT") {
        exitCode = null;
        stderr = stderr || `Command not found: ${command}`;
      } else {
        exitCode = null;
        stderr = stderr || error.message || "Command failed";
      }

      const combined = stdout.length + stderr.length;
      if (combined > this.MAX_BUFFER) {
        truncated = true;
        const ratio = stdout.length / combined;
        const maxStdout = Math.floor(this.MAX_BUFFER * ratio);
        const maxStderr = this.MAX_BUFFER - maxStdout;

        stdout = stdout.slice(0, maxStdout);
        stderr = stderr.slice(0, maxStderr);
      }
    }

    return {
      stdout,
      stderr,
      exitCode,
      timedOut,
      truncated,
    };
  }
}
