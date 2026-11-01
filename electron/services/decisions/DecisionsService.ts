import type { QuestionRow } from "@daintreehq/decisions-client";
import type {
  DecisionsSettings,
  DecisionsState,
  DecisionsStatus,
  DecisionsStatusEvent,
  PaneDecisionState,
} from "../../../shared/types/decisions.js";
import type { DaintreeLocalStore } from "./daintreeLocalStore.js";
import { decisionsLibraries, type DecisionsLibraries } from "./libraries.js";
import { openDecisionsLocalStore } from "./openLocalStore.js";
import { decisionsKeyFilePath, SealedKeyStore } from "./keyStore.js";
import { PaneDecisionStates, type PaneDecisionStatePublisher } from "./paneDecisionState.js";

export type DecisionsStatusListener = (event: DecisionsStatusEvent) => void;

/** Opens the store for an enabled lifetime; null when `isCancelled` turned true before it opened. */
export type DecisionsStoreOpener = (
  isCancelled: () => boolean
) => Promise<DaintreeLocalStore | null>;

export interface DecisionsServiceOptions {
  openStore?: DecisionsStoreOpener;
  /** Where the sealed keys live: `userData/decisions/keys.bin` unless a test says otherwise. */
  keyFilePath?: () => string;
  /** Sends one pane's state to its project's views (`terminal:decision-state`). */
  publishPaneState?: PaneDecisionStatePublisher;
}

/**
 * Decisions in main: one per process, made only once the setting is on. An
 * enabled lifetime runs from `start` to `stop`; the children that fill it in
 * (the store, keys, the relay socket) acquire their resources in `start` and
 * release them in `stop`, so turning Decisions off leaves nothing running.
 *
 * Transitions run one at a time, in the order asked, and a failed one doesn't
 * block the next. `dispose` is final: it wins over any start still queued.
 */
export class DecisionsService {
  readonly libraries: DecisionsLibraries = decisionsLibraries;

  private state: DecisionsState = "off";
  private settings: DecisionsSettings | null = null;
  private store: DaintreeLocalStore | null = null;
  private disposed = false;
  private readonly openStore: DecisionsStoreOpener;
  private transitions: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<DecisionsStatusListener>();
  private readonly keyFilePath: () => string;
  private keyStore: SealedKeyStore | null = null;
  private readonly panes: PaneDecisionStates;

  constructor(options: DecisionsServiceOptions = {}) {
    this.openStore = options.openStore ?? openDecisionsLocalStore;
    this.keyFilePath = options.keyFilePath ?? decisionsKeyFilePath;
    this.panes = new PaneDecisionStates(options.publishPaneState ?? (() => {}));
  }

  getStatus(): DecisionsStatus {
    return { state: this.state };
  }

  /** The settings the running lifetime started with; null while stopped. */
  getSettings(): DecisionsSettings | null {
    return this.settings;
  }

  /** The running lifetime's store; null while stopped, or while it couldn't be opened. */
  getStore(): DaintreeLocalStore | null {
    return this.store;
  }

  /**
   * The sealed key store for this enabled lifetime. It is made on first use,
   * so starting reads no file and asks no keychain: a keychain prompt waits
   * for setup, or for something that needs the identity.
   */
  getKeyStore(): SealedKeyStore {
    if (this.disposed || this.settings === null) {
      throw new Error("Decisions is off, so its keys can't be used");
    }
    this.keyStore ??= new SealedKeyStore(this.keyFilePath());
    return this.keyStore;
  }

  /** Called on every change of state, never for a repeat. Listeners outlive a stop, not a dispose. */
  onStatusChanged(listener: DecisionsStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A pane's state as last pushed; null while stopped, and for a pane with nothing outstanding. */
  getPaneState(terminalId: string): PaneDecisionState | null {
    return this.state === "off" ? null : this.panes.get(terminalId);
  }

  /**
   * The store's question rows, all of them, after a write commits: each
   * pane's state becomes what they show, and the panes that changed are
   * pushed. Ignored while stopped, so nothing is pushed while Decisions is off.
   */
  observeQuestions(rows: readonly QuestionRow[]): void {
    if (this.disposed || this.state === "off") return;
    this.panes.replace(rows);
  }

  /**
   * Begins, or carries on, an enabled lifetime with these settings. Settings
   * that are off start nothing. Rejects when the store can't be opened; the
   * lifetime stays on, and the next start tries the store again.
   */
  start(settings: DecisionsSettings): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed || !settings.enabled) return;
      this.settings = settings;
      // There is no relay identity until a relay is claimed or restored, and no
      // socket until one opens, so on is honestly "not connected" for now.
      if (this.state === "off") this.setState("not-connected");
      if (this.store) return;
      const opened = await this.openStore(() => this.disposed);
      if (this.disposed) {
        await opened?.close();
        return;
      }
      this.store = opened;
    });
  }

  /** Ends the enabled lifetime, keeping everything stored. Another `start` may follow. */
  stop(): Promise<void> {
    return this.enqueue(() => this.release(true));
  }

  /** App shutdown: ends the lifetime for good, and no later start is honoured. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.enqueue(async () => {
      await this.release(false);
      this.listeners.clear();
    });
  }

  /**
   * The stored rows and the key file stay: turning Decisions off keeps them
   * for the next time it is on. A stop tells each pane that showed something
   * that it has nothing now, so no view keeps a question that Decisions is no
   * longer tracking; at quit the views are going too, and nothing is pushed.
   * Panes are let go only once the store has closed, so a feed that lands
   * while it closes is cleared too.
   */
  private async release(clearViews: boolean): Promise<void> {
    const store = this.store;
    const keyStore = this.keyStore;
    this.store = null;
    this.keyStore = null;
    this.settings = null;
    try {
      // Commits what the lifetime left queued; the rows stay until deleted.
      await store?.close();
    } finally {
      this.panes.clear(clearViews && this.state !== "off");
      await keyStore?.close();
      this.setState("off");
    }
  }

  private enqueue(step: () => void | Promise<void>): Promise<void> {
    const run = this.transitions.then(step);
    this.transitions = run.catch(() => {});
    return run;
  }

  private setState(next: DecisionsState): void {
    if (this.state === next) return;
    this.state = next;
    const event: DecisionsStatusEvent = { type: "status-changed", status: this.getStatus() };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[Decisions] A status listener threw:", err);
      }
    }
  }
}
