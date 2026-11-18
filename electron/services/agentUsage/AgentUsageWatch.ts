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
  agentUsageWithSuccessors,
  boundAgentUsageAccountNames,
} from "../../../shared/utils/agentUsage.js";
import type { CodexHomeQuota } from "../codex/CodexQuotaService.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:agentUsage");

/** How often membership and Claude readings are looked at again while wanted. */
export const AGENT_USAGE_TICK_MS = 60_000;

/** The folders the live Codex and Claude Code agents launched on, as their panes recorded them. */
export interface LiveAgentFolders {
  /**
   * False when a pty host didn't answer: an account may be running unseen,
   * so the machine's tightest window can't be told.
   */
  complete: boolean;
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
  /** Elapsed time for the Codex cadence, which a wall-clock correction mustn't stretch or shrink. */
  monotonic(): number;
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
  /** Agent sessions that took over the pane after an earlier one exited. */
  agentIncarnation?: number;
  codexHome?: string;
  claudeConfigDir?: string;
}

/**
 * The agent Daintree launched in a terminal, while it runs there: detected
 * as that agent, or not yet seen by detection. Only a launch's own env is
 * known to be the agent's; one typed into a shell can name another folder on
 * its own command line, so it is never taken for any account. One detected
 * before and gone since has exited. A trashed pane isn't running for anyone.
 */
export function liveAgentOf(terminal: LiveAgentTerminal): "codex" | "claude" | null {
  if (terminal.hasPty === false || terminal.isExited === true || terminal.isTrashed === true) {
    return null;
  }
  const launched = terminal.launchAgentId;
  if (launched !== "codex" && launched !== "claude") return null;
  // One run again in the shell the launched session left can name another folder too.
  if ((terminal.agentIncarnation ?? 0) > 0) return null;
  if (terminal.detectedAgentId !== undefined) {
    return terminal.detectedAgentId === launched ? launched : null;
  }
  return terminal.everDetectedAgent ? null : launched;
}

/** The folders of every live Codex and Claude Code agent in an inventory. */
export function liveAgentFolders(
  terminals: readonly LiveAgentTerminal[],
  complete: boolean
): LiveAgentFolders {
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
  return { complete, codexHomes: [...codexHomes], claudeConfigDirs: [...claudeConfigDirs] };
}

function codexReadings(quota: CodexHomeQuota): AgentUsageReading[] {
  if (quota.result.status !== "ok") return [];
  const { windows, fetchedAt } = quota.result;
  const accountNames = boundAgentUsageAccountNames(
    quota.accountNames.length > 0 ? quota.accountNames : quota.presetNames
  );
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
  const accountNames = boundAgentUsageAccountNames(account.accountNames);
  return account.readings.map((reading) => ({
    agentId: "claude",
    accountNames,
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
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
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

  /** Per agent the tightest reading and what follows its reset; empty while nothing wants them. */
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
    if (this.resetTimer !== null) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.generation++;
    this.running = false;
    this.again = false;
    this.publish([]);
  }

  private async tick(): Promise<void> {
    // A look asked for during a slow one runs once after it, never beside it.
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    const generation = this.generation;
    try {
      await this.refresh(generation);
    } catch (error) {
      logger.warn("Couldn't refresh agent usage", { error });
    } finally {
      if (generation === this.generation) {
        this.running = false;
        if (this.again) {
          this.again = false;
          void this.tick();
        }
      }
    }
  }

  /**
   * Live agents' folders, Codex homes by canonical key; null when nothing can
   * be seen, or when a pty host didn't answer and some may be unseen.
   */
  private async readLive(): Promise<{
    codexHomes: Map<string, string>;
    claudeDirs: string[];
  } | null> {
    const live = await this.deps.listLiveAgents();
    if (!live?.complete) return null;
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
    if (generation !== this.generation) return;
    if (!live) {
      // An account may be running unseen: the machine's tightest window is unknown.
      this.publish([]);
      return;
    }

    const interval = this.deps.codexIntervalMs ?? AGENT_USAGE_CODEX_READ_INTERVAL_MS;
    const askedBefore = this.deps.monotonic() - interval;
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
        live = await this.readLive();
        if (generation !== this.generation) return;
        if (!live) return this.publish([]);
        if (!live.codexHomes.has(home)) continue;
      }
      this.codexAskedAt.set(home, this.deps.monotonic());
      const answers = await this.deps.readCodexHomes(new Map([[home, live.codexHomes.get(home)!]]));
      // Kept even when the watch stopped meanwhile: the read was made and counted.
      for (const answer of answers) {
        const kept = this.codexByHome.get(answer.homeKey);
        // A failed read keeps the last good one, whose age then says how old it is.
        if (answer.result.status !== "ok" && kept?.result.status === "ok") continue;
        this.codexByHome.set(answer.homeKey, answer);
      }
      if (generation !== this.generation) {
        // Wanted again since: the look that skipped this read as asked shows its answer.
        if (this.demand > 0) void this.tick();
        return;
      }
    }
    if (due.length > 0) {
      // Membership as it stands after the reads, not as it stood before them.
      live = await this.readLive();
      if (generation !== this.generation) return;
      if (!live) return this.publish([]);
    }
    const codexHomes = live.codexHomes;

    const claudeKeys = new Set(
      await Promise.all(live.claudeDirs.map((dir) => this.deps.claudeAccountKey(dir)))
    );
    if (generation !== this.generation) return;
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
    const now = this.deps.now();
    const shown = agentUsageWithSuccessors(readings, now);
    this.publish(shown);
    this.wakeAtNextReset(shown, now);
  }

  /** The runner-up shows as a window resets, not up to a tick later. */
  private wakeAtNextReset(shown: readonly AgentUsageReading[], now: number): void {
    if (this.resetTimer !== null) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    const next = Math.min(
      ...shown.flatMap((reading) =>
        reading.resetsAt !== null && reading.resetsAt > now ? [reading.resetsAt] : []
      )
    );
    const tickMs = this.deps.tickMs ?? AGENT_USAGE_TICK_MS;
    // A reset past the next tick is that tick's to see.
    if (!Number.isFinite(next) || next - now >= tickMs) return;
    this.resetTimer = setTimeout(() => void this.tick(), next - now + 1);
    this.resetTimer.unref?.();
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
      const { terminals, degraded } = await getSharedTerminalSnapshot(pty);
      return liveAgentFolders(terminals, !degraded);
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
    monotonic: () => performance.now(),
  };
}
