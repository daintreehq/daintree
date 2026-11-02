import {
  DecisionsBridge,
  DeliveryEngine,
  parseAnswers,
  serializeAnswers,
  type Identity,
  type InjectionIntent,
  type KeyStore,
  type LocalStore,
  type LocateResult,
  type QuestionOrigin,
  type RelayClient,
  type TerminalSink,
} from "@daintreehq/decisions-client";
import { NOTIFY_SETTLE_GRACE_MS } from "../../../shared/types/terminalNotify.js";
import type { LaneWake, OwnPane } from "../mcp-server/terminalNotify.js";
import {
  DaintreeResume,
  withResumeReasons,
  type SessionResumeDeps,
} from "./daintreeResumeAdapter.js";
import { DaintreeTerminalSink, type DaintreeTerminalSinkDeps } from "./daintreeTerminalSink.js";
import { RetiredAttemptError, retireable } from "./relayTransport.js";

/** A hold on the wake engine's queue (#15999), which takes wakes with the MCP server off. */
export interface DecisionWakeHold {
  queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void;
  /** Ends the wakes still waiting to be typed; a line already submitted settles before `release`. */
  cancelQueued(): void;
  release(): void;
}

/**
 * Something happened to a pane that may let it take an answer now: it settled
 * waiting (`settled`), or its run appeared or came back (`appeared`).
 */
export type PaneSignal = "settled" | "appeared";

/**
 * The terminals that aren't agents' panes: the setup check's diagnostic
 * terminal (#16024). Every pane id it `handles` is delivered through `sink`
 * alone, whether or not one is open, so its answers never reach an agent's
 * pane and no agent's answer reaches it.
 */
export interface DiagnosticTerminals {
  handles(paneId: string): boolean;
  readonly sink: TerminalSink;
}

/** What delivery needs from the rest of main; the lazy entry supplies the real ones. */
export interface AnswerDeliveryDeps extends Omit<DaintreeTerminalSinkDeps, "queueWake" | "now"> {
  /** Takes a hold on the wake engine. Called before the first delivery, and again after a failure. */
  holdWakes(): DecisionWakeHold | Promise<DecisionWakeHold>;
  /** Calls `onPane` on each pane signal; returns the unsubscribe. */
  watchPanes(onPane: (signal: PaneSignal) => void): () => void;
  now?: () => number;
  /** How often to look for answers still waiting; one minute unless a test says otherwise. */
  checkIntervalMs?: number;
  /**
   * Reopens a gone pane's Claude or Codex session to deliver its answer
   * (#16019). Without it, an answer whose run is gone needs a person.
   */
  resume?: SessionResumeDeps;
  diagnostics?: DiagnosticTerminals;
}

/** The store as delivery uses it: the library's, and its indexed read of whether anything waits. */
export type AnswerDeliveryStore = LocalStore & { hasPendingDelivery?(): Promise<boolean> };

export interface AnswerDeliveryOptions {
  deps: AnswerDeliveryDeps;
  identity: Identity;
  store: AnswerDeliveryStore;
  keys: KeyStore;
  /** Reports deliveries to the relay; failures leave them to be reported on a later pass. */
  client: RelayClient;
  /** The keys couldn't be reloaded: the connection stops, and nothing more is written. */
  onKeysUnusable(): void;
}

export const DELIVERY_CHECK_INTERVAL_MS = 60_000;
/** Past the wake's settle grace, so a pane that just settled reads as idle when delivery looks. */
const SETTLED_RECHECK_MS = NOTIFY_SETTLE_GRACE_MS + 250;
/** How long a stop waits for an answer being typed to settle before the store stops taking its result. */
export const DELIVERY_SETTLE_MS = 3_000;

/** Attempts an interrupted injection whose run couldn't be read waits, before recovery takes it as not found. */
export const RECOVERY_RETRIES = 5;

