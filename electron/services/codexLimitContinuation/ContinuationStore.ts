/**
 * What an armed pane's continuation keeps across a cold restart (#18193): the
 * user's menu choice, the stop it was waiting at and when that stop resets, and
 * the resets it already continued. One versioned file in main's user data,
 * owned by the machine that runs the pane, read once and written whole.
 */

/** A stop saved with its pane, from that pane's own sighting of it. */
export interface SavedLimitStop {
  agentId: string;
  /** The conversation it was in, when the pane's host named one. */
  sessionId?: string;
  /** Epoch ms by which the spent window resets. */
  resetsAt: number;
  /** The banner's digest, which the restored process's redraw is matched on. */
  identity: string;
  /** The transcript entry the limit was, where the agent keeps one Daintree can read. */
  turn?: string;
  savedAt: number;
}

interface SavedPane {
  override?: boolean;
  stop?: SavedLimitStop;
  fired?: number[];
}

export interface ContinuationStoreBackend {
  /** The file's contents, or null when there is none. */
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

const FILE_VERSION = 1;
/** Reset instants remembered per pane, so one already continued never fires twice. */
const MAX_FIRED_PER_PANE = 8;
/** A continued reset older than this can't come round again. */
const FIRED_KEPT_MS = 30 * 24 * 60 * 60_000;

const keyOf = (projectId: string, terminalId: string) => `${projectId}\u0000${terminalId}`;

function readStop(value: unknown): SavedLimitStop | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.agentId !== "string" ||
    typeof v.identity !== "string" ||
    typeof v.resetsAt !== "number" ||
    !Number.isFinite(v.resetsAt) ||
    typeof v.savedAt !== "number" ||
    !Number.isFinite(v.savedAt)
  ) {
    return undefined;
  }
  return {
    agentId: v.agentId,
    resetsAt: v.resetsAt,
    identity: v.identity,
    savedAt: v.savedAt,
    ...(typeof v.sessionId === "string" && { sessionId: v.sessionId }),
    ...(typeof v.turn === "string" && { turn: v.turn }),
  };
}

export class ContinuationStore {
  private readonly records = new Map<string, SavedPane>();
  /** The stops the previous run left, until a restore of their pane takes them. */
  private readonly bootStops = new Map<string, SavedLimitStop>();
  private loading: Promise<void> | null = null;
  private loaded = false;
  /**
   * The file was there and couldn't be read: writing it whole now would lose
   * every other pane's record, so nothing is written this run.
   */
  private readFailed = false;
  private writeChain: Promise<void> = Promise.resolve();
  private writeQueued = false;
  private closed = false;

  constructor(
    private readonly backend: ContinuationStoreBackend | null,
    private readonly now: () => number = Date.now
  ) {}

