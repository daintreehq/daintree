import type { FleetRunRow } from "../../../shared/types/ipc/fleet.js";
import {
  TRIAGE_ATTENTION_THRESHOLD,
  type TriageCard,
  type TriageCategory,
  type TriageSnapshot,
} from "../../../shared/types/ipc/triage.js";
import {
  isSecretPrompt,
  prepareScreen,
  redactSecrets,
  type PreparedScreen,
} from "./triageScreen.js";
import {
  TriageProviderError,
  combinePriority,
  type ClassifierResult,
  type DescriberResult,
  type TriageProviderConfig,
  type TriageScreenInput,
} from "./triageProviders.js";

/** Screen rows read per run — the tail the cards are written from. */
export const TRIAGE_SCREEN_LINES = 50;
/** An unchanged screen read longer ago than this is judged again on the next scan. */
export const TRIAGE_REJUDGE_AFTER_MS = 120_000;
/** A close this soon after an open is a bounce, not the panel going away. */
export const TRIAGE_CLOSE_GRACE_MS = 300;
const CLASSIFIER_CONCURRENCY = 16;
const DESCRIBER_CONCURRENCY = 12;
const SCREEN_READ_CONCURRENCY = 8;
const BROADCAST_DEBOUNCE_MS = 40;

export interface TriageServiceDeps {
  config: TriageProviderConfig;
  /** The fleet's current runs, or null while the fleet is unknown. */
  getRuns: () => readonly FleetRunRow[] | null;
  /** The run's current screen as plain text, or null when it can't be read. */
  readScreen: (runId: string, lines: number) => Promise<string | null>;
  classify: (input: TriageScreenInput, signal: AbortSignal) => Promise<ClassifierResult>;
  describe: (
    input: TriageScreenInput,
    classifierSays: TriageCategory,
    signal: AbortSignal
  ) => Promise<DescriberResult>;
  broadcast: (snapshot: TriageSnapshot) => void;
  now?: () => number;
  /** How long a close waits for a reopen before it abandons the scan; 0 closes at once. */
  closeGraceMs?: number;
}

interface RunEntry {
  /** Hash of the screen the current card (or in-flight pass) was built from. */
  hash: string | null;
  /** Bumped per new screen, so a pass for an older screen can't land. */
  seq: number;
  card: TriageCard | null;
  /** A pass for this run is in flight. */
  pending: boolean;
  /** When the classifier last read this screen (epoch ms), 0 before it has. */
  readAt: number;
}

/**
 * Keeps one card per agent run, rebuilt only when that run's screen changes.
 *
 * Every changed screen goes to the classifier; only runs that need the user (or
 * that the classifier is unsure about) go on to the describer, which is the
 * expensive call. Watching happens only while a panel says it is open, so a
 * closed panel costs no requests.
 */
export class TriageService {
  private readonly entries = new Map<string, RunEntry>();
  private readonly now: () => number;
  private readonly closeGraceMs: number;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private scanning: Promise<void> | null = null;
  private rescanRequested = false;
  private inFlight = 0;
  private refreshedAt: number | null = null;
  private lastError: string | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private abort = new AbortController();
  /**
   * Bumped whenever in-flight work stops being wanted — the last panel closed,
   * or the keys changed — so a pass started before it can't land or go on to
   * the describer.
   */
  private epoch = 0;
  private readonly classifierSlots = new Semaphore(CLASSIFIER_CONCURRENCY);
  private readonly describerSlots = new Semaphore(DESCRIBER_CONCURRENCY);
  private disposed = false;

  private config: TriageProviderConfig;

  constructor(private readonly deps: TriageServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.closeGraceMs = deps.closeGraceMs ?? TRIAGE_CLOSE_GRACE_MS;
    this.config = deps.config;
  }

  /**
   * Keys were saved or removed. Every card is rebuilt against the new providers
   * — a card written while a key was missing or wrong is not worth keeping.
   */
  setConfig(config: TriageProviderConfig): void {
    if (this.disposed) return;
    this.config = config;
    this.lastError = null;
    this.invalidateInFlight();
    for (const entry of this.entries.values()) entry.hash = null;
    this.scheduleBroadcast();
    if (this.active) void this.scan();
  }

  /** Abandon every pass in flight: abort its requests and let none of it land. */
  private invalidateInFlight(): void {
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    for (const entry of this.entries.values()) {
      if (!entry.pending) continue;
      // Its screen was never finished, so the next scan must look again.
      entry.pending = false;
      entry.hash = null;
      if (entry.card?.describing) entry.card = { ...entry.card, describing: false };
    }
  }

