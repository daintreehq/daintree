import {
  sameTarget,
  targetOf,
  type InjectResult,
  type LocateResult,
  type LocateState,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
  type UnavailableReason,
} from "@daintreehq/decisions-client";
import { NOTIFY_SETTLE_GRACE_MS } from "../../../shared/types/terminalNotify.js";
import { tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { EXACT_PROMPT_GATE, evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";
import {
  paneNotifyKey,
  type LaneWake,
  type LaneWakeEvidence,
  type LaneWakeOutcome,
  type NotifyTerminalInfo,
  type OwnPane,
} from "../mcp-server/terminalNotify.js";
import {
  answerKey,
  decisionWakeId,
  parseAnswerNotice,
  renderDecisionSection,
} from "./answerNotice.js";
import {
  createDecisionWake,
  identityMismatch,
  type DecisionGenerationReader,
  type DecisionIdentitySources,
} from "./decisionWake.js";

/** The pty client calls the sink makes. */
export interface DecisionSinkPtyClient extends DecisionGenerationReader {
  getTerminalAsync(
    id: string,
    submissionToken?: string,
    options?: { strict?: boolean }
  ): Promise<NotifyTerminalInfo | null>;
  getSerializedStateAsync?(
    id: string,
    options?: { tailRows: number }
  ): Promise<{ data: string; partial?: true } | null>;
}

export interface DaintreeTerminalSinkDeps extends DecisionIdentitySources {
  getPtyClient(): DecisionSinkPtyClient | null;
  /** The listener hold's wake queue (#15999), which takes wakes with the MCP server off. */
  queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void;
  now?: () => number;
}

type Observed =
  | { state: "alive"; target: TerminalTarget; info: NotifyTerminalInfo }
  | { state: Exclude<LocateState, "alive"> };

interface PendingInjection {
  target: TerminalTarget;
  injectionIds: string;
  result: Promise<InjectResult>;
}

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<UnavailableReason>([
  "host-offline",
  "relaunched",
  "gone",
  "generation-mismatch",
  "session-mismatch",
  "rejected",
]);

/** Rows of scrollback read for a marker after a crash. */
const MARKER_SEARCH_ROWS = 2_000;
const MARKER_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** Whitespace and the gutter glyphs a TUI paints between the rows of a wrapped line. */
const WRAP_NOISE = /[\s─-▟⎿⏺|>›❯•●◦·]/gu;

const IN_FLIGHT: InjectResult = { outcome: "held", reason: "attempt-in-flight" };

/**
 * The Decisions library's `TerminalSink` over Daintree's wake engine
 * (#16015). An answer is typed only into the exact run that asked (host,
 * pane, launch generation, ownership principal, agent incarnation, agent
 * session, worktree), through the pane's notice line and its gate, and an
 * injection resolves only once the engine knows what became of the line:
 * delivered on the host's `pty_written` record, never on queueing.
 *
 * It holds no timer or listener. An injection still pending when its hold is
 * released, or the app quits, ends with the engine's own report for it.
 */
export class DaintreeTerminalSink implements TerminalSink {
  private readonly pending = new Map<string, PendingInjection>();
  private readonly answersInFlight = new Set<string>();

  constructor(private readonly deps: DaintreeTerminalSinkDeps) {}

  async locate(origin: QuestionOrigin): Promise<LocateResult> {
    const observed = await this.observe(targetOf(origin));
    return observed.state === "alive"
      ? { state: "alive", target: observed.target }
      : { state: observed.state };
  }

  /** At its own prompt, settled past the grace, with nothing typed since: what the wake waits for too. */
  async isIdle(target: TerminalTarget): Promise<boolean> {
    const observed = await this.observe(target);
    if (observed.state !== "alive") return false;
    const { info } = observed;
    if (evaluateWakeGate(info, EXACT_PROMPT_GATE).kind !== "ready") return false;
    const settledFor = info.lastStateChange === undefined ? 0 : this.now() - info.lastStateChange;
    return settledFor >= NOTIFY_SETTLE_GRACE_MS;
  }

  async inject(target: TerminalTarget, text: string, injectionId: string): Promise<InjectResult> {
    const blocks = parseAnswerNotice(text);
    if (blocks === null || blocks[0].injectionId !== injectionId) {
      return { outcome: "unavailable", reason: "rejected", detail: "invalid-notice" };
    }
    const id = decisionWakeId(blocks);
    const injectionIds = blocks.map((block) => block.injectionId).join(",");
    const answers = blocks.map(answerKey);
    const early = this.joinOrRefuse(id, target, injectionIds, answers);
    if (early !== null) return early;

    const observed = await this.observe(target);
    if (observed.state !== "alive") return { outcome: "unavailable", reason: observed.state };
    // Another attempt may have queued these answers while the pane was read.
    const raced = this.joinOrRefuse(id, target, injectionIds, answers);
    if (raced !== null) return raced;
    const projectId = observed.info.projectId;
    if (projectId === undefined) return { outcome: "held", reason: "unreadable" };

    let settle!: (result: InjectResult) => void;
    const result = new Promise<InjectResult>((resolve) => {
      settle = resolve;
    });
    const entry: PendingInjection = { target, injectionIds, result };
    let settled = false;
    const finish = (outcome: InjectResult) => {
      if (settled) return;
      settled = true;
      if (this.pending.get(id) === entry) this.pending.delete(id);
      for (const answer of answers) this.answersInFlight.delete(answer);
      settle(outcome);
    };
    // Installed before queueing: the engine can report synchronously.
    this.pending.set(id, entry);
    for (const answer of answers) this.answersInFlight.add(answer);

    const wake = createDecisionWake(
      this.deps,
      target,
      { id, text: renderDecisionSection(blocks) },
      (outcome, evidence) => {
        // A hold is the engine still waiting on the pane; the line may yet go out.
        if (outcome.kind === "held") return;
        this.resultFor(target, outcome, evidence).then(finish, () =>
          finish({ outcome: "ambiguous", reason: "report-failed" })
        );
      }
    );
    try {
      this.deps.queueWake(
        { key: paneNotifyKey(target.ownershipPrincipal), terminalId: target.paneId },
        projectId,
        wake
      );
    } catch (err) {
      console.error("[Decisions] Queueing an answer's wake failed:", err);
      // Whether the engine kept it is unknown, so it may still be typed.
      finish({ outcome: "ambiguous", reason: "queue-failed" });
    }
    return result;
  }

  /**
   * Whether the text carrying `injectionId` is on the run's screen. A miss
   * proves nothing: the scrollback may have been trimmed, cleared or drawn
   * differently, and a run that is no longer there is never searched.
   */
  async hasMarker(target: TerminalTarget, injectionId: string): Promise<boolean> {
    if (!MARKER_ID.test(injectionId)) return false;
    const observed = await this.observe(target);
    if (observed.state !== "alive") return false;
    const client = this.deps.getPtyClient();
    if (client?.getSerializedStateAsync === undefined) return false;
    let data: string | undefined;
    try {
      data = (await client.getSerializedStateAsync(target.paneId, { tailRows: MARKER_SEARCH_ROWS }))
        ?.data;
    } catch {
      return false;
    }
    if (data === undefined || identityMismatch(this.deps, target) !== null) return false;
    const screen = tailCapturedOutput(data, MARKER_SEARCH_ROWS, true).content;
    // The id is random hex, so it is found whole even across a wrapped row.
    return screen.replace(WRAP_NOISE, "").includes(injectionId);
  }

  /** The joined attempt's result, a refusal for overlapping answers, or null to go ahead. */
  private joinOrRefuse(
    id: string,
    target: TerminalTarget,
    injectionIds: string,
    answers: readonly string[]
  ): Promise<InjectResult> | InjectResult | null {
    const pending = this.pending.get(id);
    if (pending !== undefined) {
      return sameTarget(pending.target, target) && pending.injectionIds === injectionIds
        ? pending.result
        : IN_FLIGHT;
    }
    return answers.some((answer) => this.answersInFlight.has(answer)) ? IN_FLIGHT : null;
  }

  private async resultFor(
    target: TerminalTarget,
    outcome: Exclude<LaneWakeOutcome, { kind: "held" }>,
    evidence: LaneWakeEvidence | undefined
  ): Promise<InjectResult> {
    switch (outcome.kind) {
      case "delivered":
        return evidence?.phase === "pty_written"
          ? { outcome: "delivered", proof: `pty_written:${evidence.submissionToken}` }
          : { outcome: "ambiguous", reason: "unproven" };
      case "ambiguous":
        return { outcome: "ambiguous", reason: outcome.reason };
      case "unavailable": {
        if (UNAVAILABLE_REASONS.has(outcome.reason)) {
          return { outcome: "unavailable", reason: outcome.reason as UnavailableReason };
        }
        // Ended untyped for the engine's own reasons (stopped, expired, the
        // server or the hold gone): the pane as it is now says where it goes.
        const observed = await this.observe(target);
        return observed.state === "alive"
          ? { outcome: "held", reason: outcome.reason }
          : { outcome: "unavailable", reason: observed.state };
      }
    }
  }

  /** The pane, if it is still exactly the run `target` names. */
  private async observe(target: TerminalTarget): Promise<Observed> {
    const before = identityMismatch(this.deps, target);
    if (before === "unreadable") return { state: "host-offline" };
    if (before !== null) return { state: before };
    const client = this.deps.getPtyClient();
    if (client === null) return { state: "host-offline" };
    let info: NotifyTerminalInfo | null;
    try {
      info = await client.getTerminalAsync(target.paneId, undefined, { strict: true });
    } catch {
      // A slow host is not a missing pane.
      return { state: "host-offline" };
    }
    if (info === null) return { state: "gone" };
    // Checked again against the record: the run may have changed while it was read.
    const mismatch = identityMismatch(this.deps, target, info);
    if (mismatch === "unreadable") return { state: "host-offline" };
    if (mismatch !== null) return { state: mismatch };
    return { state: "alive", target: { ...target }, info };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
