import { randomUUID } from "node:crypto";
import {
  BridgeError,
  openQuestionContent,
  paneIdentityOf,
  parseAnswers,
  RelayClient,
  verifiedDevices,
  type Identity,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import { decryptAttachment } from "@daintreehq/decisions-crypto";
import {
  DECISIONS_SETUP_CHECK_STEPS,
  type DecisionsConnectionProblem,
  type DecisionsSetupCheckObservations,
  type DecisionsSetupCheckRun,
  type DecisionsSetupCheckStep,
  type DecisionsSetupCheckSteps,
  type DecisionsSetupSocketObservation,
  type DecisionsState,
  type DecisionsRelayCheck,
  type DecisionsRelayRequestFailure,
} from "../../../shared/types/decisions.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";
import { signedRequestFailure } from "./pairing.js";
import { QuestionBridge } from "./questionBridge.js";
import type { RelayFetch } from "./relayCheck.js";
import type { QuestionSource } from "./relayConnection.js";
import { relayRecognises, relayRequests, type RelayRequests } from "./relayIdentity.js";
import {
  SETUP_CHECK_IMAGE,
  SETUP_CHECK_IMAGE_ID,
  type SetupDiagnosticTerminal,
  type SetupDiagnostics,
} from "./setupDiagnostic.js";

/** The identity a setup check runs against, as the setting records it. */
export interface SetupCheckRelay {
  relayOrigin: string;
  installationId: string;
  deviceId: string;
  hostId: string;
}

/** The service state a fresh socket is read from. */
export interface SetupCheckStatus {
  state: DecisionsState;
  problem?: DecisionsConnectionProblem;
}

export interface SetupCheckTimeouts {
  /** For a fresh attempt's first frame; past the connection's own 45 s. */
  socketMs: number;
  /** For the relay to take the test question and its image. */
  publishMs: number;
  /** For a person to answer on a phone, and the answer to be typed. */
  answerMs: number;
  /** How long the relay holds the test question if nothing cancels it. */
  expiryMs: number;
  /** How often rows are read again between commits. */
  pollMs: number;
}

export const SETUP_CHECK_TIMEOUTS: SetupCheckTimeouts = {
  socketMs: 60_000,
  publishMs: 60_000,
  answerMs: 5 * 60_000,
  expiryMs: 10 * 60_000,
  pollMs: 2_000,
};

export interface SetupCheckDeps {
  relay: SetupCheckRelay;
  /** The relay's unsigned reads (#16005). */
  checkRelay(origin: string, signal: AbortSignal): Promise<DecisionsRelayCheck>;
  /** What the running connection takes questions through; null while none can. */
  questionSource(): QuestionSource | null;
  /** Starts the running connection's fresh attempt; false when it can't. */
  refreshConnection(): boolean;
  status(): SetupCheckStatus;
  /** Calls `listener` on every change of the service's state; returns the unsubscribe. */
  onStatus(listener: (status: SetupCheckStatus) => void): () => void;
  /** Calls `listener` after each write the lifetime's store commits; returns the unsubscribe. */
  onCommit(listener: () => void): () => void;
  diagnostics: SetupDiagnostics;
  /** Rises with every change, across runs. */
  nextRevision(): number;
  fetchImpl?: RelayFetch;
  now?: () => number;
  timeouts?: Partial<SetupCheckTimeouts>;
}

type StepOutcome<S extends DecisionsSetupCheckStep> = {
  passed: boolean;
  observation: DecisionsSetupCheckObservations[S];
};

/** The run was called off; it observed nothing more. */
class SetupCheckCancelled extends Error {
  constructor() {
    super("The setup check was cancelled");
    this.name = "SetupCheckCancelled";
  }
}

interface Signed {
  origin: string;
  identity: Identity;
  client: RelayClient;
  requests: RelayRequests;
}

function waitingSteps(): DecisionsSetupCheckSteps {
  return {
    relay: { state: "waiting" },
    claim: { state: "waiting" },
    socket: { state: "waiting" },
    push: { state: "waiting" },
    attachment: { state: "waiting" },
    question: { state: "waiting" },
  };
}

/** What a fresh attempt's state says about its socket; null while it is still connecting. */
function socketObservation(status: SetupCheckStatus): DecisionsSetupSocketObservation | null {
  switch (status.state) {
    case "connecting":
      return null;
    case "connected":
      return { result: "connected" };
    case "reconnecting":
      return { result: "no-hello" };
    case "replaced":
      return { result: "replaced" };
    case "revoked":
      return { result: "revoked" };
    default:
      return status.problem !== undefined
        ? { result: "not-connected", problem: status.problem }
        : { result: "not-connected" };
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Still waiting on the relay or the phone: what the run cancels when it ends without an answer. */
function unsettled(row: QuestionRow | null): boolean {
  return row === null || row.local_status === "queued" || row.local_status === "open";
}

/**
 * One setup check (#16024): the whole Decisions loop, run against the
 * identity set up here, through the same code an agent's question goes
 * through. Steps run in order and the first that fails ends the run, naming
 * itself; the rest are skipped. Each reports one fixed observation, never an
 * error's text.
 *
 * The test question is asked from a diagnostic terminal that runs no agent,
 * carries a generated image, and is `human-required`. Its answer is typed by
 * delivery like any other, into that terminal. Whatever ends the run, a
 * question still unanswered is cancelled and the terminal closes.
 */
export class SetupCheck {
  readonly runId = randomUUID();
  private running: Promise<DecisionsSetupCheckRun> | null = null;
  private readonly deps: SetupCheckDeps;
  private readonly timeouts: SetupCheckTimeouts;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private readonly startedAt: number;
  private steps = waitingSteps();
  private state: DecisionsSetupCheckRun["state"] = "running";
  private finishedAt: number | undefined;
  private revision: number;
  private terminal: SetupDiagnosticTerminal | null = null;
  /** Wakes whatever is waiting on rows or the terminal to look again. */
  private readonly wakers = new Set<() => void>();

  constructor(
    deps: SetupCheckDeps,
    private readonly onChange: (run: DecisionsSetupCheckRun) => void
  ) {
    this.deps = deps;
    this.timeouts = { ...SETUP_CHECK_TIMEOUTS, ...deps.timeouts };
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.revision = deps.nextRevision();
  }

  /** Runs it, once; resolves with how it ended. */
  start(): Promise<DecisionsSetupCheckRun> {
    this.running ??= this.run();
    return this.running;
  }

  snapshot(): DecisionsSetupCheckRun {
    return {
      runId: this.runId,
      revision: this.revision,
      state: this.state,
      startedAt: this.startedAt,
      ...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
      steps: structuredClone(this.steps),
      diagnostic: this.terminal?.view() ?? null,
    };
  }

  /** The step that failed, once the run has; null while running, passed or cancelled. */
  failedStep(): DecisionsSetupCheckStep | null {
    return DECISIONS_SETUP_CHECK_STEPS.find((step) => this.steps[step].state === "failed") ?? null;
  }

  /** Calls the run off; resolves once its question is cancelled and its terminal closed. */
  cancel(): Promise<DecisionsSetupCheckRun> {
    this.controller.abort();
    for (const wake of [...this.wakers]) wake();
    return this.start();
  }

  private changed(): void {
    this.revision = this.deps.nextRevision();
    this.onChange(this.snapshot());
  }

  private set<S extends DecisionsSetupCheckStep>(
    step: S,
    state: DecisionsSetupCheckSteps[S]
  ): void {
    this.steps = { ...this.steps, [step]: state };
    this.changed();
  }

  private throwIfCancelled(): void {
    if (this.controller.signal.aborted) throw new SetupCheckCancelled();
  }

  private async run(): Promise<DecisionsSetupCheckRun> {
    try {
      await this.runSteps();
      this.state = this.failedStep() === null ? "passed" : "failed";
    } catch (error) {
      if (!(error instanceof SetupCheckCancelled)) throw error;
      this.state = "cancelled";
    }
    // Whatever didn't finish was skipped: an earlier step failed, or the run was called off.
    for (const step of DECISIONS_SETUP_CHECK_STEPS) {
      const { state } = this.steps[step];
      if (state === "waiting" || state === "running") {
        this.steps = { ...this.steps, [step]: { state: "skipped" } };
      }
    }
    this.finishedAt = this.now();
    this.changed();
    return this.snapshot();
  }

  /**
   * Runs `body` as `step`, recording what it observed. An error nobody
   * foresaw fails the step as `unexpected`, logging its kind alone.
   */
  private async step<S extends DecisionsSetupCheckStep>(
    step: S,
    body: () => Promise<StepOutcome<S>>
  ): Promise<boolean> {
    this.throwIfCancelled();
    this.set(step, { state: "running" } as DecisionsSetupCheckSteps[S]);
    let outcome: StepOutcome<S>;
    try {
      outcome = await body();
    } catch (error) {
      if (error instanceof SetupCheckCancelled || this.controller.signal.aborted) {
        throw new SetupCheckCancelled();
      }
      console.warn(
        `[Decisions] The setup check's ${step} step failed:`,
        error instanceof Error ? error.name : typeof error
      );
      const unexpected = { result: "unexpected" } as DecisionsSetupCheckObservations[S];
      outcome = { passed: false, observation: unexpected };
    }
    this.throwIfCancelled();
    this.set(step, {
      state: outcome.passed ? "passed" : "failed",
      observation: outcome.observation,
    } as DecisionsSetupCheckSteps[S]);
    return outcome.passed;
  }

  private async runSteps(): Promise<void> {
    const { relay } = this.deps;
    const signal = this.controller.signal;

    const relayChecked = await this.step("relay", async () => {
      const check = await this.deps.checkRelay(relay.relayOrigin, signal);
      return { passed: check.result === "claimed", observation: check };
    });
    if (!relayChecked) return;

    const opened: { session: Signed | null } = { session: null };
    const claimed = await this.step("claim", async (): Promise<StepOutcome<"claim">> => {
      const session = await this.openSigned();
      if (session === null) return { passed: false, observation: { result: "not-set-up" } };
      opened.session = session;
      return this.signedStep(session, async (): Promise<StepOutcome<"claim">> => {
        const recognised = relayRecognises(await session.client.devices(), session.identity);
        return {
          passed: recognised,
          observation: { result: recognised ? "recognised" : "not-recognised" },
        };
      });
    });
    const session = opened.session;
    if (!claimed || session === null) return;

    const connected = await this.step("socket", async () => {
      const observation = await this.freshSocket();
      return { passed: observation.result === "connected", observation };
    });
    if (!connected) return;

    const pushReady = await this.step("push", () =>
      this.signedStep(session, async (): Promise<StepOutcome<"push">> => {
        const config = await session.client.pushConfig();
        const listed = await verifiedDevices(session.client);
        const phones = listed.filter(
          (device) =>
            device.device_id !== relay.deviceId &&
            device.revoked_at === null &&
            (device.cert.role === "phone" || device.cert.role === "tablet")
        );
        const pushEnabled = phones.filter((device) => device.push_enabled).length;
        if (typeof config.vapid_public_key !== "string" || config.vapid_public_key.trim() === "") {
          return { passed: false, observation: { result: "no-push-key" } };
        }
        if (phones.length === 0) return { passed: false, observation: { result: "no-phone" } };
        if (pushEnabled === 0) {
          return { passed: false, observation: { result: "push-off", phones: phones.length } };
        }
        return {
          passed: true,
          observation: { result: "configured", phones: phones.length, pushEnabled },
        };
      })
    );
    if (!pushReady) return;

    await this.askTestQuestion(session);
  }

  /**
   * A signed client on the identity the running connection loaded, if it is
   * the one recorded; null otherwise.
   */
  private async openSigned(): Promise<Signed | null> {
    const identity = this.deps.questionSource()?.identity() ?? null;
    const { relay } = this.deps;
    if (
      identity === null ||
      identity.role !== "owner-desktop" ||
      normalizeRelayOrigin(identity.config.relayOrigin) !== relay.relayOrigin ||
      identity.config.installationId !== relay.installationId ||
      identity.config.deviceId !== relay.deviceId
    ) {
      return null;
    }
    const requests = await relayRequests(relay.relayOrigin, {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      signal: this.controller.signal,
    });
    return {
      origin: relay.relayOrigin,
      identity,
      requests,
      client: new RelayClient({ identity, fetch: requests.fetch, maxRetries: 0 }),
    };
  }

  /** `body`'s outcome, with a signed request's failure as the step's observation. */
  private async signedStep<T>(
    session: Signed,
    body: () => Promise<T>
  ): Promise<T | { passed: false; observation: DecisionsRelayRequestFailure }> {
    try {
      return await body();
    } catch (error) {
      this.throwIfCancelled();
      const failure = signedRequestFailure(error, session.origin, session.requests);
      if (failure === null) throw error;
      return { passed: false, observation: failure };
    }
  }

  /**
   * Starts the running connection's fresh attempt, which asks for a new
   * ticket, and waits for what it does: the relay's first frame on its
   * socket, a close, or nothing in time.
   */
  private freshSocket(): Promise<DecisionsSetupSocketObservation> {
    const signal = this.controller.signal;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let off: () => void = () => {};
      let finished = false;
      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        off();
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(new SetupCheckCancelled()));
      const unsubscribe = this.deps.onStatus((status) => {
        const observation = socketObservation(status);
        if (observation) finish(() => resolve(observation));
      });
      off = unsubscribe;
      signal.addEventListener("abort", onAbort);
      if (!this.deps.refreshConnection()) {
        const status = this.deps.status();
        // A connection that couldn't refresh isn't one to report as connected.
        const observation =
          status.state === "replaced" || status.state === "revoked"
            ? socketObservation(status)!
            : socketObservation({ ...status, state: "not-connected" })!;
        finish(() => resolve(observation));
        return;
      }
      // The attempt may already have ended as it started.
      if (finished) return;
      timer = setTimeout(
        () => finish(() => resolve({ result: "no-hello" })),
        this.timeouts.socketMs
      );
      timer.unref?.();
    });
  }

  /**
   * The test question, from a diagnostic terminal: its image's round trip,
   * then its answer, typed into that terminal. Whatever ends it, an
   * unanswered question is cancelled and the terminal closes.
   */
  private async askTestQuestion(session: Signed): Promise<void> {
    const source = this.deps.questionSource();
    const { diagnostics, relay } = this.deps;
    this.throwIfCancelled();
    const terminal = diagnostics.open(relay.hostId, () => {
      this.wake();
      this.changed();
    });
    this.terminal = terminal;
    const asked: { bridge: QuestionBridge | null; questionId: string | null } = {
      bridge: null,
      questionId: null,
    };
    try {
      const published = await this.step(
        "attachment",
        async (): Promise<StepOutcome<"attachment">> => {
          if (source === null) return { passed: false, observation: { result: "not-asked" } };
          const bridge = new QuestionBridge({
            source,
            isCurrent: (pane) => diagnostics.isCurrent(pane),
          });
          asked.bridge = bridge;
          let questionId: string;
          try {
            questionId = (
              await bridge.registerQuestion({ origin: terminal.origin, input: this.testQuestion() })
            ).questionId;
          } catch (error) {
            if (error instanceof BridgeError) {
              return { passed: false, observation: { result: "not-asked" } };
            }
            throw error;
          }
          asked.questionId = questionId;
          terminal.expect(questionId);
          this.throwIfCancelled();
          return this.roundTrip(session, source, questionId);
        }
      );
      const questionId = asked.questionId;
      if (!published || questionId === null || source === null) return;
      await this.step("question", () => this.awaitAnswer(terminal, source, questionId));
    } finally {
      await this.cancelUnanswered(asked.bridge, asked.questionId, terminal, source);
      diagnostics.close(terminal);
      this.terminal = null;
    }
  }

  private testQuestion(): Record<string, unknown> {
    return {
      question: "Daintree setup check: did this question reach you?",
      context:
        "Daintree sent this to check that questions reach your phone and answers come back. Answer it to finish the check. Your answer is typed into a diagnostic terminal that runs no agent, and nothing else happens.",
      kind: "choice",
      options: [{ id: "received", label: "Received" }],
      attachments: [
        { local_resource_id: SETUP_CHECK_IMAGE_ID, role: "other", alt: "Setup check test image" },
      ],
      requested_requirement: "human-required",
      expires_at: new Date(this.now() + this.timeouts.expiryMs).toISOString(),
      correlation_id: this.runId,
    };
  }

  /** Once the relay has the question, its image downloaded and decrypted, compared byte for byte. */
  private async roundTrip(
    session: Signed,
    source: QuestionSource,
    questionId: string
  ): Promise<StepOutcome<"attachment">> {
    const row = await this.waitForRow(
      source,
      questionId,
      (current) => (current.local_status === "queued" ? undefined : current),
      this.timeouts.publishMs
    );
    if (row === null) return { passed: false, observation: { result: "not-published" } };
    if (row.local_status === "publish-failed") {
      return { passed: false, observation: { result: "publish-failed" } };
    }
    const identity = source.identity() ?? session.identity;
    const content = await openQuestionContent({ identity }, row);
    const descriptor = content?.attachments[0];
    if (!descriptor) return { passed: false, observation: { result: "mismatch" } };
    return this.signedStep(session, async (): Promise<StepOutcome<"attachment">> => {
      const ciphertext = await session.client.downloadAttachment(descriptor.attachment_id);
      const epochKey = identity.epochs.get(descriptor.key_epoch);
      if (!epochKey) return { passed: false, observation: { result: "mismatch" } };
      let plaintext: Uint8Array;
      try {
        plaintext = await decryptAttachment(
          epochKey,
          {
            installationId: identity.config.installationId,
            questionId,
            attachmentId: descriptor.attachment_id,
            keyEpoch: descriptor.key_epoch,
          },
          descriptor.nonce,
          ciphertext,
          descriptor.sha256
        );
      } catch {
        return { passed: false, observation: { result: "mismatch" } };
      }
      return sameBytes(plaintext, SETUP_CHECK_IMAGE)
        ? { passed: true, observation: { result: "matched", bytes: plaintext.length } }
        : { passed: false, observation: { result: "mismatch" } };
    });
  }

  /**
   * A person's answer from a phone, typed into the diagnostic terminal and
   * recorded as delivered. Read from what delivery did, not the row's
   * `local_status`: a create receipt that lands after the answer sets that
   * back to `open`.
   */
  private async awaitAnswer(
    terminal: SetupDiagnosticTerminal,
    source: QuestionSource,
    questionId: string
  ): Promise<StepOutcome<"question">> {
    let last: QuestionRow | null = null;
    const settled = await this.waitForRow(
      source,
      questionId,
      (row): StepOutcome<"question"> | undefined => {
        last = row;
        const typed = terminal.answerTypedFor(questionId);
        if (typed !== undefined && row.delivery_status === "terminal-delivered") {
          return { passed: true, observation: { result: "typed", text: typed.text } };
        }
        if (row.local_status === "expired")
          return { passed: false, observation: { result: "expired" } };
        if (row.local_status === "cancelled") {
          return { passed: false, observation: { result: "cancelled" } };
        }
        if (
          row.delivery_status === "needs-attention" ||
          row.delivery_status === "delivery-uncertain"
        ) {
          return { passed: false, observation: { result: "not-typed" } };
        }
        return undefined;
      },
      this.timeouts.answerMs
    );
    if (settled !== null) return settled;
    const row = last as QuestionRow | null;
    const answered =
      row !== null && parseAnswers(row.answers_json).some((entry) => entry.source === "human");
    return { passed: false, observation: { result: answered ? "not-typed" : "not-answered" } };
  }

  /**
   * Reads the question's row after every commit, and every `pollMs` between,
   * until `pick` takes it; null once `timeoutMs` passes first.
   */
  private waitForRow<T>(
    source: QuestionSource,
    questionId: string,
    pick: (row: QuestionRow) => T | undefined,
    timeoutMs: number
  ): Promise<T | null> {
    const signal = this.controller.signal;
    return new Promise<T | null>((resolve, reject) => {
      let finished = false;
      let reading = false;
      let again = false;
      const offCommit = this.deps.onCommit(() => look());
      const poll = setInterval(() => look(), this.timeouts.pollMs);
      poll.unref?.();
      const deadline = setTimeout(() => finish(() => resolve(null)), timeoutMs);
      deadline.unref?.();
      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        offCommit();
        clearInterval(poll);
        clearTimeout(deadline);
        this.wakers.delete(look);
        settle();
      };
      const look = (): void => {
        if (finished) return;
        if (signal.aborted) {
          finish(() => reject(new SetupCheckCancelled()));
          return;
        }
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        void (async () => {
          try {
            const row = await source.store.getQuestion(questionId);
            const picked = row ? pick(row) : undefined;
            if (picked !== undefined) finish(() => resolve(picked));
          } catch {
            // A read the store refused (the connection ending) is tried again, or times out.
          } finally {
            reading = false;
            if (again && !finished) {
              again = false;
              look();
            }
          }
        })();
      };
      this.wakers.add(look);
      look();
    });
  }

  private wake(): void {
    for (const wake of [...this.wakers]) wake();
  }

  /**
   * Cancels the test question if it is still waiting on the relay or the
   * phone, through the same path an agent's cancel takes, while the
   * terminal it was asked from is still open. Best effort: the question
   * expires on the relay by itself.
   */
  private async cancelUnanswered(
    bridge: QuestionBridge | null,
    questionId: string | null,
    terminal: SetupDiagnosticTerminal,
    source: QuestionSource | null
  ): Promise<void> {
    if (bridge === null || questionId === null || source === null) return;
    try {
      if (!unsettled(await source.store.getQuestion(questionId))) return;
      await bridge.cancelQuestion(questionId, paneIdentityOf(terminal.origin));
    } catch {
      // The connection ended or the store closed: the question expires by itself.
    }
  }
}
