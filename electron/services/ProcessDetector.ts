import { exec } from "child_process";
import { promisify } from "util";
import type { TerminalType } from "../../shared/types/domain.js";

const execAsync = promisify(exec);

interface ChildProcess {
  pid: number;
  name: string;
  command?: string;
}

/**
 * Get child processes using PowerShell's Get-CimInstance (modern, fast).
 * Available on Windows 10+ with PowerShell 5.1+.
 */
async function getChildProcessesPowerShell(pid: number): Promise<ChildProcess[]> {
  const { stdout } = await execAsync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq ${pid}} | Select-Object ProcessId,Name | ConvertTo-Json -Compress"`,
    { timeout: 5000 }
  );

  const trimmed = stdout.replace(/^\uFEFF/, "").trim();
  if (!trimmed || trimmed === "null") {
    return [];
  }

  let result;
  try {
    result = JSON.parse(trimmed);
  } catch (error) {
    console.warn("PowerShell process JSON parse failed", {
      pid,
      outputSample: trimmed.slice(0, 200),
    });
    throw error;
  }
  // Single object if one match, array if multiple
  const processes = Array.isArray(result) ? result : [result];

  return processes
    .map((p) => ({
      pid: Number.parseInt(String(p?.ProcessId), 10),
      name: (p?.Name || "").replace(/\.exe$/i, ""),
      command:
        typeof p?.CommandLine === "string" && p.CommandLine.trim().length > 0
          ? String(p.CommandLine).trim()
          : undefined,
    }))
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.name);
}

/**
 * Get child processes using wmic (legacy fallback for older Windows).
 * Deprecated but works on Windows 7-10 systems where wmic is still available.
 */
async function getChildProcessesWmic(pid: number): Promise<ChildProcess[]> {
  const { stdout } = await execAsync(
    `wmic process where "ParentProcessId=${pid}" get ProcessId,Name /format:csv 2>nul`,
    { timeout: 5000 }
  );

  const lines = stdout.split("\n").filter((line) => line.trim());
  const processes: ChildProcess[] = [];

  // Skip header line (first non-empty line is header in CSV format)
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(",");
    // CSV format: Node,Name,ProcessId
    if (parts.length >= 3) {
      const name = parts[1];
      const childPid = parseInt(parts[2], 10);
      if (!isNaN(childPid) && name) {
        processes.push({
          pid: childPid,
          name: name.replace(/\.exe$/i, ""),
        });
      }
    }
  }

  return processes;
}

/**
 * Get child processes on Windows with PowerShell primary, wmic fallback.
 * Returns empty array if both methods fail (graceful degradation).
 */
async function getChildProcessesWindows(pid: number): Promise<ChildProcess[]> {
  // Try PowerShell first (modern, faster)
  try {
    return await getChildProcessesPowerShell(pid);
  } catch (psError) {
    // PowerShell failed, try wmic fallback
    try {
      return await getChildProcessesWmic(pid);
    } catch (wmicError) {
      // Both methods failed - log and return empty (graceful degradation)
      console.warn("Windows process detection failed:", {
        pid,
        powershell: psError instanceof Error ? psError.message : String(psError),
        wmic: wmicError instanceof Error ? wmicError.message : String(wmicError),
      });
      return [];
    }
  }
}

/**
 * Check if a process has any child processes running.
 * Used for shell terminals to determine busy/idle state.
 */