  /** Read once; every caller waits on the same read. */
  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = this.backend ? await this.backend.read() : null;
    } catch (error) {
      this.readFailed = true;
      console.warn("[LimitContinuation] Couldn't read the saved continuations:", error);
    }
    try {
      if (raw !== null) this.parse(raw);
    } catch (error) {
      console.warn("[LimitContinuation] Couldn't parse the saved continuations:", error);
    }
    this.loaded = true;
  }

  private parse(raw: string): void {
    const parsed = JSON.parse(raw) as { version?: unknown; panes?: unknown };
    if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.panes)) return;
    const firedSince = this.now() - FIRED_KEPT_MS;
    for (const entry of parsed.panes as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.projectId !== "string" || typeof e.terminalId !== "string") continue;
      const pane: SavedPane = {};
      if (typeof e.override === "boolean") pane.override = e.override;
      const stop = readStop(e.stop);
      if (stop) pane.stop = stop;
      if (Array.isArray(e.fired)) {
        // A reset tried for a stop still saved is kept however old it is.
        const fired = e.fired
          .filter(
            (at): at is number =>
              typeof at === "number" && (at >= firedSince || at === pane.stop?.resetsAt)
          )
          .slice(-MAX_FIRED_PER_PANE);
        if (fired.length > 0) pane.fired = fired;
      }
      if (pane.override === undefined && !pane.stop && !pane.fired) continue;
      const key = keyOf(e.projectId, e.terminalId);
      this.records.set(key, pane);
      if (pane.stop) this.bootStops.set(key, pane.stop);
    }
  }

  override(projectId: string, terminalId: string): boolean | undefined {
    return this.records.get(keyOf(projectId, terminalId))?.override;
  }

  fired(projectId: string, terminalId: string): readonly number[] {
    return this.records.get(keyOf(projectId, terminalId))?.fired ?? [];
  }

  /** Whether the previous run left a stop for this pane that no restore has taken yet. */
  hasBootStop(projectId: string, terminalId: string): boolean {
    return this.bootStops.has(keyOf(projectId, terminalId));
  }

  /**
   * The stop the previous run left for this pane, handed out once: a pane
   * restarted later in this run never revives it. Nothing if this run has
   * already replaced or dropped it.
   */
  takeBootStop(projectId: string, terminalId: string): SavedLimitStop | undefined {
    const key = keyOf(projectId, terminalId);
    const stop = this.bootStops.get(key);
    this.bootStops.delete(key);
    return stop !== undefined && this.records.get(key)?.stop === stop ? stop : undefined;
  }

  setOverride(projectId: string, terminalId: string, armed: boolean): void {
    this.mutate(projectId, terminalId, (pane) => {
      pane.override = armed;
    });
  }

  saveStop(projectId: string, terminalId: string, stop: SavedLimitStop): void {
    this.mutate(projectId, terminalId, (pane) => {
      pane.stop = stop;
    });
  }

  clearStop(projectId: string, terminalId: string): void {
    if (!this.records.get(keyOf(projectId, terminalId))?.stop && this.loaded) return;
    this.mutate(projectId, terminalId, (pane) => {
      delete pane.stop;
    });
  }

  addFired(projectId: string, terminalId: string, resetsAt: number): void {
    if (this.fired(projectId, terminalId).includes(resetsAt)) return;
    this.mutate(projectId, terminalId, (pane) => {
      pane.fired = [...(pane.fired ?? []), resetsAt].slice(-MAX_FIRED_PER_PANE);
    });
  }

  removeFired(projectId: string, terminalId: string, resetsAt: number): void {
    this.mutate(projectId, terminalId, (pane) => {
      if (!pane.fired?.includes(resetsAt)) return;
      const fired = (pane.fired ?? []).filter((at) => at !== resetsAt);
      if (fired.length > 0) pane.fired = fired;
      else delete pane.fired;
    });
  }

  /** The pane is closed for good: everything kept for it, in every project, goes. */
  forgetPane(terminalId: string): void {
    this.whenLoaded(() => {
      const suffix = `\u0000${terminalId}`;
      let changed = false;
      for (const key of [...this.records.keys()]) {
        if (!key.endsWith(suffix)) continue;
        this.records.delete(key);
        this.bootStops.delete(key);
        changed = true;
      }
      if (changed) this.schedule();
    });
  }

  /** The project was removed: everything kept for its panes goes, and nothing another project keeps. */
  forgetProject(projectId: string): void {
    this.whenLoaded(() => {
      const prefix = `${projectId}\u0000`;
      let changed = false;
      for (const key of [...this.records.keys()]) {
        if (!key.startsWith(prefix)) continue;
        this.records.delete(key);
        this.bootStops.delete(key);
        changed = true;
      }
      if (changed) this.schedule();
    });
  }

  /** Every write asked for so far has landed, or failed, those waiting on the read included. */
  async flush(): Promise<void> {
    await this.ready();
    await this.writeChain;
  }

  /**
   * Daintree is quitting: every change accepted so far is written, those
   * waiting on the read included, and nothing after it.
   */
  async close(): Promise<void> {
    await this.ready();
    this.closed = true;
    await this.writeChain;
  }

  private mutate(projectId: string, terminalId: string, change: (pane: SavedPane) => void): void {
    this.whenLoaded(() => {
      const key = keyOf(projectId, terminalId);
      const pane = this.records.get(key) ?? {};
      change(pane);
      if (pane.override === undefined && !pane.stop && !pane.fired?.length) {
        this.records.delete(key);
      } else {
        this.records.set(key, pane);
      }
      this.schedule();
    });
  }

  /** A change asked for before the file was read waits for it, so the read can't undo it. */
  private whenLoaded(apply: () => void): void {
    if (this.closed) return;
    if (this.loaded) {
      apply();
      return;
    }
    void this.ready().then(() => {
      if (!this.closed) apply();
    });
  }

  private schedule(): void {
    if (this.closed || this.writeQueued || this.readFailed || !this.backend) return;
    this.writeQueued = true;
    const backend = this.backend;
    this.writeChain = this.writeChain.then(async () => {
      this.writeQueued = false;
      try {
        await backend.write(this.serialize());
      } catch (error) {
        console.warn("[LimitContinuation] Couldn't save the continuations:", error);
      }
    });
  }

  private serialize(): string {
    const panes = [...this.records].map(([key, pane]) => {
      const split = key.indexOf("\u0000");
      return { projectId: key.slice(0, split), terminalId: key.slice(split + 1), ...pane };
    });
    return JSON.stringify({ version: FILE_VERSION, panes });
  }
}
