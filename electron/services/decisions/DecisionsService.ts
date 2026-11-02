import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PolicyRegistry, QuestionRow } from "@daintreehq/decisions-client";
import type {
  DecisionsSettings,
  DecisionsStatus,
  DecisionsStatusEvent,
  PaneDecisionState,
} from "../../../shared/types/decisions.js";
import type { AnswerDelivery, AnswerDeliveryDeps } from "./answerDelivery.js";
import { createWorktreeAttachmentResolver } from "./attachmentResolver.js";
import { DecisionsAttachments } from "./attachmentSpool.js";
import { readHandledAnswers, withoutHandled } from "./attentionList.js";
import type { DaintreeLocalStore } from "./daintreeLocalStore.js";
import { decisionsLibraries, type DecisionsLibraries } from "./libraries.js";
import { openDecisionsLocalStore, openDecisionsRows } from "./openLocalStore.js";
import { KeyRotations } from "./keyRotation.js";
import { decisionsKeyFilePath, SealedKeyStore } from "./keyStore.js";
import {
  eraseLocalDecisionsData,
  finishInterruptedErase,
  type DecisionsRows,
  type LocalEraseDeps,
  type LocalEraseOutcome,
} from "./localData.js";
import type { DecisionsQuestions } from "./mcpRoute.js";
import {
  PaneDecisionStates,
  type AnswerAttentionPublisher,
  type PaneDecisionStatePublisher,
} from "./paneDecisionState.js";
import { observeQuestionWrites, QuestionRowsFeed } from "./questionFeed.js";
import {
  RelayConnection,
  type QuestionSource,
  type RelayBinding,
  type RelayConnectionOptions,
} from "./relayConnection.js";
import type { SetupDiagnostics } from "./setupDiagnostic.js";
import { createTrustedPolicy } from "./workflowGates.js";

export type DecisionsStatusListener = (event: DecisionsStatusEvent) => void;

/**
 * Whose lifetime runs: this computer as the owner, under its switch, or as a
 * Remote Host its owner enrolled (#16022), serving its own panes with the
 * `desktop-host` identity it was given. One at a time: they share the key
 * file and the store.
 */
export type DecisionsRole = "owner" | "host";

/** What the service runs a relay connection with; tests hand in their own. */
export interface DecisionsRelayConnection {
  start(): void;
  /** Resolves, if it returns a promise, once the connection writes nothing more to the store. */
  stop(): void | Promise<void>;
  /** Starts a fresh attempt now; false when none can start. */
  refresh?(): boolean;
  /** The connection's answer delivery, while it runs; what the needs-attention list acts through. */
  getDelivery?(): AnswerDelivery | null;
}

