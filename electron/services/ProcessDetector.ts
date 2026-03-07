import type { TerminalType } from "../../shared/types/domain.js";
import type { ProcessTreeCache } from "./ProcessTreeCache.js";
import { logDebug, logWarn } from "../utils/logger.js";

interface ChildProcess {
  pid: number;
  name: string;
  command?: string;
}

interface DetectedProcessCandidate {
  agentType?: TerminalType;
  processIconId?: string;
  processName: string;
  processCommand?: string;
  priority: number;
  order: number;
}

const AGENT_CLI_NAMES: Record<string, TerminalType> = {
  claude: "claude",
  gemini: "gemini",
  codex: "codex",
  opencode: "opencode",
};

const PROCESS_ICON_MAP: Record<string, string> = {
  // AI agents
  claude: "claude",
  gemini: "gemini",
  codex: "codex",
  opencode: "opencode",
  // Package managers
  npm: "npm",
  npx: "npm",
  yarn: "yarn",
  pnpm: "pnpm",
  bun: "bun",
  composer: "composer",
  // Language runtimes
  python: "python",
  python3: "python",
  node: "node",
  deno: "deno",
  ruby: "ruby",
  rails: "ruby",
  bundle: "ruby",
  go: "go",
  cargo: "rust",
  rustc: "rust",
  php: "php",
  kotlin: "kotlin",
  kotlinc: "kotlin",
  swift: "swift",
  swiftc: "swift",
  elixir: "elixir",
  mix: "elixir",
  iex: "elixir",
  // Build tools
  gradle: "gradle",
  gradlew: "gradle",
  webpack: "webpack",
  vite: "vite",
  // Infrastructure
  docker: "docker",
  terraform: "terraform",
  tofu: "terraform",
};

const PACKAGE_MANAGER_ICON_IDS = new Set(["npm", "yarn", "pnpm", "bun", "composer"]);

export interface DetectionResult {
  detected: boolean;
  agentType?: TerminalType;
  processIconId?: string;
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
  private lastProcessIconId: string | null = null;
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

      const nextAgent = result.agentType ?? null;
      const agentChanged =
        (result.detected && nextAgent !== this.lastDetected) ||
        (!result.detected && this.lastDetected !== null);

      const processIconChanged = (result.processIconId ?? null) !== this.lastProcessIconId;

      const busyChanged = result.isBusy !== undefined && result.isBusy !== this.lastBusyState;

      const commandChanged = result.currentCommand !== this.lastCurrentCommand;

      if (result.detected) {
        this.lastDetected = result.agentType ?? null;
        this.lastProcessIconId = result.processIconId ?? null;
      } else {
        this.lastDetected = null;
        this.lastProcessIconId = null;
      }

      if (result.isBusy !== undefined) {
        this.lastBusyState = result.isBusy;
      }

      this.lastCurrentCommand = result.currentCommand;

      if (agentChanged || processIconChanged || busyChanged || commandChanged) {
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

    let bestMatch: DetectedProcessCandidate | null = null;
    let order = 0;

    for (const proc of processes) {
      const candidate = this.buildDetectedCandidate(proc.name, proc.command, order++);
      if (candidate) {
        bestMatch = this.selectPreferredCandidate(bestMatch, candidate);
      }
    }

    // On Windows, check grandchildren as well (common when child is a shell wrapper).
    if (process.platform === "win32") {
      for (const child of children.slice(0, 10)) {
        const grandchildren = this.cache.getChildren(child.pid);
        for (const grandchild of grandchildren) {
          const candidate = this.buildDetectedCandidate(
            grandchild.comm,
            grandchild.command || grandchild.comm,
            order++
          );
          if (candidate) {
            bestMatch = this.selectPreferredCandidate(bestMatch, candidate);
          }
        }
      }
    }

    if (bestMatch) {
      return {
        detected: true,
        agentType: bestMatch.agentType,
        processIconId: bestMatch.processIconId,
        processName: bestMatch.processName,
        isBusy,
        currentCommand: bestMatch.processCommand || processes[0]?.command,
      };
    }

    const primaryProcess = processes[0];
    const currentCommand = primaryProcess?.command;

    return { detected: false, isBusy, currentCommand };
  }

  getLastDetected(): TerminalType | null {
    return this.lastDetected;
  }

  private normalizeProcessName(name: string): string {
    const basename = name.split(/[\\/]/).pop() || name;
    return basename.replace(/\.exe$/i, "");
  }

  private buildDetectedCandidate(
    processName: string,
    processCommand: string | undefined,
    order: number
  ): DetectedProcessCandidate | null {
    const normalizedName = this.normalizeProcessName(processName);
    const lowerName = normalizedName.toLowerCase();
    const agentType = AGENT_CLI_NAMES[lowerName];
    const processIconId = PROCESS_ICON_MAP[lowerName];

    if (!agentType && !processIconId) {
      return null;
    }

    return {
      agentType,
      processIconId,
      processName: normalizedName,
      processCommand,
      priority: this.getDetectionPriority(agentType, processIconId),
      order,
    };
  }

  private selectPreferredCandidate(
    current: DetectedProcessCandidate | null,
    candidate: DetectedProcessCandidate
  ): DetectedProcessCandidate {
    if (!current) {
      return candidate;
    }

    if (candidate.priority < current.priority) {
      return candidate;
    }

    if (candidate.priority === current.priority && candidate.order < current.order) {
      return candidate;
    }

    return current;
  }

  private getDetectionPriority(agentType?: TerminalType, processIconId?: string): number {
    if (agentType) {
      return 0;
    }

    if (processIconId && PACKAGE_MANAGER_ICON_IDS.has(processIconId)) {
      return 1;
    }

    return 2;
  }
}
