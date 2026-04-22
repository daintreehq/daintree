import type { TerminalType } from "../../shared/types/panel.js";
import type { ProcessTreeCache } from "./ProcessTreeCache.js";
import { logDebug, logWarn } from "../utils/logger.js";
import { AGENT_REGISTRY } from "../../shared/config/agentRegistry.js";

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

const AGENT_CLI_NAMES: Record<string, TerminalType> = Object.fromEntries(
  Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
    const entries: [string, TerminalType][] = [[config.command, id as TerminalType]];
    if (config.command !== id) {
      entries.push([id, id as TerminalType]);
    }
    return entries;
  })
);

const PROCESS_ICON_MAP: Record<string, string> = {
  // AI agents (derived from registry)
  ...Object.fromEntries(
    Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
      const entries: [string, string][] = [[id, config.iconId]];
      if (config.command !== id) {
        entries.push([config.command, config.iconId]);
      }
      return entries;
    })
  ),
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

/**
 * Extract non-flag command name candidates from a full `command` line in
 * argv order. Used when `comm` basename doesn't match a known CLI — most
 * commonly for Node-hosted CLIs where `comm = "node"` and argv[1] is the
 * agent script path (`node /path/to/claude --resume`).
 *
 * Extensions like .js / .py / .rb are stripped so "claude.mjs" → "claude".
 * Returns argv[0], argv[1], argv[2] basenames.
 *
 * NOTE: if a process sets `process.title` after launch, macOS `ps` reports
 * the rewritten argv — the original invocation is NOT preserved in the
 * `command` column. Callers should not rely on this to recover identity
 * after a process has rewritten its title.
 */
export function extractCommandNameCandidates(command: string | undefined): string[] {
  if (!command) return [];
  const parts = command.trim().split(/\s+/);
  const candidates: string[] = [];
  for (let i = 0; i < parts.length && candidates.length < 3; i++) {
    const arg = parts[i];
    if (!arg || arg.startsWith("-")) continue;
    const basename = arg.split(/[\\/]/).pop();
    if (!basename) continue;
    const withoutExt = basename.replace(/\.(m?js|cjs|ts|py|rb|php|pl)$/i, "");
    if (withoutExt) candidates.push(withoutExt);
  }
  return candidates;
}

/** @deprecated Use extractCommandNameCandidates — retained for test import. */
export function extractScriptBasenameFromCommand(command: string | undefined): string | null {
  const all = extractCommandNameCandidates(command);
  // Previous behaviour: skip argv[0], return argv[1]. Preserved so older
  // tests that assume "only the script, not the runtime" still pass.
  return all[1] ?? null;
}

export interface CommandIdentity {
  agentType?: TerminalType;
  processIconId?: string;
  processName: string;
}

/**
 * Best-effort identity resolution from a shell command line.
 *
 * Used by the runtime shell-command fallback in TerminalProcess when the PTY
 * process tree is blind or a CLI rewrites its own process title. This shares
 * the same agent/process icon registry as the process-tree detector so chrome
 * stays consistent regardless of which signal produced the identity.
 */
