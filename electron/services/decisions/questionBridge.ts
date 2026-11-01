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
    super({ identity, store: options.source.store, sink: holdingTerminalSink, pumpIntervalMs: 0 });
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
    return live ? live.getDecision(questionId, pane) : super.getDecision(questionId, pane);
  }

  override async cancelQuestion(questionId: string, pane?: PaneIdentity): Promise<void> {
    const live = this.admit(pane);
    return live ? live.cancelQuestion(questionId, pane) : super.cancelQuestion(questionId, pane);
  }

  override async listPending(pane?: PaneIdentity): Promise<DecisionView[]> {
    const live = this.admit(pane);
    return live ? live.listPending(pane) : super.listPending(pane);
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
