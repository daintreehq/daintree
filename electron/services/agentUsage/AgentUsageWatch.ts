/**
 * The tightest usage window of each agent's accounts that have an agent
 * running on this machine now (#17318), for the sidebar's readout and for this
 * host's summary to the Shells attached to it.
 *
 * Runs only while something wants it: a visible window, or a Shell attached to
 * this machine as a host. Codex is asked at most once per home every five
 * minutes, and only for homes an agent runs in, through the quota service's
 * own cache and queue; one timer here serves every window. Claude Code is
 * never asked anything: its readings are what its panes printed, joined to the
 * folders of the panes running now.
 */

import type { AgentUsageReading } from "../../../shared/types/ipc/agentUsage.js";
import type { ClaudeUsageAccount } from "../../../shared/types/ipc/agentQuota.js";
import {
  AGENT_USAGE_CODEX_READ_INTERVAL_MS,
  tightestAgentUsage,
} from "../../../shared/utils/agentUsage.js";
import type { CodexHomeQuota } from "../codex/CodexQuotaService.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:agentUsage");

/** How often membership and Claude readings are looked at again while wanted. */
export const AGENT_USAGE_TICK_MS = 60_000;

/**
 * The folders the live Codex and Claude Code agents launched on, as their
 * panes recorded them. From the pty hosts that answered: an agent on one that
 * didn't is unseen until it does, never assumed still running.
 */
export interface LiveAgentFolders {
  codexHomes: string[];
  claudeConfigDirs: string[];
}

export interface AgentUsageWatchDeps {
  listLiveAgents(): Promise<LiveAgentFolders | null>;
  canonicalCodexHome(home: string): Promise<string>;
  /** The key `readClaudeAccounts` groups a folder's readings under. */
  claudeAccountKey(configDir: string): Promise<string>;
  /** Canonical home key to the home as a pane's env named it. */
  readCodexHomes(homes: ReadonlyMap<string, string>): Promise<CodexHomeQuota[]>;
  readClaudeAccounts(): Promise<ClaudeUsageAccount[]>;
  now(): number;
  tickMs?: number;
  codexIntervalMs?: number;
}

type Listener = (readings: AgentUsageReading[]) => void;

/** The terminal shape the inventory reports, as far as the watch reads it. */
export interface LiveAgentTerminal {
  hasPty?: boolean;
  isExited?: boolean;
  isTrashed?: boolean;
  detectedAgentId?: string;
  launchAgentId?: string;
  everDetectedAgent?: boolean;
  codexHome?: string;
  claudeConfigDir?: string;
}

/**
 * The agent running in a terminal now: the detected one, or the launched one
 * until detection first speaks. One detected before and gone since has exited,
 * however the pane was launched. A trashed pane isn't running for anyone.
 */
export function liveAgentOf(terminal: LiveAgentTerminal): "codex" | "claude" | null {
  if (terminal.hasPty === false || terminal.isExited === true || terminal.isTrashed === true) {
    return null;
  }
  const agentId =
    terminal.detectedAgentId ?? (terminal.everDetectedAgent ? undefined : terminal.launchAgentId);
  return agentId === "codex" || agentId === "claude" ? agentId : null;
}

/** The folders of every live Codex and Claude Code agent in an inventory. */
export function liveAgentFolders(terminals: readonly LiveAgentTerminal[]): LiveAgentFolders {
  const codexHomes = new Set<string>();
  const claudeConfigDirs = new Set<string>();
  for (const terminal of terminals) {
    const agent = liveAgentOf(terminal);
    // A folder that couldn't be resolved is never taken for any account's.
    if (agent === "codex" && terminal.codexHome) codexHomes.add(terminal.codexHome);
    if (agent === "claude" && terminal.claudeConfigDir) {
      claudeConfigDirs.add(terminal.claudeConfigDir);
    }
  }
  return { codexHomes: [...codexHomes], claudeConfigDirs: [...claudeConfigDirs] };
}

