import { stat } from "node:fs/promises";
import type { PolicyRegistry, QuestionRow } from "@daintreehq/decisions-client";
import type {
  DecisionsSettings,
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
import type { DecisionsQuestions } from "./mcpRoute.js";
import { PaneDecisionStates, type PaneDecisionStatePublisher } from "./paneDecisionState.js";
import { observeQuestionWrites, QuestionRowsFeed } from "./questionFeed.js";
import {
  RelayConnection,
  type QuestionSource,
  type RelayBinding,
  type RelayConnectionOptions,
} from "./relayConnection.js";
import { createTrustedPolicy } from "./workflowGates.js";

export type DecisionsStatusListener = (event: DecisionsStatusEvent) => void;

/** What the service runs a relay connection with; tests hand in their own. */
export interface DecisionsRelayConnection {
  start(): void;
  stop(): void;
}

export type DecisionsConnectionFactory = (
  options: RelayConnectionOptions
) => DecisionsRelayConnection;

/** The service's own part of the status; the entry adds what the setting says. */
type ServiceStatus = Pick<DecisionsStatus, "state" | "nextAttemptAt" | "problem">;

/** The relay a lifetime's settings name, complete; null while one isn't set up. */
export function relayBindingOf(settings: DecisionsSettings | null): RelayBinding | null {
  if (!settings?.relayOrigin || !settings.installationId || !settings.deviceId) return null;
  return {
    relayOrigin: settings.relayOrigin,
    installationId: settings.installationId,
    deviceId: settings.deviceId,
  };
}

function bindingKey(relay: RelayBinding): string {
  return `${relay.relayOrigin}\n${relay.installationId}\n${relay.deviceId}`;
}

function sameServiceStatus(a: ServiceStatus, b: ServiceStatus): boolean {
  return a.state === b.state && a.nextAttemptAt === b.nextAttemptAt && a.problem === b.problem;
}

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
  /**
   * The relay revoked the identity this lifetime connected with. The entry
   * records it in the setting, so no later lifetime connects with it either.
   */
  onRelayRevoked?: (relay: RelayBinding) => void;
  /** Makes the relay connection for a lifetime with a relay set up. */
  connect?: DecisionsConnectionFactory;
  /** The stored rows, for deleting them: the app database's unless a test says otherwise. */
  openRows?: () => Promise<DecisionsRows>;
  /**
   * Saves the setting without the relay's origin and ids, returning what was
   * saved; throws when it can't. A deletion of local data (#16025) calls it.
   */
  forgetIdentity?: () => DecisionsSettings;
  /**
   * Serves agents' questions over a connection that can take them
   * (`/mcp/decisions`, #16011), once `previousClosed` (the routes closed
   * before it letting go of the listener) has settled. Without it, no route
   * is served.
   */
  openQuestions?: (source: QuestionSource, previousClosed: Promise<void>) => DecisionsQuestions;
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

  private status: ServiceStatus = { state: "off" };
  private settings: DecisionsSettings | null = null;
  private store: DaintreeLocalStore | null = null;
  private disposed = false;
  private readonly openStore: DecisionsStoreOpener;
  private transitions: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<DecisionsStatusListener>();
  private readonly keyFilePath: () => string;
  private keyStore: SealedKeyStore | null = null;
  private readonly panes: PaneDecisionStates;
  private readonly connect: DecisionsConnectionFactory;
  private readonly onRelayRevoked: (relay: RelayBinding) => void;
  private connection: DecisionsRelayConnection | null = null;
  private connectionKey: string | null = null;
  /**
   * The trusted policy for this enabled lifetime. One registry serves every
   * bridge the lifetime runs, attempt after attempt, so a change to the proxy
   * allowlist reaches the running bridge without a reconnect.
   */
  private policy: PolicyRegistry | null = null;
  private readonly openQuestions: NonNullable<DecisionsServiceOptions["openQuestions"]> | null;
  /** The route agents ask through, while the connection can take questions. */
  private questions: DecisionsQuestions | null = null;
  /** Routes closed and not yet let go of the listener; a stop waits for them. */
  private questionsClosing: Promise<void> = Promise.resolve();
  /** Feeds the panes' state from the lifetime's store, for as long as it is open. */
  private feed: QuestionRowsFeed | null = null;
  /** The store didn't open for this lifetime; the next start tries it again. */
  private storeFailed = false;
  /**
   * The identity a connection saw revoked. Held until the settings name
   * another relay or none, so a start that carries settings read before the
   * revocation was recorded can't connect with it again.
   */
  private revokedKey: string | null = null;
  private readonly openRows: () => Promise<DecisionsRows>;
  private readonly forgetIdentity: () => DecisionsSettings;

  constructor(options: DecisionsServiceOptions = {}) {
    this.openStore = options.openStore ?? openDecisionsLocalStore;
    this.keyFilePath = options.keyFilePath ?? decisionsKeyFilePath;
    this.panes = new PaneDecisionStates(options.publishPaneState ?? (() => {}));
    this.connect = options.connect ?? ((connection) => new RelayConnection(connection));
    this.onRelayRevoked = options.onRelayRevoked ?? (() => {});
    this.openRows = options.openRows ?? openDecisionsRows;
    this.forgetIdentity =
      options.forgetIdentity ??
      (() => {
        throw new Error("Nothing saves the Decisions setting here");
      });
    this.openQuestions = options.openQuestions ?? null;
  }

  getStatus(): DecisionsStatus {
    return { ...this.status };
  }

  private get state(): DecisionsStatus["state"] {
    return this.status.state;
  }

  /** The settings the running lifetime started with; null while stopped. */
  getSettings(): DecisionsSettings | null {
    return this.settings;
  }

  /** The policy this lifetime asks questions under; null while stopped. */
  getPolicy(): PolicyRegistry | null {
    return this.policy;
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
    this.applyPolicy(settings);
    this.reconcileConnection();
  }

  /**
   * Stops the relay connection until the next settings change or
   * `resumeConnection`: disconnecting removes the keys it runs on, so it
   * stops first.
   */
  suspendConnection(): void {
    this.dropConnection();
    if (this.settings !== null && !this.disposed) this.setStatus({ state: "not-connected" });
  }

  /** Connects again after `suspendConnection`, if the settings still want it. */
  resumeConnection(): void {
    if (this.settings !== null && !this.disposed) this.reconcileConnection();
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
      this.applyPolicy(settings);
      // There is no relay identity until a relay is claimed or restored, and no
      // socket until one opens, so on is honestly "not connected" for now.
      if (this.state === "off") this.setStatus({ state: "not-connected" });
      if (!this.store) {
        let opened: DaintreeLocalStore | null;
        try {
          // A deletion that stopped partway is finished or undone before any row
          // can be written, since the rows left are how it tells which.
          await finishInterruptedErase(this.eraseDeps());
          if (this.disposed) return;
          opened = await this.openStore(() => this.disposed);
        } catch (error) {
          this.storeFailed = true;
          this.reconcileConnection();
          throw error;
        }
        if (this.disposed) {
          await opened?.close();
          return;
        }
        this.store = opened;
        this.storeFailed = false;
        if (opened) {
          // The panes show what the store holds from the start, then after every write.
          this.feed = new QuestionRowsFeed(
            () => opened.listQuestions(),
            (rows) => this.observeQuestions(rows)
          );
          this.feed.refresh();
        }
      }
      this.reconcileConnection();
    });
  }

  /**
   * Deletes this computer's Decisions data (#16025): the stored rows, the key
   * file and the relay record in the setting. The relay connection stops and
   * the store and the key store close first, committing what was queued, and
   * an empty store opens after, so the lifetime carries on with nothing
   * stored. A deletion that didn't finish leaves the store closed, since a row
   * written now would read as one it never reached; the next start finishes
   * it first. Only while on.
   */
  eraseLocalData(): Promise<LocalEraseOutcome> {
    return this.enqueue(async () => {
      if (this.disposed || this.settings === null) {
        throw new Error("Decisions is off, so its data can't be deleted");
      }
      // The connection goes first: nothing may reach the store or keys once they close.
      this.dropConnection();
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
          this.storeFailed = false;
        } catch (err) {
          // The next start tries again; the deletion stands either way.
          this.storeFailed = true;
          console.warn("[Decisions] The store didn't reopen after deleting data:", err);
        }
      }
      // A deletion that changed nothing reconnects; one that forgot the relay has none to.
      if (!this.disposed && this.settings !== null) this.reconcileConnection();
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
    // The connection goes first: nothing may reach the store or keys once they close.
    this.dropConnection();
    this.feed?.stop();
    this.feed = null;
    // The route lets go of the listener before the lifetime ends.
    await this.questionsClosing;
    const store = this.store;
    const keyStore = this.keyStore;
    this.store = null;
    this.keyStore = null;
    this.settings = null;
    this.policy = null;
    this.storeFailed = false;
    try {
      // Commits what the lifetime left queued; the rows stay until deleted.
      await store?.close();
    } finally {
      this.panes.clear(clearViews && !this.disposed && this.state !== "off");
      await keyStore?.close();
      this.setStatus({ state: "off" });
    }
  }

  /**
   * Runs the relay connection the settings call for: one per relay identity,
   * only with the store open and the identity not revoked. A different
   * identity (a disconnect and a new claim) gets a fresh connection.
   */
  private reconcileConnection(): void {
    const settings = this.settings;
    const relay = this.disposed ? null : relayBindingOf(settings);
    const relayKey = relay ? bindingKey(relay) : null;
    if (settings !== null && relayKey !== this.revokedKey) this.revokedKey = null;
    const revoked =
      relay !== null && (settings?.revokedAt !== null || relayKey === this.revokedKey);
    const wanted = relay !== null && !revoked && this.store !== null ? relay : null;
    const key = wanted ? relayKey : null;
    if (this.connectionKey !== key) this.dropConnection();
    if (wanted === null || key === null) {
      if (this.disposed || settings === null) return;
      if (revoked) this.setStatus({ state: "revoked" });
      else if (relay !== null && this.storeFailed) {
        this.setStatus({ state: "not-connected", problem: "storage" });
      } else this.setStatus({ state: "not-connected" });
      return;
    }
    if (this.connection) return;
    const store = this.store;
    const policy = this.policy;
    if (!store || !policy) return;
    let connection: DecisionsRelayConnection | null = null;
    const feed = this.feed;
    connection = this.connect({
      relay: wanted,
      store: observeQuestionWrites(store, () => feed?.refresh()),
      keys: this.getKeyStore(),
      policy,
      onStatus: (status) => {
        if (this.connection !== connection) return;
        // Stopped for this lifetime: nothing could publish what an agent asks.
        if (status.state === "not-connected" || status.state === "revoked") this.closeQuestions();
        this.setStatus(status);
      },
      onQuestionsReady: (source) => {
        if (this.connection !== connection || this.openQuestions === null) return;
        this.closeQuestions();
        try {
          this.questions = this.openQuestions(source, this.questionsClosing);
        } catch (error) {
          console.warn("[Decisions] /mcp/decisions couldn't be opened:", error);
        }
      },
      onRevoked: () => {
        if (this.connection !== connection) return;
        this.revokedKey = key;
        this.onRelayRevoked(wanted);
        // Revoked whether or not the setting recorded it.
        this.reconcileConnection();
      },
    });
    this.connection = connection;
    this.connectionKey = key;
    connection.start();
  }

  /**
   * The lifetime's policy, made on its first start and updated in place after
   * that: replacing it would leave the running bridge on the old one. Already
   * asked questions keep the level they were asked with.
   */
  private applyPolicy(settings: DecisionsSettings): void {
    if (this.policy) this.policy.proxyAllowlisted = settings.proxyAllowlisted;
    else this.policy = createTrustedPolicy(settings);
  }

  private dropConnection(): void {
    const connection = this.connection;
    this.connection = null;
    this.connectionKey = null;
    this.closeQuestions();
    connection?.stop();
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

  /** Refuses agents' questions at once; the listener hold goes when the route has let go. */
  private closeQuestions(): void {
    const questions = this.questions;
    this.questions = null;
    if (questions === null) return;
    const closed = questions.close().catch((error: unknown) => {
      console.warn("[Decisions] Closing /mcp/decisions failed:", error);
    });
    this.questionsClosing = Promise.all([this.questionsClosing, closed]).then(() => {});
  }

  private enqueue<T>(step: () => T | Promise<T>): Promise<T> {
    const run = this.transitions.then(step);
    this.transitions = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  private setStatus(next: ServiceStatus): void {
    if (sameServiceStatus(this.status, next)) return;
    this.status = {
      state: next.state,
      ...(next.nextAttemptAt !== undefined ? { nextAttemptAt: next.nextAttemptAt } : {}),
      ...(next.problem !== undefined ? { problem: next.problem } : {}),
    };
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
