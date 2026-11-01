import {
  BridgeError,
  DecisionsBridge,
  paneIdentityOf,
  type DecisionView,
  type PaneIdentity,
  type QuestionOrigin,
  type RegisterResult,
} from "@daintreehq/decisions-client";
import type { QuestionSource } from "./relayConnection.js";
import { holdingTerminalSink } from "./relayTransport.js";

export interface QuestionBridgeOptions {
  source: QuestionSource;
  /**
   * Whether `pane` is still exactly the run its request was let in as. Asked
   * again at each call: the handler authenticates before it reads the body,
   * and a pane revoked or relaunched since then must not ask, read or cancel.
   */
  isCurrent(pane: PaneIdentity): boolean;
}

/**
 * The bridge the MCP handler is given (#16011). Relay attempts each get a
 * bridge of their own and there is none between them, but a question must be
 * askable then too: it is committed locally and published once an attempt is
 * live. So each call goes to the live attempt's bridge when there is one, and
 * otherwise to this bridge itself, which is stopped before it is used and so
 * never pumps, publishes, receives or delivers: it only writes to and reads
 * from the lifetime's store, under the identity the attempts last held.
 *
 * Asks run one at a time. The library counts a pane's open questions and
 * then commits in separate steps, so two asks at once could both pass the
 * limit.
 */
export class QuestionBridge extends DecisionsBridge {
  private readonly question: QuestionBridgeOptions;
  private asks: Promise<unknown> = Promise.resolve();

  constructor(options: QuestionBridgeOptions) {
    const identity = options.source.identity();
    if (identity === null) throw new Error("The relay connection has ended");
    super({
      identity,
      store: options.source.store,
      policy: options.source.policy,
      sink: holdingTerminalSink,
      pumpIntervalMs: 0,
    });
    this.question = options;
    // Synchronous for a bridge that never started; from here `pump` does nothing.
    void super.stop();
  }

  override registerQuestion(args: {
    origin: QuestionOrigin;
    input: unknown;
  }): Promise<RegisterResult> {
    const run = this.asks.then(() => {
      const live = this.admit(paneIdentityOf(args.origin));
      return live ? live.registerQuestion(args) : super.registerQuestion(args);
    });
    this.asks = run.catch(() => {});
    return run;
  }

  override async getDecision(questionId: string, pane?: PaneIdentity): Promise<DecisionView> {
    const live = this.admit(pane);
    const asker = await this.askerOf(questionId, pane!);
    return live ? live.getDecision(questionId, asker) : super.getDecision(questionId, asker);
  }

  override async cancelQuestion(questionId: string, pane?: PaneIdentity): Promise<void> {
    const live = this.admit(pane);
    const asker = await this.askerOf(questionId, pane!);
    if (live === null) return super.cancelQuestion(questionId, asker);
    // The library checks the question is this pane's before anything is touched.
    await live.getDecision(questionId, asker);
    await this.keepCreate(questionId);
    return live.cancelQuestion(questionId, asker);
  }

  override async listPending(pane?: PaneIdentity): Promise<DecisionView[]> {
    const live = this.admit(pane);
    return live ? live.listPending(pane) : super.listPending(pane);
  }

  /**
   * `pane` as the question's asker is matched. The library compares the agent
   * session exactly, but a session learned since the question was asked is
   * that same run's (as delivery takes it, `decisionWake.ts`), so a question
   * asked with none is matched with none.
   */
  private async askerOf(questionId: string, pane: PaneIdentity): Promise<PaneIdentity> {
    if (pane.agent_session_id === null) return pane;
    const row = await this.question.source.store.getQuestion(questionId);
    return row?.origin.agent_session_id === null ? { ...pane, agent_session_id: null } : pane;
  }

  /**
   * A live attempt's flush may already hold this question's create in hand,
   * and would send it even after the library's cancel drops it as never
   * published, bringing the question back. So a cancel while an attempt runs
   * keeps the create, marked as possibly published, and the library queues a
   * real cancel to follow it. Attachment uploads (#16014) rewrite the create
   * from the flush's own copy, so they will need this mark kept across them.
   */
  private async keepCreate(questionId: string): Promise<void> {
    const store = this.question.source.store;
    const create = (await store.outboxFor(questionId)).find((item) => item.kind === "create");
    const payload = create?.payload;
    if (create === undefined || typeof payload !== "object" || payload === null) return;
    if ((payload as { maybePublished?: unknown }).maybePublished === true) return;
    await store.putOutbox({ ...create, payload: { ...payload, maybePublished: true } });
  }

  /**
   * Throws unless `pane` may still use Decisions; returns the live attempt's
   * bridge to run the call on, or null to run it here, on the current identity.
   */
  private admit(pane: PaneIdentity | undefined): DecisionsBridge | null {
    // Without a pane the library would skip its ownership check.
    if (pane === undefined) throw new BridgeError("not_found", "unknown question");
    if (!this.question.isCurrent(pane)) {
      throw new BridgeError("forbidden", "this terminal's Decisions access has ended");
    }
    const identity = this.question.source.identity();
    if (identity === null) {
      throw new BridgeError("forbidden", "Decisions isn't connected to its relay");
    }
    const live = this.question.source.live();
    if (live === null) this.ctx.identity = identity;
    return live;
  }
}