function codexReadings(quota: CodexHomeQuota): AgentUsageReading[] {
  if (quota.result.status !== "ok") return [];
  const { windows, fetchedAt } = quota.result;
  const accountNames = quota.accountNames.length > 0 ? quota.accountNames : quota.presetNames;
  return windows.map((window) => ({
    agentId: "codex",
    accountNames,
    isDefault: quota.isDefault,
    windowDurationMins: window.windowDurationMins,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    observedAt: fetchedAt,
  }));
}

function claudeReadings(account: ClaudeUsageAccount): AgentUsageReading[] {
  return account.readings.map((reading) => ({
    agentId: "claude",
    accountNames: account.accountNames,
    isDefault: account.kind === "default",
    window: reading.window,
    statement: reading.statement,
    usedPercent: reading.usedPercent,
    resetsAt: reading.resetsAt,
    observedAt: reading.observedAt,
  }));
}

export class AgentUsageWatch {
  private demand = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Bumped on every stop, so a tick that outlived its demand publishes nothing. */
  private generation = 0;
  private latestReadings: AgentUsageReading[] = [];
  private latestKey = "[]";
  private readonly listeners = new Set<Listener>();
  /**
   * Per active home: the last answer, or the last good one when a read fails.
   * Kept across stops beside `codexAskedAt`, so a window shown again within
   * the cadence shows the reading it already had rather than none.
   */
  private readonly codexByHome = new Map<string, CodexHomeQuota>();
  /** Per home, when it was last asked. Kept across stops, so hiding and showing a window can't beat the cadence. */
  private readonly codexAskedAt = new Map<string, number>();

  constructor(private readonly deps: AgentUsageWatchDeps) {}

  /** Want readings until the returned release is called. Idempotent per call. */
  acquire(): () => void {
    this.demand++;
    if (this.demand === 1) this.start();
    let released = false;
    return () => {
      // A release after `dispose` has nothing left to give back.
      if (released || this.demand === 0) return;
      released = true;
      this.demand--;
      if (this.demand === 0) this.stop();
    };
  }

  /** At most one reading per agent; empty while nothing wants them. */
  latest(): AgentUsageReading[] {
    return this.latestReadings;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.demand = 0;
    this.stop();
    this.listeners.clear();
  }