  get isConfigured(): boolean {
    return this.config.missingKeys.length === 0;
  }

  getSnapshot(): TriageSnapshot {
    const cards: TriageCard[] = [];
    for (const entry of this.entries.values()) if (entry.card) cards.push(entry.card);
    return {
      configured: this.isConfigured,
      missingKeys: [...this.config.missingKeys],
      active: this.active,
      busy: this.scanning !== null || this.inFlight > 0,
      refreshedAt: this.refreshedAt,
      describerModel: this.config.describerModel,
      cards,
      lastError: this.lastError,
    };
  }

  /**
   * A panel opened or closed. Opening scans once; after that the panel scans
   * only when the user presses Refresh. There is deliberately no polling: every
   * changed screen costs a provider call, and a panel left open would otherwise
   * keep paying for screens nobody is reading.
   */
  /**
   * `immediate` is for a view that went away (crashed, reloaded, destroyed)
   * rather than a panel the user closed: nothing will reopen it, so there is
   * no bounce to wait out.
   */
  setActive(active: boolean, immediate = false): void {
    if (this.disposed) return;
    if (active) {
      if (this.closeTimer !== null) {
        // Reopened before the close took effect: the scan under way carries on.
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
        return;
      }
      if (this.active) return;
      this.active = true;
      void this.scan();
      this.scheduleBroadcast();
      return;
    }
    if (!this.active) return;
    if (immediate) {
      if (this.closeTimer !== null) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      this.deactivate();
      return;
    }
    if (this.closeTimer !== null) return;
    // A close straight followed by an open — React replaying the panel's
    // effect in development, or the user reopening it — must not abort the
    // scan the open started and then start a second one.
    if (this.closeGraceMs <= 0) {
      this.deactivate();
      return;
    }
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.deactivate();
    }, this.closeGraceMs);
  }

  private deactivate(): void {
    this.active = false;
    // Closing means nothing more is sent, including work already queued.
    this.invalidateInFlight();
    this.scheduleBroadcast();
  }

  /**
   * The user asked for a fresh look. Every screen is re-read, but only the ones
   * that changed since their card was written go to the providers — an
   * unchanged screen would get the same card back for the price of a call.
   */
  refresh(): Promise<void> {
    return this.scan();
  }

  /**
   * The fleet changed shape. Cards for runs that left are dropped at once; the
   * rest wait for the next scan the user asks for.
   */
  onFleetChanged(): void {
    if (this.pruneDeparted()) this.scheduleBroadcast();
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.abort.abort();
    if (this.broadcastTimer !== null) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  /** One pass over every run. Overlapping requests coalesce into one follow-up. */
  scan(): Promise<void> {
    // No open panel, no requests: a refresh or an action's follow-up scan that
    // arrives after the last panel closed sends nothing.
    if (this.disposed || !this.active || !this.isConfigured) return Promise.resolve();
    if (this.scanning) {
      this.rescanRequested = true;
      return this.scanning;
    }
    this.scanning = this.scanOnce().finally(() => {
      this.scanning = null;
      this.scheduleBroadcast();
      if (this.rescanRequested && this.active && !this.disposed) {
        this.rescanRequested = false;
        void this.scan();
      }
    });
    this.scheduleBroadcast();
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const runs = this.deps.getRuns();
    if (runs === null) return;
    this.pruneDeparted(runs);
    const epoch = this.epoch;
    const reads = new Semaphore(SCREEN_READ_CONCURRENCY);
    const passes: Promise<void>[] = [];
    await Promise.all(
      runs.map((run) =>
        reads.run(async () => {
          const raw = await this.deps.readScreen(run.runId, TRIAGE_SCREEN_LINES).catch(() => null);
          if (raw === null || this.disposed || epoch !== this.epoch) return;
          // The run may have left — or been respawned under the same id — while
          // its screen was being read. Only the incarnation still in the fleet
          // gets an entry.
          if (!this.isLive(run)) return;
          const screen = prepareScreen(raw, this.providerKeys());
          const entry = this.entries.get(run.runId) ?? {
            hash: null,
            seq: 0,
            card: null,
            pending: false,
            readAt: 0,
          };
          this.entries.set(run.runId, entry);
          // The observed state and the terminal's incarnation are part of what
          // the card was built from, so either changing rebuilds it even when
          // the screen text did not move.
          const key = `${screen.hash}:${run.spawnedAt}:${run.agentState ?? ""}:${run.waitingReason ?? ""}`;
          if (entry.hash === key) {
            this.refreshActivity(entry, screen);
            // Unchanged, but time is part of the reading: an agent on the same
            // step for minutes may be stuck rather than busy, so a screen read
            // long enough ago is judged again, as the same prompt.
            if (
              !entry.pending &&
              entry.card !== null &&
              this.now() - entry.readAt >= TRIAGE_REJUDGE_AFTER_MS
            ) {
              passes.push(this.rebuild(run, entry, entry.seq, epoch, screen, true));
            }
            return;
          }
          entry.hash = key;
          entry.seq++;
          passes.push(this.rebuild(run, entry, entry.seq, epoch, screen));
        })
      )
    );
    await Promise.all(passes);
    if (epoch === this.epoch) this.refreshedAt = this.now();
  }

  private providerKeys(): string[] {
    return [this.config.classifierKey, this.config.describerKey].filter(
      (key): key is string => key !== null && key !== ""
    );
  }

  private isLive(run: FleetRunRow): boolean {
    const runs = this.deps.getRuns();
    return (
      runs !== null &&
      runs.some((current) => current.runId === run.runId && current.spawnedAt === run.spawnedAt)
    );
  }

  /** Whether a pass started for `seq` in `epoch` may still act on `entry`. */
  private stillWanted(run: FleetRunRow, entry: RunEntry, seq: number, epoch: number): boolean {
    return (
      !this.disposed &&
      this.active &&
      epoch === this.epoch &&
      entry.seq === seq &&
      this.entries.get(run.runId) === entry &&
      this.isLive(run)
    );
  }

  private async rebuild(
    run: FleetRunRow,
    entry: RunEntry,
    seq: number,
    epoch: number,
    screen: PreparedScreen,
    rejudge = false
  ): Promise<void> {
    const input: TriageScreenInput = {
      agent: run.agentId ?? run.launchAgentId ?? "terminal",
      // Titles are agent-set (OSC) text, so they leave the machine redacted too.
      title: redactSecrets(run.lastObservedTitle ?? run.title ?? "", this.providerKeys()),
      screen: screen.text,
      lines: screen.lines,
      observed: {
        agentState: run.agentState ?? null,
        waitingReason: run.waitingReason ?? null,
        secondsInState:
          run.since !== undefined ? Math.max(0, Math.round((this.now() - run.since) / 1000)) : null,
      },
    };
    // A re-judged screen is the one the user may already have opened; it keeps
    // the time it was first read, so it neither reads as new nor as unread.
    const observedAt = rejudge && entry.card ? entry.card.observedAt : this.now();
    const signal = this.abort.signal;

    entry.pending = true;
    this.inFlight++;
    let classified: ClassifierResult;
    try {
      classified = await this.classifierSlots.run(() => {
        // Checked again once a slot frees up: the queue can outlast the panel.
        if (!this.stillWanted(run, entry, seq, epoch)) throw new StaleTriagePass();
        return this.deps.classify(input, signal);
      });
    } catch (error) {
      this.recordFailure(run, entry, seq, epoch, error);
      return;
    } finally {
      this.inFlight--;
    }
    if (!this.stillWanted(run, entry, seq, epoch)) return;
    entry.readAt = this.now();

    // The classifier's probability is the gate: only a run likely to need the
    // user is worth a describer call.
    const describe = needsAttention(classified.attention);
    const previous = entry.card;
    // A card whose screen moved keeps its old words until new ones arrive,
    // unless the state itself changed — then stale words would describe the
    // wrong thing.
    // …and only while new words are on their way: a run the describer is
    // skipped for must not wear words written about an earlier screen.
    const keepWords = describe && previous !== null && previous.category === classified.category;
    entry.card = {
      runId: run.runId,
      spawnedAt: run.spawnedAt,
      revision: seq,
      category: classified.category,
      confidence: classified.confidence,
      attentionProbability: classified.attention,
      // An old score stands in only while new words for the same state are due.
      attentionScore: keepWords ? previous.attentionScore : null,
      priority: combinePriority(classified.attention, keepWords ? previous.attentionScore : null),
      stage: keepWords ? previous.stage : "classified",
      describing: describe,
      headline: keepWords ? previous.headline : null,
      summary: keepWords ? previous.summary : null,
      question: classified.question,
      // Only the old options this screen still draws: a menu that moved on
      // must not keep offering the last one's answers.
      options: keepWords ? optionsInScreenOrder(previous.options, screen.text) : [],
      secretPrompt: isSecretPrompt(classified.question),
      activity: screen.activity,
      observedAt,
    };
    this.lastError = null;
    this.scheduleBroadcast();
    if (!describe || !this.isConfigured) {
      entry.pending = false;
      if (describe) entry.card = { ...entry.card, describing: false };
      return;
    }

    this.inFlight++;
    let described: DescriberResult;
    try {
      described = await this.describerSlots.run(() => {
        if (!this.stillWanted(run, entry, seq, epoch) || !this.isConfigured) {
          throw new StaleTriagePass();
        }
        return this.deps.describe(input, classified.category, signal);
      });
    } catch (error) {
      this.recordFailure(run, entry, seq, epoch, error);
      return;
    } finally {
      this.inFlight--;
    }
    if (!this.stillWanted(run, entry, seq, epoch)) return;
    entry.pending = false;

    const question = onScreen(described.question, screen.text) ?? entry.card.question;
    const asks = described.category === "approval" || described.category === "question";
    entry.card = {
      ...entry.card,
      category: described.category,
      attentionScore: described.attentionScore,
      priority: combinePriority(entry.card.attentionProbability, described.attentionScore),
      stage: "described",
      describing: false,
      headline: described.headline || null,
      summary: described.summary || null,
      question: asks ? question : null,
      options:
        described.category === "approval"
          ? optionsInScreenOrder(described.options, screen.text)
          : [],
      secretPrompt: asks && isSecretPrompt(question),
    };
    this.scheduleBroadcast();
  }

  private refreshActivity(entry: RunEntry, screen: PreparedScreen): void {
    if (entry.card && entry.card.activity !== screen.activity) {
      entry.card = { ...entry.card, activity: screen.activity };
      this.scheduleBroadcast();
    }
  }

  private recordFailure(
    run: FleetRunRow,
    entry: RunEntry,
    seq: number,
    epoch: number,
    error: unknown
  ): void {
    if (this.disposed) return;
    // Abandoned on purpose (panel closed, keys changed, run left): not a
    // provider failure, and `invalidateInFlight` already reset the entry.
    if (error instanceof StaleTriagePass || !this.stillWanted(run, entry, seq, epoch)) {
      if (entry.seq === seq) entry.pending = false;
      return;
    }
    entry.pending = false;
    this.lastError =
      error instanceof TriageProviderError
        ? `${error.provider === "classifier" ? "Classifier" : "Describer"}: ${error.message}`
        : "Triage request failed";
    // Forget the hash so the next scan retries this screen instead of trusting
    // a card that was never finished.
    if (entry.seq === seq) {
      entry.hash = null;
      if (entry.card) entry.card = { ...entry.card, describing: false };
    }
    this.scheduleBroadcast();
  }

  private pruneDeparted(runs = this.deps.getRuns()): boolean {
    if (runs === null) return false;
    // By incarnation, not id: a terminal respawned under the same id must not
    // inherit the old one's card, even for the moment before it is re-read.
    const live = new Map(runs.map((run) => [run.runId, run.spawnedAt]));
    let changed = false;
    for (const [runId, entry] of this.entries) {
      const spawnedAt = live.get(runId);
      if (spawnedAt === undefined || (entry.card !== null && entry.card.spawnedAt !== spawnedAt)) {
        this.entries.delete(runId);
        changed = true;
      }
    }
    return changed;
  }

  private scheduleBroadcast(): void {
    if (this.disposed || this.broadcastTimer !== null) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if (!this.disposed) this.deps.broadcast(this.getSnapshot());
    }, BROADCAST_DEBOUNCE_MS);
  }
}

