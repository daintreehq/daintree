import { stat } from "node:fs/promises";
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
import { openDecisionsLocalStore, openDecisionsRows } from "./openLocalStore.js";
import { decisionsKeyFilePath, SealedKeyStore } from "./keyStore.js";
import {
  eraseLocalDecisionsData,
  finishInterruptedErase,
  type DecisionsRows,
  type LocalEraseDeps,
  type LocalEraseOutcome,
} from "./localData.js";
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
  /** The stored rows, for deleting them: the app database's unless a test says otherwise. */
  openRows?: () => Promise<DecisionsRows>;
  /**
   * Saves the setting without the relay's origin and ids, returning what was
   * saved; throws when it can't. A deletion of local data (#16025) calls it.
   */
  forgetIdentity?: () => DecisionsSettings;
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
  private readonly openRows: () => Promise<DecisionsRows>;
  private readonly forgetIdentity: () => DecisionsSettings;

  constructor(options: DecisionsServiceOptions = {}) {
    this.openStore = options.openStore ?? openDecisionsLocalStore;
    this.keyFilePath = options.keyFilePath ?? decisionsKeyFilePath;
    this.panes = new PaneDecisionStates(options.publishPaneState ?? (() => {}));
    this.openRows = options.openRows ?? openDecisionsRows;
    this.forgetIdentity =
      options.forgetIdentity ??
      (() => {
        throw new Error("Nothing saves the Decisions setting here");
      });
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

  /**
   * The running lifetime's settings changed under it: a relay was claimed,
   * restored or disconnected. Ignored while stopped, and for settings that are off.
   */
  updateSettings(settings: DecisionsSettings): void {
    if (this.disposed || this.settings === null || !settings.enabled) return;
    this.settings = settings;
  }

  /**
   * Whether the key file exists, from its presence alone: no keychain is
   * asked and nothing is opened. Anything there but a missing file counts.
   */
  async hasKeyFile(): Promise<boolean> {
    try {
      await stat(this.keyFilePath());
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code !== "ENOENT";
    }
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
      // A deletion that stopped partway is finished or undone before any row
      // can be written, since the rows left are how it tells which.
      await finishInterruptedErase(this.eraseDeps());
      if (this.disposed) return;
      const opened = await this.openStore(() => this.disposed);
      if (this.disposed) {
        await opened?.close();
        return;
      }
      this.store = opened;
    });
  }

  /**
   * Deletes this computer's Decisions data (#16025): the stored rows, the key
   * file and the relay record in the setting. The store and the key store
   * close first, committing what was queued, and an empty store opens after,
   * so the lifetime carries on with nothing stored. A deletion that didn't
   * finish leaves the store closed, since a row written now would read as one
   * it never reached; the next start finishes it first. Only while on.
   */
  eraseLocalData(): Promise<LocalEraseOutcome> {
    return this.enqueue(async () => {
      if (this.disposed || this.settings === null) {
        throw new Error("Decisions is off, so its data can't be deleted");
      }
      const store = this.store;
      const keyStore = this.keyStore;
      this.store = null;
      this.keyStore = null;
      try {
        await store?.close();
      } finally {
        await keyStore?.close();
      }
      const outcome = await eraseLocalDecisionsData(this.eraseDeps());
      // Every row is gone, so no pane has anything outstanding.
      if (outcome.result !== "failed") this.panes.clear(true);
      if (outcome.result !== "incomplete" && !this.disposed && this.settings !== null) {
        try {
          this.store = await this.openStore(() => this.disposed);
        } catch (err) {
          // The next start tries again; the deletion stands either way.
          console.warn("[Decisions] The store didn't reopen after deleting data:", err);
        }
      }
      return outcome;
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
      this.panes.clear(clearViews && !this.disposed && this.state !== "off");
      await keyStore?.close();
      this.setState("off");
    }
  }

  private eraseDeps(): LocalEraseDeps {
    return {
      keyFilePath: this.keyFilePath(),
      openRows: this.openRows,
      forgetIdentity: () => {
        const saved = this.forgetIdentity();
        if (this.settings !== null && saved.enabled) this.settings = saved;
      },
    };
  }

  private enqueue<T>(step: () => T | Promise<T>): Promise<T> {
    const run = this.transitions.then(step);
    this.transitions = run.then(
      () => {},
      () => {}
    );
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
