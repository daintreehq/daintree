/** A terminal process exit the pty-host reported, as main received it. */
export interface RecentTerminalExit {
  terminalId: string;
  /** The incarnation that exited; undefined when neither the host nor main knew it. */
  launchGeneration: number | undefined;
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
 * died, or a deadline passing is never an exit.
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

  record(exit: Omit<RecentTerminalExit, "observedAt">): void {
    const entry: RecentTerminalExit = { ...exit, observedAt: this.now() };
    const key = `${exit.terminalId}\u0000${exit.launchGeneration ?? ""}`;
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

  /**
   * The exit of this incarnation. With no generation to match, the latest exit
   * seen under the id.
   */
  find(terminalId: string, launchGeneration?: number): RecentTerminalExit | undefined {
    this.prune();
    if (launchGeneration !== undefined) {
      return (
        this.exits.get(`${terminalId}\u0000${launchGeneration}`) ??
        this.exits.get(`${terminalId}\u0000`)
      );
    }
    let latest: RecentTerminalExit | undefined;
    for (const exit of this.exits.values()) {
      if (exit.terminalId === terminalId) latest = exit;
    }
    return latest;
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

/** Whether an exit is the one a caller is asking about, given the generation it holds. */
export function exitMatches(
  exit: RecentTerminalExit,
  terminalId: string,
  launchGeneration: number | undefined
): boolean {
  if (exit.terminalId !== terminalId) return false;
  return (
    launchGeneration === undefined ||
    exit.launchGeneration === undefined ||
    exit.launchGeneration === launchGeneration
  );
}
