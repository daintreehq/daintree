/** A terminal process exit the pty-host reported, as main received it. */
export interface RecentTerminalExit {
  terminalId: string;
  /** The incarnation that exited. */
  launchGeneration: number;
  exitCode: number;
  signal: number | undefined;
  observedAt: number;
}

/** Long past the trash grace, so an exit seen there outlives the record the trash lets go. */
export const RECENT_TERMINAL_EXIT_TTL_MS = 10 * 60 * 1000;
export const RECENT_TERMINAL_EXIT_LIMIT = 1024;

/**
 * Exits main has received from the pty-host, kept for a bounded time after the
 * host forgets the terminal (#15728). A trashed panel's record goes when the
 * trash lets it go, or as soon as its process exits for a plain shell, so a
 * later read there answers "not found" — the same as an id that never existed.
 * Only the host's own `exit` event writes here: a missing record, a host that
 * died, or a deadline passing is never an exit. Keyed by incarnation, and only
 * ever matched by one: an id is reused across restarts, so an exit with no
 * generation proves nothing about any of them and is not kept.
 */
export class RecentTerminalExits {
  /** `${terminalId}\0${generation}` → exit, oldest first. */
  private readonly exits = new Map<string, RecentTerminalExit>();
  private readonly listeners = new Set<(exit: RecentTerminalExit) => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = RECENT_TERMINAL_EXIT_TTL_MS,
    private readonly limit: number = RECENT_TERMINAL_EXIT_LIMIT
  ) {}

  record(exit: {
    terminalId: string;
    launchGeneration: number | undefined;
    exitCode: number;
    signal: number | undefined;
  }): void {
    if (exit.launchGeneration === undefined) return;
    const entry: RecentTerminalExit = {
      terminalId: exit.terminalId,
      launchGeneration: exit.launchGeneration,
      exitCode: exit.exitCode,
      signal: exit.signal,
      observedAt: this.now(),
    };
    const key = `${entry.terminalId}\u0000${entry.launchGeneration}`;
    this.exits.delete(key);
    this.exits.set(key, entry);
    this.prune();
    for (const listener of [...this.listeners]) {
      try {
        listener(entry);
      } catch (err) {
        console.warn("[RecentTerminalExits] listener threw:", err);
      }
    }
  }

  /** The exit of this incarnation; nothing for a caller that can't name one. */
  find(terminalId: string, launchGeneration: number | undefined): RecentTerminalExit | undefined {
    if (launchGeneration === undefined) return undefined;
    this.prune();
    return this.exits.get(`${terminalId}\u0000${launchGeneration}`);
  }

  /**
   * The incarnation under this id whose exit main saw last: the one a panel
   * still shows after its process ended, unlike a launch the host refused.
   */
  latestGeneration(terminalId: string): number | undefined {
    this.prune();
    let latest: number | undefined;
    for (const exit of this.exits.values()) {
      if (exit.terminalId === terminalId) latest = exit.launchGeneration;
    }
    return latest;
  }

  /** Every id with an exit kept: panels that may still show after their process ended. */
  terminalIds(): string[] {
    this.prune();
    return [...new Set([...this.exits.values()].map((exit) => exit.terminalId))];
  }

  onExit(listener: (exit: RecentTerminalExit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.exits.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, exit] of this.exits) {
      if (exit.observedAt > cutoff && this.exits.size <= this.limit) break;
      this.exits.delete(key);
    }
  }
}

/** Whether an exit is the one a caller holding this incarnation is asking about. */
export function exitMatches(
  exit: RecentTerminalExit,
  terminalId: string,
  launchGeneration: number | undefined
): boolean {
  return (
    launchGeneration !== undefined &&
    exit.terminalId === terminalId &&
    exit.launchGeneration === launchGeneration
  );
}