  private start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? AGENT_USAGE_TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.running = false;
    this.publish([]);
  }

  private async tick(): Promise<void> {
    // A slow read skips a beat rather than stacking reads.
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      await this.refresh(generation);
    } catch (error) {
      logger.warn("Couldn't refresh agent usage", { error });
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }

  /** Live agents' folders, Codex homes by canonical key; null when nothing can be seen. */
  private async readLive(): Promise<{
    codexHomes: Map<string, string>;
    claudeDirs: string[];
  } | null> {
    const live = await this.deps.listLiveAgents();
    if (!live) return null;
    const keys = await Promise.all(
      live.codexHomes.map((home) => this.deps.canonicalCodexHome(home))
    );
    const codexHomes = new Map<string, string>();
    keys.forEach((key, index) => {
      if (!codexHomes.has(key)) codexHomes.set(key, live.codexHomes[index]!);
    });
    return { codexHomes, claudeDirs: live.claudeConfigDirs };
  }

  private async refresh(generation: number): Promise<void> {
    let live = await this.readLive();
    if (generation !== this.generation || !live) return;

    const interval = this.deps.codexIntervalMs ?? AGENT_USAGE_CODEX_READ_INTERVAL_MS;
    const askedBefore = this.deps.now() - interval;
    for (const [home, at] of this.codexAskedAt) {
      if (at > askedBefore) continue;
      this.codexAskedAt.delete(home);
      // An agent back in a home within the cadence finds its reading still here.
      if (!live.codexHomes.has(home)) this.codexByHome.delete(home);
    }
    const due = [...live.codexHomes.keys()].filter((home) => !this.codexAskedAt.has(home));
    for (const [index, home] of due.entries()) {
      if (index > 0) {
        // Each read waits its turn behind the last: a home whose agent left
        // meanwhile isn't asked about, and stays due for when one returns.
        const now = await this.readLive();
        if (generation !== this.generation) return;
        if (now) live = now;
        if (!live.codexHomes.has(home)) continue;
      }
      this.codexAskedAt.set(home, this.deps.now());
      const answers = await this.deps.readCodexHomes(new Map([[home, live.codexHomes.get(home)!]]));
      // Kept even when the watch stopped meanwhile: the read was made and counted.
      for (const answer of answers) {
        const kept = this.codexByHome.get(answer.homeKey);
        // A failed read keeps the last good one, whose age then says how old it is.
        if (answer.result.status !== "ok" && kept?.result.status === "ok") continue;
        this.codexByHome.set(answer.homeKey, answer);
      }
      if (generation !== this.generation) return;
    }
    const codexHomes = live.codexHomes;

    const claudeKeys = new Set(
      await Promise.all(live.claudeDirs.map((dir) => this.deps.claudeAccountKey(dir)))
    );
    const claudeAccounts = claudeKeys.size > 0 ? await this.deps.readClaudeAccounts() : [];
    if (generation !== this.generation) return;

    const readings = [
      ...[...this.codexByHome.entries()]
        .filter(([home]) => codexHomes.has(home))
        .flatMap(([, quota]) => codexReadings(quota)),
      ...claudeAccounts
        .filter((account) => account.kind !== "unknown" && claudeKeys.has(account.key))
        .flatMap(claudeReadings),
    ];
    this.publish(tightestAgentUsage(readings, (reading) => reading, this.deps.now()));
  }

  private publish(readings: AgentUsageReading[]): void {
    const key = JSON.stringify(readings);
    if (key === this.latestKey) return;
    this.latestKey = key;
    this.latestReadings = readings;
    for (const listener of [...this.listeners]) {
      try {
        listener(readings);
      } catch (error) {
        logger.warn("An agent usage listener threw", { error });
      }
    }
  }
}

let shared: AgentUsageWatch | null = null;

/** This machine's one watch, built on first use. */
export function getAgentUsageWatch(): AgentUsageWatch {
  shared ??= new AgentUsageWatch(defaultDeps());
  return shared;
}

/** The watch if anything has built it: a summary sample never builds one. */
export function peekAgentUsageWatch(): AgentUsageWatch | null {
  return shared;
}

export function disposeAgentUsageWatch(): void {
  shared?.dispose();
  shared = null;
}

function defaultDeps(): AgentUsageWatchDeps {
  return {
    async listLiveAgents() {
      const [{ getPtyClient }, { getSharedTerminalSnapshot }] = await Promise.all([
        import("../../window/serviceRefs.js"),
        import("../sharedTerminalSnapshot.js"),
      ]);
      const pty = getPtyClient();
      if (!pty) return null;
      // A shard that didn't answer leaves its agents unseen, never assumed running.
      const { terminals } = await getSharedTerminalSnapshot(pty);
      return liveAgentFolders(terminals);
    },
    async canonicalCodexHome(home) {
      const { canonicalCodexHomeKey } = await import("../codex/CodexQuotaProfiles.js");
      return canonicalCodexHomeKey(home);
    },
    async claudeAccountKey(configDir) {
      const [{ canonicalClaudeConfigDir }, { claudeUsageAccountKey }] = await Promise.all([
        import("../claude/ClaudeUsageObservations.js"),
        import("../claude/ClaudeUsageService.js"),
      ]);
      return claudeUsageAccountKey(await canonicalClaudeConfigDir(configDir));
    },
    async readCodexHomes(homes) {
      const { readCodexQuotaForHomes } = await import("../codex/CodexQuotaService.js");
      return readCodexQuotaForHomes(homes);
    },
    async readClaudeAccounts() {
      const { readClaudeUsageAccountsWithoutPanes } =
        await import("../claude/ClaudeUsageService.js");
      return readClaudeUsageAccountsWithoutPanes();
    },
    now: Date.now,
  };
}