function needsAttention(probability: number): boolean {
  return probability >= TRIAGE_ATTENTION_THRESHOLD;
}

function normalize(text: string): string {
  return text
    .replace(/[❯›>▶●]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * `text` when it is on the screen, else null — the describer may only quote.
 * A trailing key hint like "(esc)" or "(y)" is allowed to differ.
 */
function onScreen(text: string | null, screen: string): string | null {
  if (text === null) return null;
  const wanted = normalize(text.replace(/\s*\((?:esc|[a-z])\)\s*$/i, ""));
  if (wanted.length === 0) return null;
  return normalize(screen).includes(wanted) ? text : null;
}

/**
 * The options that are really on screen, in the order the CLI draws them — the
 * panel numbers its buttons, and a "1" that isn't the CLI's own 1 misleads.
 */
function optionsInScreenOrder(options: readonly string[], screen: string): string[] {
  const haystack = normalize(screen);
  return options
    .map((option) => ({
      option,
      at:
        onScreen(option, screen) === null
          ? -1
          : haystack.indexOf(normalize(option.replace(/\s*\((?:esc|[a-z])\)\s*$/i, ""))),
    }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.option);
}

/** Thrown inside a slot when the pass that queued it is no longer wanted. */
class StaleTriagePass extends Error {}

class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.available = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available === 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.available--;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.available++;
    }
  }
}