export function detectCommandIdentity(command: string | undefined): CommandIdentity | null {
  const candidates = extractCommandNameCandidates(command);
  let iconMatch: { name: string; icon: string } | null = null;

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
    if (candidateAgent) {
      return {
        agentType: candidateAgent,
        processIconId: PROCESS_ICON_MAP[lowerCandidate],
        processName: candidate,
      };
    }

    if (!iconMatch) {
      const candidateIcon = PROCESS_ICON_MAP[lowerCandidate];
      if (candidateIcon) {
        iconMatch = { name: candidate, icon: candidateIcon };
      }
    }
  }

  if (!iconMatch) {
    return null;
  }

  return {
    processIconId: iconMatch.icon,
    processName: iconMatch.name,
  };
}

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
  // Require N consecutive polls agreeing on a new agent/icon state before
  // committing it. At the 1500 ms base poll interval that is ~3 s of confirmation,
  // which is enough to filter out short-lived processes (e.g. `claude --version`)
  // that would otherwise cause the detector to thrash between on/off.
  private static readonly HYSTERESIS_THRESHOLD = 2;

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
  private onStreak: number = 0;
  private offStreak: number = 0;
  private pendingDetected: { agentType?: TerminalType; processIconId?: string } | null = null;
  private lastUnknownSignature: string | null = null;

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

    let firstRefresh = true;
    this.unsubscribe = this.cache.onRefresh(() => {
      if (firstRefresh) {
        firstRefresh = false;
        // One-shot verbose-gated log on first cache refresh callback —
        // confirms the detector is actually being ticked by the cache,
        // independent of whether any state transitions are committed by the
        // hysteresis gate. Gated so normal runs stay quiet. #5813
        logDebug(
          `ProcessDetector ${this.terminalId.slice(0, 8)} first refresh pid=${this.ptyPid} children=${this.cache.getChildren(this.ptyPid).length}`
        );
      }
      this.detect();
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      // Flush a pending OFF streak on teardown so a detected agent whose process
      // exited inside the hysteresis window does not leave ghost state in the UI.
      if (this.offStreak > 0 && (this.lastDetected !== null || this.lastProcessIconId !== null)) {
        const spawnedAt = this.spawnedAt;
        this.lastDetected = null;
        this.lastProcessIconId = null;
        this.lastBusyState = false;
        this.lastCurrentCommand = undefined;
        this.offStreak = 0;
        this.onStreak = 0;
        this.pendingDetected = null;
        try {
          this.callback({ detected: false, isBusy: false, currentCommand: undefined }, spawnedAt);
        } catch (err) {
          console.error(`ProcessDetector stop flush error for terminal ${this.terminalId}:`, err);
        }
      } else {
        this.onStreak = 0;
        this.offStreak = 0;
        this.pendingDetected = null;
      }

      this.unsubscribe();
      this.unsubscribe = null;
      logDebug(`Stopped ProcessDetector for terminal ${this.terminalId}`);
    }
    this.isStarted = false;
  }

  private detect(): void {
    try {
      const result = this.detectAgent();

      const rawAgent = result.agentType ?? null;
      const rawIcon = result.processIconId ?? null;
      const rawDetected = result.detected;
      const committedAgent = this.lastDetected;
      const committedIcon = this.lastProcessIconId;

      const agentOrIconDiffers = rawAgent !== committedAgent || rawIcon !== committedIcon;

      let gatedCommitted = false;

      if (agentOrIconDiffers) {
        if (rawDetected) {
          // ON or swap direction: count consecutive polls agreeing on the same
          // candidate; a different candidate mid-streak resets the counter.
          const sameCandidate =
            this.pendingDetected !== null &&
            (this.pendingDetected.agentType ?? null) === rawAgent &&
            (this.pendingDetected.processIconId ?? null) === rawIcon;

          this.onStreak = sameCandidate ? this.onStreak + 1 : 1;
          this.pendingDetected = {
            agentType: result.agentType,
            processIconId: result.processIconId,
          };
          this.offStreak = 0;

          if (this.onStreak >= ProcessDetector.HYSTERESIS_THRESHOLD) {
            this.lastDetected = rawAgent;
            this.lastProcessIconId = rawIcon;
            this.onStreak = 0;
            this.pendingDetected = null;
            gatedCommitted = true;
          }
        } else {
          // OFF direction: raw reports no detection but committed state has one.
          this.offStreak += 1;
          this.onStreak = 0;
          this.pendingDetected = null;

          if (this.offStreak >= ProcessDetector.HYSTERESIS_THRESHOLD) {
            this.lastDetected = null;
            this.lastProcessIconId = null;
            this.offStreak = 0;
            gatedCommitted = true;
          }
        }
      } else {
        // Raw matches committed state — no transition in flight.
        this.onStreak = 0;
        this.offStreak = 0;
        this.pendingDetected = null;
      }

      const inPendingTransition = this.onStreak > 0 || this.offStreak > 0;

      const busyChanged = result.isBusy !== undefined && result.isBusy !== this.lastBusyState;
      const commandChanged = result.currentCommand !== this.lastCurrentCommand;

      // Suppress busy/command emissions while a gated transition is pending —
      // otherwise a one-poll blip would leak through the side-channel and undo
      // the hysteresis gate. Once the gated streak commits (or the raw state
      // stabilises back onto committed), immediate emissions resume.
      const shouldEmitImmediate = (busyChanged || commandChanged) && !inPendingTransition;

      if (gatedCommitted || shouldEmitImmediate) {
        if (result.isBusy !== undefined) {
          this.lastBusyState = result.isBusy;
        }
        this.lastCurrentCommand = result.currentCommand;
        // Always-on, one line per committed state change. Lets us see in
        // logs whether detection is firing at all, without spam: this block
        // only runs when we actually emit (gatedCommitted or a busy/command
        // side-channel change).
        if (gatedCommitted) {
          console.log(
            `[ProcessDetector ${this.terminalId.slice(0, 8)}] commit pid=${this.ptyPid} detected=${result.detected} agent=${result.agentType ?? "null"} icon=${result.processIconId ?? "null"}`
          );
        }
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

    // Grandchild fallback. Only run when direct children didn't produce an
    // identified agent — avoids showing a "node" badge for claude's Node
    // worker processes when the claude parent renamed its comm. Covers real
    // nesting: `zsh → npm → node /path/to/claude` for `npm run claude`.
    if (!bestMatch || bestMatch.priority > 0) {
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

    // Diagnostic: when we saw running processes but couldn't identify any of
    // them, log what the OS actually reported. Fires at most once per
    // unique (comm, command) tuple set so a persistent mystery process
    // doesn't spam — but any NEW mystery process gets surfaced.
    if (!bestMatch) {
      const signature = processes.map((p) => `${p.name}|${p.command ?? ""}`).join("/");
      if (signature !== this.lastUnknownSignature) {
        this.lastUnknownSignature = signature;
        console.warn(
          `[ProcessDetector ${this.terminalId.slice(0, 8)}] unmatched children of pid ${this.ptyPid}:`,
          processes
            .map(
              (p) =>
                `pid=${p.pid} comm=${JSON.stringify(p.name)} cmd=${JSON.stringify(p.command ?? "")}`
            )
            .join(" | ")
        );
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

    // Primary: match the process basename (comm). Works for native binaries,
    // package managers, and well-behaved CLIs that haven't rewritten their
    // process title.
    let agentType = AGENT_CLI_NAMES[lowerName];
    let processIconId = PROCESS_ICON_MAP[lowerName];
    let effectiveName = normalizedName;

    // Fallback: walk argv from `command`. Covers the Node/Python-hosted CLI
    // case — `comm` is the runtime ("node"), argv[1] is the script basename
    // ("claude" from `node /path/to/claude --resume`). This only helps when
    // the process has NOT rewritten its own title; if `process.title = ...`
    // was called, macOS `ps` reflects the rewritten argv and the original
    // script name is lost. That case needs a different mechanism (shell
    // integration / output pattern matching / native foreground probe).
    //
    // We scan ALL candidates and prefer an AGENT match over a process-icon
    // match, because argv[0] of a Node-hosted CLI is "node" (a runtime that
    // would match PROCESS_ICON_MAP but not AGENT_CLI_NAMES) and the agent
    // identity is in argv[1]. Stopping at the first icon hit would
    // misclassify `node /path/to/claude` as a generic Node process.
    if (!agentType && processCommand) {
      const candidates = extractCommandNameCandidates(processCommand);
      let iconMatch: { name: string; icon: string } | null = null;
      for (const candidate of candidates) {
        const lowerCandidate = candidate.toLowerCase();
        const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
        if (candidateAgent) {
          // Agent match wins — commit immediately and stop scanning.
          agentType = candidateAgent;
          processIconId = PROCESS_ICON_MAP[lowerCandidate] ?? processIconId;
          effectiveName = candidate;
          break;
        }
        if (!iconMatch) {
          const candidateIcon = PROCESS_ICON_MAP[lowerCandidate];
          if (candidateIcon) iconMatch = { name: candidate, icon: candidateIcon };
        }
      }
      // No agent found; fall back to the first icon match if we have one
      // AND the primary `comm` didn't already produce one. Example: bare
      // `python3 script.py` — primary matches python3→python, fallback
      // finds no agent in argv, we keep the python icon from primary.
      if (!agentType && !processIconId && iconMatch) {
        processIconId = iconMatch.icon;
        effectiveName = iconMatch.name;
      }
    }

    if (!agentType && !processIconId) {
      return null;
    }

    return {
      agentType,
      processIconId,
      processName: effectiveName,
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