/** What delivery needs from main, apart from this machine's host id, which the service reads from its settings. */
export type DecisionsDeliveryDeps = Omit<AnswerDeliveryDeps, "hostId">;

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
  /**
   * Where asked attachments' ciphertext waits to upload, given where the keys
   * live: `spool` beside the key file unless a test says otherwise.
   */
  attachmentSpoolDir?: (keyFilePath: string) => string;
  /** Sends one pane's state to its project's views (`terminal:decision-state`). */
  publishPaneState?: PaneDecisionStatePublisher;
  /** Tells the fleet which panes have answers needing a person (`runAnswerAttentionSource`). */
  publishAnswerAttention?: AnswerAttentionPublisher;
  /**
   * The relay revoked the identity this lifetime connected with. The entry
   * records it, in the setting or the Host's record, so no later lifetime
   * connects with it either.
   */
  onRelayRevoked?: (relay: RelayBinding, role: DecisionsRole) => void;
  /**
   * The relay's devices changed, as the running connection observed it: a
   * device event in the ledger, or a pending key rotation finished (#16010).
   */
  onDevicesChanged?: () => void;
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
  /** Types received answers into the panes that asked (#16017); without it answers stay stored. */
  delivery?: DecisionsDeliveryDeps;
  /** The setup check's diagnostic terminals (#16024), whose own image their questions attach. */
  diagnostics?: SetupDiagnostics;
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
  private role: DecisionsRole = "owner";
  private store: DaintreeLocalStore | null = null;
  private disposed = false;
  private readonly openStore: DecisionsStoreOpener;
  private transitions: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<DecisionsStatusListener>();
  private readonly keyFilePath: () => string;
  private keyStore: SealedKeyStore | null = null;
  private rotations: KeyRotations | null = null;
  /** Local data is being deleted (#16025): no key store or rotation is made until it finishes. */
  private erasing = false;
  private readonly panes: PaneDecisionStates;
  private readonly connect: DecisionsConnectionFactory;
  private readonly onRelayRevoked: (relay: RelayBinding, role: DecisionsRole) => void;
  private readonly onDevicesChanged: () => void;
  private readonly delivery: DecisionsDeliveryDeps | null;
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
  /** What the running connection takes questions through, once it can; null otherwise. */
  private questionSource: QuestionSource | null = null;
  private readonly diagnostics: SetupDiagnostics | null;
  /** Routes closed and not yet let go of the listener; a stop waits for them. */
  private questionsClosing: Promise<void> = Promise.resolve();
  /**
   * A connection is loading its identity, or is about to be made once the one
   * before it settles: the route opens, or it stops, soon.
   */
  private questionsPending = false;
  /** Launches waiting on that, woken at every change to look again. */
  private readonly questionsWaiters = new Set<() => void>();
  /** Feeds the panes' state from the lifetime's store, for as long as it is open. */
  private feed: QuestionRowsFeed | null = null;
  private offCommit: (() => void) | null = null;
  /** Connections stopped but still settling: the store closes only after them. */
  private readonly stopping = new Set<Promise<void>>();
  /**
   * No connection may start: a suspension until the next settings change or
   * resume, a stop until the next start. Set synchronously, so a reconcile
   * deferred behind a settling connection can't start one meanwhile.
   */
  private paused = false;
  /** The store didn't open for this lifetime; the next start tries it again. */
  private storeFailed = false;
  /** The open store's attachment spool and ask gate (#16014); null while it is closed. */
  private attachments: DecisionsAttachments | null = null;
  private readonly attachmentSpoolDir: (keyFilePath: string) => string;
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
    this.attachmentSpoolDir =
      options.attachmentSpoolDir ?? ((keyFilePath) => join(dirname(keyFilePath), "spool"));
    this.panes = new PaneDecisionStates(
      options.publishPaneState ?? (() => {}),
      Date.now,
      options.publishAnswerAttention
    );
    this.connect = options.connect ?? ((connection) => new RelayConnection(connection));
    this.onRelayRevoked = options.onRelayRevoked ?? (() => {});
    this.onDevicesChanged = options.onDevicesChanged ?? (() => {});
    this.openRows = options.openRows ?? openDecisionsRows;
    this.forgetIdentity =
      options.forgetIdentity ??
      (() => {
        throw new Error("Nothing saves the Decisions setting here");
      });
    this.openQuestions = options.openQuestions ?? null;
    this.delivery = options.delivery ?? null;
    this.diagnostics = options.diagnostics ?? null;
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

  /** Whose lifetime runs; null while stopped. */
  getRole(): DecisionsRole | null {
    return this.settings === null ? null : this.role;
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
    // A key store made now could write the key file back after it is deleted.
    if (this.erasing) throw new Error("Decisions is deleting its data, so its keys can't be used");
    this.keyStore ??= new SealedKeyStore(this.keyFilePath());
    return this.keyStore;
  }

  /**
   * The enabled lifetime's key rotations over its key store (#16010): every
   * revoke, rotation, approval and pending-rotation settle takes its turn
   * here. Stopping waits for the one running before the keys close.
   */
  getKeyRotations(): KeyRotations {
    const keys = this.getKeyStore();
    this.rotations ??= new KeyRotations(keys);
    return this.rotations;
  }

  /**
   * The running lifetime's settings changed under it: a relay was claimed,
   * restored or disconnected. Ignored while stopped, and for settings that are off.
   */
  updateSettings(settings: DecisionsSettings): void {
    if (this.disposed || this.settings === null || !settings.enabled) return;
    this.settings = settings;
    this.applyPolicy(settings);
    this.paused = false;
    this.reconcileConnection();
  }

  /**
   * Stops the relay connection until the next settings change or
   * `resumeConnection`: disconnecting removes the keys it runs on, so it
   * stops first. Resolves once nothing it started can reach the keys or the
   * store: an answer being typed settles first.
   */
  suspendConnection(): Promise<void> {
    this.paused = true;
    this.dropConnection();
    if (this.settings !== null && !this.disposed) this.setStatus({ state: "not-connected" });
    return this.settledConnections();
  }

  /**
   * What the running connection takes questions through, for the setup
   * check (#16024) to ask its test question the way an agent's is asked;
   * null while no connection can take one.
   */
  getQuestionSource(): QuestionSource | null {
    return this.questionSource;
  }

  /** Starts the running connection's fresh attempt (#16024); false when there is none, or it can't. */
  refreshConnection(): boolean {
    return this.connection?.refresh?.() ?? false;
  }

  /** Connects again after `suspendConnection`, if the settings still want it. */
  resumeConnection(): void {
    if (this.settings === null || this.disposed) return;
    this.paused = false;
    this.reconcileConnection();
  }

  /** Where this lifetime's sealed keys live, read or not. */
  getKeyFilePath(): string {
    return this.keyFilePath();
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

  /**
   * The listener port agents ask through (#16012), once this lifetime's
   * connection has opened `/mcp/decisions`. A connection still loading its
   * identity is waited for, up to `waitMs`. Null at once while stopped, with
   * no connection, or with one that stopped for the lifetime.
   */
  async questionsPort(waitMs: number): Promise<number | null> {
    const deadline = Date.now() + waitMs;
    // Woken by every change, since one connection can give way to the next
    // (a new identity) without the route ever being there in between.
    while (this.questions === null && this.questionsPending) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.questionsWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.questionsWaiters.add(done);
      });
    }
    return (await this.questions?.listenerPort()) ?? null;
  }

  /** A pane's state as last pushed; null while stopped, and for a pane with nothing outstanding. */
  /**
   * The running connection's answer delivery, which the needs-attention list
   * (#16020) reads and acts through; null while none runs (off, no relay set
   * up, revoked, or stopped for a problem).
   */
  getAnswerDelivery(): AnswerDelivery | null {
    if (this.disposed || this.state === "off") return null;
    return this.connection?.getDelivery?.() ?? null;
  }

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
   * Begins, or carries on, an enabled lifetime with these settings, as
   * `role`. Settings that are off start nothing. A lifetime of the other role
   * ends first, as a stop would. Rejects when the store can't be opened; the
   * lifetime stays on, and the next start tries the store again.
   */
  start(settings: DecisionsSettings, role: DecisionsRole = "owner"): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed || !settings.enabled) return;
      if (this.settings !== null && this.role !== role) await this.release(true);
      if (this.disposed) return;
      this.role = role;
      this.settings = settings;
      this.applyPolicy(settings);
      this.paused = false;
      // There is no relay identity until a relay is claimed or restored, and no
      // socket until one opens, so on is honestly "not connected" for now.
      if (this.state === "off") this.setStatus({ state: "not-connected" });
      if (!this.store) {
        const keyFilePath = this.keyFilePath();
        let opened: DaintreeLocalStore | null;
        try {
          // A deletion that stopped partway is finished or undone before any row
          // can be written, since the rows left are how it tells which.
          await finishInterruptedErase(this.eraseDeps(keyFilePath));
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
        this.storeFailed = false;
        await this.adoptStore(opened, keyFilePath);
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
      this.paused = true;
      let outcome: LocalEraseOutcome;
      const keyFilePath = this.keyFilePath();
      try {
        this.dropConnection();
        // An answer being typed settles before the store stops taking its result.
        await this.settledConnections();
        // An ask still spooling finishes too; the spool it leaves goes with the rows.
        await this.closeAttachments();
        const store = this.detachStore();
        const keyStore = this.keyStore;
        const rotations = this.rotations;
        this.keyStore = null;
        this.rotations = null;
        this.erasing = true;
        try {
          try {
            await store?.close();
          } finally {
            // A rotation saving its key finishes before the key file goes.
            await rotations?.close();
            await keyStore?.close();
          }
          outcome = await eraseLocalDecisionsData(this.eraseDeps(keyFilePath));
        } finally {
          this.erasing = false;
        }
        // Every row is gone, so no pane has anything outstanding.
        if (outcome.result !== "failed") this.panes.clear(true);
        if (outcome.result !== "incomplete" && !this.disposed && this.settings !== null) {
          try {
            const reopened = await this.openStore(() => this.disposed);
            this.storeFailed = false;
            // No create is left, so its attachments' first sweep empties the spool.
            await this.adoptStore(reopened, keyFilePath);
          } catch (err) {
            // The next start tries again; the deletion stands either way.
            this.storeFailed = true;
            console.warn("[Decisions] The store didn't reopen after deleting data:", err);
          }
        }
      } finally {
        this.paused = false;
      }
      // A deletion that changed nothing reconnects; one that forgot the relay has none to.
      if (!this.disposed && this.settings !== null) this.reconcileConnection();
      return outcome;
    });
  }

  /**
   * Deletes the stored rows, keeping the key file, while no lifetime runs: a
   * Remote Host's replaced device's questions (#16022), which only the device
   * that asked could have had answered.
   */
  eraseStoredRows(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      if (this.settings !== null) {
        throw new Error("Decisions is running, so its stored rows can't be deleted");
      }
      const rows = await this.openRows();
      if (rows.exist()) rows.erase();
    });
  }

  /**
   * Removes a revoked Remote Host's keys (#16022) while no lifetime runs, only
   * if the key file still holds that device's: keys an enrollment saved for
   * another device meanwhile stay. Resolves once that device's keys are
   * gone; rejects when the file can't be opened, removing nothing.
   */
  clearHostKeys(deviceId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) throw new Error("Decisions has stopped for this run");
      if (this.settings !== null) {
        throw new Error("Decisions is running, so its keys can't be removed");
      }
      const keys = new SealedKeyStore(this.keyFilePath());
      try {
        await keys.clearIf(
          (stored) =>
            stored !== null && stored.role === "desktop-host" && stored.config.deviceId === deviceId
        );
      } finally {
        await keys.close();
      }
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
    this.paused = true;
    this.dropConnection();
    // An answer being typed settles before the store stops taking its result.
    await this.settledConnections();
    // The route lets go of the listener before the lifetime ends.
    await this.questionsClosing;
    await this.closeAttachments();
    const store = this.detachStore();
    const keyStore = this.keyStore;
    const rotations = this.rotations;
    this.keyStore = null;
    this.rotations = null;
    this.settings = null;
    this.policy = null;
    this.storeFailed = false;
    try {
      // Commits what the lifetime left queued; the rows stay until deleted.
      await store?.close();
    } finally {
      this.panes.clear(clearViews && !this.disposed && this.state !== "off");
      // A rotation that is saving its key finishes before the keys close.
      await rotations?.close();
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
    const wanted = relay !== null && !revoked && this.store !== null && !this.paused ? relay : null;
    const key = wanted ? relayKey : null;
    if (this.connectionKey !== key) this.dropConnection();
    if (wanted === null || key === null) {
      this.settleQuestions();
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
    if (!store || !policy) {
      this.settleQuestions();
      return;
    }
    if (this.stopping.size > 0) {
      // One connection's delivery at a time: a replacement waits for the one
      // stopped before it to settle what it was typing, or its recovery would
      // take that injection for a crashed one. Launches wait for it meanwhile.
      this.questionsPending = true;
      void this.settledConnections().then(() => {
        if (!this.disposed && this.store === store) this.reconcileConnection();
        else if (this.connection === null) this.settleQuestions();
      });
      return;
    }
    let connection: DecisionsRelayConnection | null = null;
    const feed = this.feed;
    const delivery = this.delivery;
    const role = this.role;
    connection = this.connect({
      relay: wanted,
      role: role === "host" ? "desktop-host" : "owner-desktop",
      store: observeQuestionWrites(store, () => void feed?.refresh()),
      keys: this.getKeyStore(),
      rotations: this.getKeyRotations(),
      onDevicesChanged: () => {
        if (this.connection === connection) this.onDevicesChanged();
      },
      policy,
      ...(delivery
        ? { delivery: { ...delivery, hostId: () => this.settings?.hostId ?? null } }
        : {}),
      ...(this.attachments ? { attachments: this.attachments } : {}),
      onStatus: (status) => {
        if (this.connection !== connection) return;
        // Stopped for this lifetime: nothing could publish what an agent asks.
        if (status.state === "not-connected" || status.state === "revoked") {
          this.closeQuestions();
          this.settleQuestions();
        }
        this.setStatus(status);
      },
      onQuestionsReady: (source) => {
        if (this.connection !== connection) return;
        this.questionSource = source;
        if (this.openQuestions !== null) {
          this.closeQuestions();
          try {
            this.questions = this.openQuestions(source, this.questionsClosing);
          } catch (error) {
            console.warn("[Decisions] /mcp/decisions couldn't be opened:", error);
          }
        }
        this.settleQuestions();
      },
      onRevoked: () => {
        if (this.connection !== connection) return;
        this.revokedKey = key;
        this.onRelayRevoked(wanted, role);
        // Revoked whether or not the setting recorded it.
        this.reconcileConnection();
      },
    });
    this.connection = connection;
    this.connectionKey = key;
    this.questionsPending = true;
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
    this.questionSource = null;
    this.closeQuestions();
    this.settleQuestions();
    const stopped = connection?.stop();
    if (!(stopped instanceof Promise)) return;
    const settling = stopped.catch(() => {}).finally(() => this.stopping.delete(settling));
    this.stopping.add(settling);
  }

  /** Makes `opened` the lifetime's store, and shows each pane what it holds before anything new arrives. */
  private async adoptStore(opened: DaintreeLocalStore | null, keyFilePath: string): Promise<void> {
    this.store = opened;
    if (opened) this.openAttachments(opened, keyFilePath);
    await this.feedFrom(opened);
  }

  /** Lets go of the lifetime's store, and stops feeding the panes from it; the caller closes it. */
  private detachStore(): DaintreeLocalStore | null {
    void this.feedFrom(null);
    const store = this.store;
    this.store = null;
    return store;
  }

  /** Resolves once every connection stopped so far has settled. */
  private async settledConnections(): Promise<void> {
    while (this.stopping.size > 0) await Promise.all([...this.stopping]);
  }

  /** The route opened or won't: launches waiting on it go ahead with what there is. */
  private settleQuestions(): void {
    this.questionsPending = false;
    for (const wake of [...this.questionsWaiters]) wake();
  }

  private eraseDeps(keyFilePath: string): LocalEraseDeps {
    return {
      keyFilePath,
      openRows: this.openRows,
      forgetIdentity: () => {
        const saved = this.forgetIdentity();
        if (this.settings !== null && saved.enabled) this.settings = saved;
      },
    };
  }

  /**
   * The panes show what `store` holds from now on, read once now and again
   * after every write it commits; null feeds them nothing, as while the store
   * is closed. Resolves once the first read has been shown.
   */
  private feedFrom(store: DaintreeLocalStore | null): Promise<void> {
    this.feed?.stop();
    this.feed = null;
    this.offCommit?.();
    this.offCommit = null;
    if (store === null) return Promise.resolve();
    // What a person marked handled (#16020) shows nowhere: not on its pane, in Canopy or the list.
    const feed = new QuestionRowsFeed(
      async () => withoutHandled(await store.listQuestions(), await readHandledAnswers(store)),
      (rows) => this.observeQuestions(rows)
    );
    this.feed = feed;
    this.offCommit = store.onCommit(() => void feed.refresh());
    return feed.refresh();
  }

  /**
   * The attachments of `store`, swept now of what an earlier run or lifetime
   * left, before any ask can spool.
   */
  private openAttachments(store: DaintreeLocalStore, keyFilePath: string): void {
    this.attachments = new DecisionsAttachments({
      dir: this.attachmentSpoolDir(keyFilePath),
      referenced: () => store.referencedAttachmentIds(),
      ...(this.diagnostics
        ? { resolver: this.diagnostics.attachmentResolver(createWorktreeAttachmentResolver()) }
        : {}),
    });
  }

  /** Takes no more asks, once the one spooling (and its cleanup) has settled. Files stay. */
  private async closeAttachments(): Promise<void> {
    const attachments = this.attachments;
    this.attachments = null;
    await attachments?.close();
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