export async function hasChildProcesses(pid: number): Promise<boolean> {
  try {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    if (process.platform === "win32") {
      const children = await getChildProcessesWindows(pid);
      return children.length > 0;
    } else {
      // macOS/Linux: pgrep returns 0 when children exist, 1 when none exist
      try {
        await execAsync(`pgrep -P ${pid}`, { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  }
}

const AGENT_CLI_NAMES: Record<string, TerminalType> = {
  claude: "claude",
  gemini: "gemini",
  codex: "codex",
};

export interface DetectionResult {
  detected: boolean;
  agentType?: TerminalType;
  processName?: string;
  /** Whether the terminal has active child processes (busy/idle status) */
  isBusy?: boolean;
  /** Best-effort current command line for the foreground process */
  currentCommand?: string;
}

export type DetectionCallback = (result: DetectionResult) => void;

export class ProcessDetector {
  private terminalId: string;
  private ptyPid: number;
  private callback: DetectionCallback;
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastDetected: TerminalType | null = null;
  private lastBusyState: boolean | null = null;
  private lastCurrentCommand: string | undefined;
  private pollInterval: number;
  private isWindows: boolean;
  private isDetecting: boolean = false;

  constructor(
    terminalId: string,
    ptyPid: number,
    callback: DetectionCallback,
    pollInterval: number = 1000
  ) {
    this.terminalId = terminalId;
    this.ptyPid = ptyPid;
    this.callback = callback;
    this.pollInterval = pollInterval;
    this.isWindows = process.platform === "win32";
  }

  start(): void {
    if (this.intervalHandle) {
      console.warn(`ProcessDetector for terminal ${this.terminalId} already started`);
      return;
    }

    console.log(`Starting ProcessDetector for terminal ${this.terminalId}, PID ${this.ptyPid}`);

    this.detect();

    this.intervalHandle = setInterval(() => {
      this.detect();
    }, this.pollInterval);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log(`Stopped ProcessDetector for terminal ${this.terminalId}`);
    }
  }

  private async detect(): Promise<void> {
    if (this.isDetecting) {
      return;
    }

    this.isDetecting = true;
    try {
      const result = await this.detectAgent();

      // Check if agent detection changed
      const agentChanged =
        (result.detected && result.agentType !== this.lastDetected) ||
        (!result.detected && this.lastDetected !== null);

      // Check if busy state changed
      const busyChanged = result.isBusy !== undefined && result.isBusy !== this.lastBusyState;

      // Check if the foreground command changed (e.g., npm install -> npm run dev)
      const commandChanged = result.currentCommand !== this.lastCurrentCommand;

      // Update tracked states
      if (result.detected) {
        this.lastDetected = result.agentType!;
      } else if (this.lastDetected !== null) {
        this.lastDetected = null;
      }

      if (result.isBusy !== undefined) {
        this.lastBusyState = result.isBusy;
      }

      this.lastCurrentCommand = result.currentCommand;

      // Fire callback if agent, busy state, or current command changed
      if (agentChanged || busyChanged || commandChanged) {
        this.callback(result);
      }
    } catch (_error) {
      console.error(`ProcessDetector error for terminal ${this.terminalId}:`, _error);
    } finally {
      this.isDetecting = false;
    }
  }

  private async detectAgent(): Promise<DetectionResult> {
    if (this.isWindows) {
      return this.detectAgentWindows();
    } else {
      return this.detectAgentUnix();
    }
  }

  private async detectAgentUnix(): Promise<DetectionResult> {
    try {
      if (!Number.isInteger(this.ptyPid) || this.ptyPid <= 0) {
        console.warn(`Invalid PTY PID for terminal ${this.terminalId}: ${this.ptyPid}`);
        return { detected: false, isBusy: false };
      }

      // Use pgrep to find direct children of the PTY process.
      // -P <pid>: list children of the given parent
      const { stdout } = await execAsync(`pgrep -P ${this.ptyPid}`, {
        timeout: 5000,
      });

      const childPids = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);

      // Any direct children mean the shell is running a foreground command
      const isBusy = childPids.length > 0;
      if (!isBusy) {
        return { detected: false, isBusy: false, currentCommand: undefined };
      }

      let processes: ChildProcess[] = childPids.map((pid) => ({ pid, name: String(pid) }));
      let currentCommand: string | undefined;

      try {
        // ps -o pid=,comm=,command= works on both macOS (BSD ps) and Linux.
        const { stdout: psOut } = await execAsync(
          `ps -o pid=,comm=,command= -p ${childPids.join(",")}`,
          { timeout: 5000 }
        );

        const byPid = new Map<number, ChildProcess>();

        psOut
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .forEach((line) => {
            // Robust parsing:
            // 1. Extract PID (first digits)
            // 2. Extract COMM (next non-whitespace token, might be path)
            // 3. Everything else is COMMAND

                        // Match: Start, Optional Space, Digits (PID), Spaces, Non-Spaces (COMM), Spaces, Rest (COMMAND)

                        // Fix: Added \s* at start to handle padded PIDs from ps

                        const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);

            

                        const pid = match ? Number.parseInt(match[1], 10) : NaN;
            if (!Number.isInteger(pid) || pid <= 0) return;

            const name = match ? match[2] : "";
            const command = match ? match[3].trim() : "";

            byPid.set(pid, {
              pid,
              name: name || String(pid),
              // If command is empty, fallback to name
              command: command || name || undefined,
            });
          });

        processes = childPids.map((pid) => byPid.get(pid) || { pid, name: String(pid) });
        const primaryPid = childPids[0];
        const primary = byPid.get(primaryPid);
        if (primary?.command) {
          currentCommand = primary.command;
        }
      } catch {
        // If ps fails, fall back to pid-based names only
        processes = childPids.map((pid) => ({ pid, name: String(pid) }));
      }

      // Check for agent CLIs in child processes
      for (const proc of processes) {
        const basename = proc.name.split("/").pop() || proc.name;
        const agentType = AGENT_CLI_NAMES[basename.toLowerCase()];

        if (agentType) {
          return {
            detected: true,
            agentType,
            processName: basename,
            isBusy,
            currentCommand,
          };
        }
      }

      return { detected: false, isBusy, currentCommand };
    } catch (_error) {
      // pgrep exits with code 1 when no processes are found – treat as idle shell
      return { detected: false, isBusy: false, currentCommand: undefined };
    }
  }

  private async detectAgentWindows(): Promise<DetectionResult> {
    try {
      if (!Number.isInteger(this.ptyPid) || this.ptyPid <= 0) {
        console.warn(`Invalid PTY PID for terminal ${this.terminalId}: ${this.ptyPid}`);
        return { detected: false, isBusy: false };
      }

      // Get direct children of the PTY process
      const children = await getChildProcessesWindows(this.ptyPid);
      const isBusy = children.length > 0;
      const currentCommand = children[0]?.command || children[0]?.name;

      // Check direct children for agent CLIs
      for (const child of children) {
        const agentType = AGENT_CLI_NAMES[child.name.toLowerCase()];
        if (agentType) {
          return {
            detected: true,
            agentType,
            processName: child.name,
            isBusy,
            currentCommand,
          };
        }
      }

      // Check grandchildren (agent may be spawned by intermediate shell)
      for (const child of children.slice(0, 10)) {
        try {
          const grandchildren = await getChildProcessesWindows(child.pid);
          for (const grandchild of grandchildren) {
            const agentType = AGENT_CLI_NAMES[grandchild.name.toLowerCase()];
            if (agentType) {
              return {
                detected: true,
                agentType,
                processName: grandchild.name,
                isBusy,
                currentCommand: grandchild.command || grandchild.name,
              };
            }
          }
        } catch {
          // Ignore errors checking grandchildren
        }
      }

      return { detected: false, isBusy, currentCommand };
    } catch (_error) {
      return { detected: false, isBusy: false, currentCommand: undefined };
    }
  }

  getLastDetected(): TerminalType | null {
    return this.lastDetected;
  }
}
