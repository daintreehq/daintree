import type { TerminalType } from "../../shared/types/domain.js";
import type { ProcessTreeCache } from "./ProcessTreeCache.js";
import { logDebug, logWarn } from "../utils/logger.js";

interface ChildProcess {
  pid: number;
  name: string;
  command?: string;
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
  isBusy?: boolean;
  currentCommand?: string;
}

export type DetectionCallback = (result: DetectionResult, spawnedAt: number) => void;

export class ProcessDetector {
  private terminalId: string;
  private spawnedAt: number;
  private ptyPid: number;
  private callback: DetectionCallback;
  private lastDetected: TerminalType | null = null;
  private lastBusyState: boolean | null = null;
  private lastCurrentCommand: string | undefined;
  private cache: ProcessTreeCache;
  private unsubscribe: (() => void) | null = null;
  private isStarted: boolean = false;

  constructor(
    terminalId: string,
    spawnedAt: number,
    ptyPid: number,
    callback: DetectionCallback,
    cache: ProcessTreeCache
  ) {
    this.terminalId = terminalId;
    this.spawnedAt = spawnedAt;
    this.ptyPid = ptyPid;
    this.callback = callback;
    this.cache = cache;
  }

  start(): void {
    if (this.isStarted) {
      logWarn(`ProcessDetector for terminal ${this.terminalId} already started`);
      return;
    }

    logDebug(`Starting ProcessDetector for terminal ${this.terminalId}, PID ${this.ptyPid}`);

    this.isStarted = true;
    this.detect();

    this.unsubscribe = this.cache.onRefresh(() => {
      this.detect();
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      logDebug(`Stopped ProcessDetector for terminal ${this.terminalId}`);
    }
    this.isStarted = false;
  }

  private detect(): void {
    try {
      const result = this.detectAgent();

      const agentChanged =
        (result.detected && result.agentType !== this.lastDetected) ||
        (!result.detected && this.lastDetected !== null);

      const busyChanged = result.isBusy !== undefined && result.isBusy !== this.lastBusyState;

      const commandChanged = result.currentCommand !== this.lastCurrentCommand;

      if (result.detected) {
        this.lastDetected = result.agentType!;
      } else if (this.lastDetected !== null) {
        this.lastDetected = null;
      }

      if (result.isBusy !== undefined) {
        this.lastBusyState = result.isBusy;
      }

      this.lastCurrentCommand = result.currentCommand;

      if (agentChanged || busyChanged || commandChanged) {
        this.callback(result, this.spawnedAt);
      }
    } catch (_error) {
      console.error(`ProcessDetector error for terminal ${this.terminalId}:`, _error);
    }
  }

  private detectAgent(): DetectionResult {
    if (!Number.isInteger(this.ptyPid) || this.ptyPid <= 0) {
      console.warn(`Invalid PTY PID for terminal ${this.terminalId}: ${this.ptyPid}`);
      return { detected: false, isBusy: false };
    }

    const children = this.cache.getChildren(this.ptyPid);
    const isBusy = children.length > 0;

    if (!isBusy) {
      return { detected: false, isBusy: false, currentCommand: undefined };
    }

    const processes: ChildProcess[] = children.map((p) => ({
      pid: p.pid,
      name: p.comm,
      command: p.command,
    }));

    const primaryProcess = processes[0];
    const currentCommand = primaryProcess?.command;

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

    // On Windows, also check grandchildren for agent processes
    if (process.platform === "win32") {
      for (const child of children.slice(0, 10)) {
        const grandchildren = this.cache.getChildren(child.pid);
        for (const grandchild of grandchildren) {
          const basename = grandchild.comm.split("/").pop() || grandchild.comm;
          const agentType = AGENT_CLI_NAMES[basename.toLowerCase()];
          if (agentType) {
            return {
              detected: true,
              agentType,
              processName: basename,
              isBusy,
              currentCommand: grandchild.command || grandchild.comm,
            };
          }
        }
      }
    }

    return { detected: false, isBusy, currentCommand };
  }

  getLastDetected(): TerminalType | null {
    return this.lastDetected;
  }
}