/** The store with only the untyped intents in `include`: what this recovery reconciles. */
function intentsOnly<T extends LocalStore>(store: T, include: ReadonlySet<string>): T {
  return new Proxy(store, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (property === "openIntents") {
        return async (): Promise<InjectionIntent[]> =>
          (await object.openIntents()).filter(
            (intent) => intent.state === "intent" && include.has(intent.injection_id)
          );
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}

/** The run an intent was typed into, as the library's recovery looks for it. */
function typedIntoOf(origin: QuestionOrigin, intent: InjectionIntent): QuestionOrigin {
  return {
    ...origin,
    host_id: intent.host_id,
    pane_id: intent.pane_id,
    terminal_generation: intent.terminal_generation,
    ownership_principal: intent.ownership_principal,
    agent_incarnation: intent.agent_incarnation,
  };
}

/** `agents` for every pane, except the ones `diagnostics` handles. */
function routedSink(
  agents: TerminalSink,
  diagnostics: DiagnosticTerminals | undefined
): TerminalSink {
  if (!diagnostics) return agents;
  const sinkFor = (paneId: string) => (diagnostics.handles(paneId) ? diagnostics.sink : agents);
  return {
    locate: (origin) => sinkFor(origin.pane_id).locate(origin),
    isIdle: (target) => sinkFor(target.paneId).isIdle(target),
    inject: (target, text, injectionId) => sinkFor(target.paneId).inject(target, text, injectionId),
    hasMarker: (target, injectionId) => sinkFor(target.paneId).hasMarker(target, injectionId),
  };
}

function runKey(o: QuestionOrigin): string {
  return JSON.stringify([
    o.host_id,
    o.pane_id,
    o.terminal_generation,
    o.ownership_principal,
    o.agent_incarnation,
    o.agent_session_id,
    o.worktree_id,
  ]);
}

/**
 * Types received Decisions answers into the terminal that asked, for one
 * enabled lifetime with a relay identity (#16017). The store is the
 * authority: an answer waits there, across restarts and a lost connection,
 * until the exact run that asked is at its prompt, and a wake is only how it
 * gets typed.
 *
 * It runs the library's delivery engine over the lifetime's store, apart
 * from the socket's attempts, so an answer already received is typed while
 * the relay is unreachable; only the report to the relay waits for it. The
 * engine lives on a bridge that is never started, which supplies the
 * library's own context: the lock that the socket bridges' inboxes share, so
 * an answer appended while another is marked delivered is never lost.
 *
 * Delivery is tried when the lifetime starts, when a pane settles or its run
 * appears, when an answer arrives, when the socket comes up, and every minute
 * while anything waits (an indexed read, so the minute costs nothing when
 * nothing does). Before the first attempt it reconciles injections a crash
 * interrupted, once the pty host can be asked.
 */
export class AnswerDelivery {
  private readonly o: AnswerDeliveryOptions;
  private readonly store: AnswerDeliveryStore;
  private readonly sink: DaintreeTerminalSink;
  /** The agent sink, with diagnostic terminals routed to their own. */
  private readonly routed: TerminalSink;
  private readonly owner: DecisionsBridge;
  private readonly engine: DeliveryEngine;
  private readonly resume: DaintreeResume | null;
  /** Ends a resume in progress when delivery stops, before it can record anything. */
  private readonly resumeAbort = new AbortController();
  private hold: DecisionWakeHold | null = null;
  private holding: Promise<DecisionWakeHold | null> | null = null;
  private started = false;
  private stopped = false;
  /** No more writes: set once a stop has settled, or at once when the keys failed. */
  private retired = false;
  private recovered = false;
  /** Recoveries that left an unreadable run's injection for later. */
  private recoveryDeferrals = 0;
  private requested = false;
  private running: Promise<void> | null = null;
  private settled: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The latest time a settled pane wants delivery tried; the timer runs until it has passed. */
  private settleDeadline = 0;
  private offPanes: (() => void) | null = null;

  constructor(options: AnswerDeliveryOptions) {
    this.o = options;
    this.store = retireable(options.store, () => this.retired);
    const { deps } = options;
    this.sink = new DaintreeTerminalSink({
      hostId: deps.hostId,
      principalFor: deps.principalFor,
      getPtyClient: deps.getPtyClient,
      queueWake: (pane, projectId, wake) => this.queueWake(pane, projectId, wake),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.resume = deps.resume
      ? new DaintreeResume({
          ...deps.resume,
          hostId: deps.hostId,
          principalFor: deps.principalFor,
          getPtyClient: deps.getPtyClient,
          signal: this.resumeAbort.signal,
        })
      : null;
    this.routed = routedSink(this.sink, deps.diagnostics);
    this.owner = new DecisionsBridge({
      identity: options.identity,
      keyStore: this.keysFor(retireable(options.keys, () => this.retired)),
      store: this.resume ? withResumeReasons(this.store, this.resume) : this.store,
      sink: this.routed,
      client: options.client,
      ...(this.resume ? { adapters: this.resume.adapters } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.engine = this.owner.delivery;
  }

  /** The lock every bridge over this store must use, so answer appends and delivery marks never interleave. */
  get lock(): DecisionsBridge["ctx"]["lock"] {
    return this.owner.ctx.lock;
  }

  /** Starts watching panes and the minute check, and tries delivery now. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.offPanes = this.o.deps.watchPanes((signal) => {
      if (signal === "appeared") this.request();
      else this.requestAfterSettle();
    });
    this.timer = setInterval(
      () => this.request(),
      this.o.deps.checkIntervalMs ?? DELIVERY_CHECK_INTERVAL_MS
    );
    this.timer.unref?.();
    this.request();
  }

  /** Tries delivery as soon as the attempt running now, if any, is done. */
  request(): void {
    if (this.stopped) return;
    this.requested = true;
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
  }

  /**
   * Stops for good. Nothing new is typed from now on: answers queued to type
   * end untyped and are recorded as such. One already submitted settles
   * first, for up to `DELIVERY_SETTLE_MS`, so the host's record of its write
   * is still read and its outcome recorded rather than left for the next
   * start to find. Resolves once the store takes nothing more from this
   * delivery.
   */
  stop(): Promise<void> {
    if (this.settled) return this.settled;
    this.stopped = true;
    this.engine.stopped = true;
    this.resumeAbort.abort();
    this.offPanes?.();
    this.offPanes = null;
    if (this.timer) clearInterval(this.timer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.timer = this.settleTimer = null;
    this.withHold((hold) => hold.cancelQueued());
    const running = this.running;
    this.settled = (async () => {
      if (running) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, DELIVERY_SETTLE_MS);
            timeout.unref?.();
          }),
        ]);
        clearTimeout(timeout);
      }
      this.retired = true;
      const hold = this.hold;
      this.hold = null;
      if (hold) this.withHold(() => hold.release(), hold);
    })();
    return this.settled;
  }

  /**
   * Tries delivery once the pane that just settled is past the settle grace.
   * Each settle wants its own look, so the timer runs on to the latest one,
   * but is never pushed back: panes settling in turn can't starve the first.
   */
  private requestAfterSettle(): void {
    if (this.stopped) return;
    this.settleDeadline = Math.max(this.settleDeadline, this.clock() + SETTLED_RECHECK_MS);
    if (this.settleTimer) return;
    const fire = () => {
      this.settleTimer = null;
      this.request();
      const remaining = this.settleDeadline - this.clock();
      if (remaining > 0 && !this.stopped) this.armSettle(fire, remaining);
    };
    this.armSettle(fire, SETTLED_RECHECK_MS);
  }

  private armSettle(fire: () => void, delay: number): void {
    this.settleTimer = setTimeout(fire, delay);
    this.settleTimer.unref?.();
  }

  private clock(): number {
    return this.o.deps.now?.() ?? Date.now();
  }

  private async run(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      try {
        await this.attempt();
      } catch (error) {
        // The store refusing a retired delivery is the stop doing its job.
        if (error instanceof RetiredAttemptError || this.stopped) return;
        console.warn(
          "[Decisions] Delivering answers failed:",
          error instanceof Error ? error.name : typeof error
        );
      }
    }
  }

  private async attempt(): Promise<void> {
    if ((await this.ensureHold()) === null || this.stopped) return;
    if (!this.recovered) {
      // Until the pty host can be asked, every run would read as gone and
      // every interrupted injection as uncertain; the next request tries again.
      if (this.o.deps.getPtyClient() === null) return;
      this.recovered = await this.recover();
      // Questions with an injection still unreconciled wait; the rest go on.
    }
    if (this.stopped) return;
    if (this.store.hasPendingDelivery && !(await this.store.hasPendingDelivery())) return;
    try {
      await this.engine.drain();
    } finally {
      this.resume?.endPass();
    }
  }

  /**
   * Reconciles injections a crash interrupted, once per lifetime; false when
   * it has to try again. An intent still in state `intent` may or may not
   * have been typed: the library looks for its marker in the run's
   * scrollback, and anything it can't find is `delivery-uncertain`, never
   * typed again. A `typed` intent was recorded only on the host's proof of
   * the write and needs no search; only its report is outstanding, which the
   * first pass sends. The library would search for it too, and call an
   * answer whose pane has closed since uncertain, so recovery sees only the
   * untyped ones.
   */
  private async recover(): Promise<boolean> {
    await this.repairRecorded();
    if (this.stopped) return false;
    const probe = await this.probeInterrupted();
    if (this.stopped) return false;
    const ctx = { ...this.owner.ctx, store: intentsOnly(this.store, probe.include) };
    await new DeliveryEngine(ctx, { sink: probe.sink }).recover();
    return probe.complete;
  }

  /**
   * Reads each interrupted injection's run once, and hands the library a sink
   * that answers with exactly what was read, so a second read that fails
   * can't turn into "not found". A run on this host that couldn't be read
   * (the host slow to answer, its screen unreadable, the run changing under
   * the read) proves nothing either way: that injection is left for a later
   * attempt, up to `RECOVERY_RETRIES` of them, and then taken as not found.
   * A run that isn't there, or is no longer the one typed into, is read as
   * it is: never found.
   */
  private async probeInterrupted(): Promise<{
    include: Set<string>;
    complete: boolean;
    sink: TerminalSink;
  }> {
    const giveUp = this.recoveryDeferrals >= RECOVERY_RETRIES;
    const hostId = this.o.deps.hostId();
    const include = new Set<string>();
    const located = new Map<string, LocateResult>();
    const markers = new Map<string, boolean>();
    let complete = true;
    for (const intent of await this.store.openIntents()) {
      if (intent.state !== "intent") continue;
      if (this.stopped) {
        complete = false;
        break;
      }
      const row = await this.store.getQuestion(intent.question_id);
      if (!row) {
        // The library abandons an intent with no question behind it.
        include.add(intent.injection_id);
        continue;
      }
      const typedInto = typedIntoOf(row.origin, intent);
      const key = runKey(typedInto);
      const where = located.get(key) ?? (await this.routed.locate(typedInto));
      if (where.state === "host-offline" && intent.host_id === hostId && !giveUp) {
        complete = false;
        continue;
      }
      located.set(key, where);
      if (where.state === "alive" && where.target) {
        const found = this.o.deps.diagnostics?.handles(where.target.paneId)
          ? await this.routed.hasMarker(where.target, intent.injection_id)
          : await this.sink.readMarker(where.target, intent.injection_id);
        if (found === null && !giveUp) {
          complete = false;
          continue;
        }
        markers.set(intent.injection_id, found === true);
      }
      include.add(intent.injection_id);
    }
    if (!complete) this.recoveryDeferrals += 1;
    const sink: TerminalSink = {
      locate: async (origin) => located.get(runKey(origin)) ?? { state: "gone" },
      isIdle: async () => false,
      inject: async () => ({ outcome: "held", reason: "recovery" }),
      hasMarker: async (_target, injectionId) => markers.get(injectionId) === true,
    };
    return { include, complete, sink };
  }

  /**
   * Puts right what an interruption between two of the library's writes
   * left, from what was recorded. The library records an intent as typed
   * before it marks the answer delivered, so a crash between the two leaves
   * an answer that would be typed a second time; the typed record is the
   * proof it already was. Its crash recovery does the reverse when it finds a
   * marker, so an interruption there leaves an intent still untyped on an
   * answer already marked delivered under it, which the next recovery would
   * search for again and could call uncertain; that answer's own record says
   * it was typed.
   */
  private async repairRecorded(): Promise<void> {
    const { ctx } = this.owner;
    for (const intent of await this.store.openIntents()) {
      if (this.stopped) return;
      if (intent.state === "intent") {
        const row = await this.store.getQuestion(intent.question_id);
        const recorded = row
          ? parseAnswers(row.answers_json).some(
              (entry) =>
                entry.revision === intent.answer_revision &&
                entry.delivered &&
                entry.injection_id === intent.injection_id
            )
          : false;
        if (recorded) {
          await this.store.updateIntent(intent.injection_id, {
            state: "typed",
            updated_at: ctx.now(),
          });
        }
        continue;
      }
      if (intent.state !== "typed") continue;
      await ctx.lock.run(async () => {
        const row = await this.store.getQuestion(intent.question_id);
        if (!row) return;
        const entries = parseAnswers(row.answers_json);
        const at = entries.findIndex(
          (entry) => entry.revision === intent.answer_revision && entry.deliver && !entry.delivered
        );
        if (at < 0) return;
        entries[at] = { ...entries[at], delivered: true, injection_id: intent.injection_id };
        const stillPending = entries.some((entry) => entry.deliver && !entry.delivered);
        await this.store.updateQuestion(row.question_id, {
          answers_json: serializeAnswers(entries),
          delivered_revision: Math.max(row.delivered_revision, intent.answer_revision),
          delivery_status: stillPending ? row.delivery_status : "terminal-delivered",
          last_injection_id: intent.injection_id,
          error_code: null,
        });
        await ctx.audit.log({
          event: "answer.delivered",
          question_id: row.question_id,
          requirement: row.requirement,
          result: "typed-record",
        });
      });
    }
  }

  private ensureHold(): Promise<DecisionWakeHold | null> {
    if (this.hold) return Promise.resolve(this.hold);
    if (this.holding) return this.holding;
    const holding = (async () => {
      try {
        const hold = await this.o.deps.holdWakes();
        if (this.stopped) {
          hold.release();
          return null;
        }
        this.hold = hold;
        return hold;
      } catch (error) {
        console.warn(
          "[Decisions] Couldn't hold the terminal wake engine:",
          error instanceof Error ? error.name : typeof error
        );
        return null;
      }
    })();
    // Cleared once settled, whether it failed at once or later, so the next attempt asks again.
    this.holding = holding;
    void holding.finally(() => {
      if (this.holding === holding) this.holding = null;
    });
    return holding;
  }

  private queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void {
    const hold = this.hold;
    if (hold === null || this.stopped) {
      // Never typed: the sink reads the pane again and holds the answer for later.
      wake.report({ kind: "unavailable", reason: "stopped" });
      return;
    }
    hold.queueWake(pane, projectId, wake);
  }

  private withHold(act: (hold: DecisionWakeHold) => void, hold = this.hold): void {
    if (!hold) return;
    try {
      act(hold);
    } catch (error) {
      console.warn(
        "[Decisions] The terminal wake hold failed:",
        error instanceof Error ? error.name : typeof error
      );
    }
  }

  /**
   * The keys as the engine reloads them after a key rotation. A reload that
   * fails would leave an answer unopenable, and the library would send it to
   * needs-attention; a keychain that was only locked must not cost an answer
   * that, so a failure stops all writing first and stops the connection.
   */
  private keysFor(keys: KeyStore): KeyStore {
    const unusable = () => {
      if (this.retired) return;
      this.retired = true;
      this.resumeAbort.abort();
      this.o.onKeysUnusable();
    };
    return {
      load: () =>
        keys.load().then(
          (stored) => {
            if (stored === null || stored.claimed === false) unusable();
            return stored;
          },
          (error: unknown) => {
            if (!(error instanceof RetiredAttemptError)) unusable();
            throw error;
          }
        ),
      // A Host saves the grants it fetched (#16022), and a failed save costs an answer the same way.
      save: (identity) =>
        keys.save(identity).catch((error: unknown) => {
          if (!(error instanceof RetiredAttemptError)) unusable();
          throw error;
        }),
      clear: () => keys.clear(),
    };
  }
}
