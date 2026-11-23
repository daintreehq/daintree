import {
  markerFor,
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
import { PTY_MIRROR_SCROLLBACK } from "../../../shared/config/scrollback.js";
import { tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import {
  inputSuggestionRuleFor,
  observeInputLine,
} from "../../../shared/utils/terminalInputLine.js";
import {
  ENTER_HELD,
  paneNotifyKey,
  type LaneWake,
  type LaneWakeEvidence,
  type LaneWakeOutcome,
  type NotifyTerminalInfo,
  type OwnPane,
} from "../mcp-server/terminalNotify.js";
import {
  blockKey,
  decisionWakeId,
  isFollowupBlock,
  parseDecisionNotice,
  renderDecisionSection,
  type DecisionBlock,
} from "./answerNotice.js";
import {
  DECISION_SUPERSEDED,
  askerReplaced,
  createDecisionWake,
  decisionHold,
  identityMismatch,
  type DecisionGenerationReader,
  type DecisionWakeSources,
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

export interface DaintreeTerminalSinkDeps extends DecisionWakeSources {
  getPtyClient(): DecisionSinkPtyClient | null;
  /** The listener hold's wake queue (#15999), which takes wakes with the MCP server off. */
  queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void;
  /**
   * Whether a reopen of one of these questions waits for the closure notice
   * being written for it (#17941), asked synchronously before the line goes
   * out: the attempt then ends untyped, so the reopen applies first.
   */
  closureSuperseded?(questionIds: readonly string[]): boolean;
  /**
   * The question's origin as the store holds it now, or null for one it no
   * longer has: whose agent kind an injection is checked against (#18116).
   */
  originOf(questionId: string): Promise<QuestionOrigin | null>;
}

type Observed =
  | { state: "alive"; target: TerminalTarget; info: NotifyTerminalInfo }
  | { state: Exclude<LocateState, "alive"> };

interface PendingInjection {
  target: TerminalTarget;
  injectionIds: string;
  result: Promise<InjectResult>;
}

/** An answer or follow-up whose body the host left in the composer, its Enter held (#18157). */
interface StagedBlock {
  target: TerminalTarget;
  /** The injection id its staged text carries. */
  injectionId: string;
  at: number;
}

/** A staged answer or follow-up whose marker the screen showed submitted, while its chunk's others were still to type. */
interface ProvenBlock {
  target: TerminalTarget;
  injectionId: string;
  at: number;
}

/** What an empty composer showed of a chunk with staged blocks: what is left to type, and why the rest isn't. */
type StagedSettlement =
  | { kind: "result"; result: InjectResult }
  | { kind: "type"; blocks: readonly DecisionBlock[]; proof: string | null };

/** The run's composer as its screen shows it: `empty` takes in a CLI's suggested prompt. */
type ComposerRead = "empty" | "typed" | "unknown";

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
/**
 * Rows read to settle a staged answer (#18157): all the host keeps, so a long
 * turn since a person submitted it doesn't hide its marker short of that.
 */
const STAGED_SEARCH_ROWS = PTY_MIRROR_SCROLLBACK;
/** A snapshot holding an alternate screen: its prompt and its markers can sit in different buffers. */
const ALT_SCREEN_ENTER = "\x1b[?1049h";

/** A marker as a screen search finds it, with the wrap noise taken out. */
function markerText(injectionId: string): string {
  return markerFor(injectionId).replace(WRAP_NOISE, "");
}

/**
 * The same run, a session learned since aside (#18157): a run that asked
 * before its session was known is still that run once it is.
 */
function sameRun(staged: TerminalTarget, target: TerminalTarget): boolean {
  if (staged.agentSessionId === null && target.agentSessionId !== null) {
    return sameTarget({ ...staged, agentSessionId: target.agentSessionId }, target);
  }
  return sameTarget(staged, target);
}
const MARKER_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** Whitespace and the gutter glyphs a TUI paints between the rows of a wrapped line. */
const WRAP_NOISE = /[\s─-▟⎿⏺|>›❯•●◦·]/gu;

/**
 * How long a staged answer may wait for its composer to come back empty
 * before it is left to the person as uncertain (#18157).
 */
export const STAGED_WAIT_MS = 30 * 60_000;
/** How long a staged answer nobody tries again is remembered. */
const STAGED_FORGET_MS = 24 * 60 * 60_000;

const IN_FLIGHT: InjectResult = { outcome: "held", reason: "attempt-in-flight" };
const SUPERSEDED: InjectResult = { outcome: "held", reason: DECISION_SUPERSEDED };
const ORIGIN_MOVED: InjectResult = { outcome: "held", reason: "origin-moved" };

/** The questions whose block in a notice closed a round without an answer: what a reopen waits on. */
function closureQuestions(blocks: readonly DecisionBlock[]): string[] {
  return blocks.flatMap((block) =>
    !isFollowupBlock(block) && (block.expired || block.advisoryUnanswered || block.declined)
      ? [block.questionId]
      : []
  );
}

/**
 * The Decisions library's `TerminalSink` over Daintree's wake engine
 * (#16015). An answer, or a follow-up the person sent after it (#16231), is
 * typed only into the exact run that asked (host,
 * pane, launch generation, ownership principal, agent incarnation, agent
 * session, worktree, and the agent kind each question's stored origin names),
 * through the pane's notice line and its gate, and an
 * injection resolves only once the engine knows what became of the line:
 * delivered on the host's `pty_written` record, never on queueing.
 *
 * It holds no timer or listener. An injection still pending when its hold is
 * released, or the app quits, ends with the engine's own report for it.
 */
export class DaintreeTerminalSink implements TerminalSink {
  private readonly pending = new Map<string, PendingInjection>();
  /** The answers and follow-ups an attempt is typing, by `blockKey`. */
  private readonly inFlight = new Set<string>();
  /**
   * Answers and follow-ups left in a composer behind a held Enter, by
   * `blockKey` (#18157): the library is told nothing was typed and tries
   * again, and that attempt reads the screen before anything is typed.
   */
  private readonly staged = new Map<string, StagedBlock>();
  /**
   * Staged blocks the screen showed submitted, by `blockKey` (#18157), kept
   * until their chunk is delivered or left uncertain: however its other
   * blocks fare, these are never typed again.
   */
  private readonly proven = new Map<string, ProvenBlock>();
  /**
   * Runs whose composer an Enter-held line left text in, by pane (#18157):
   * the engine lets answers follow that line, so every attempt into the run
   * reads an empty composer off the screen before anything is typed, until
   * one does.
   */
  private readonly drafted = new Map<string, { target: TerminalTarget; at: number }>();
  /** Panes whose composer an attempt is reading, so two never settle the same staged text. */
  private readonly settling = new Set<string>();

  constructor(private readonly deps: DaintreeTerminalSinkDeps) {}

  async locate(origin: QuestionOrigin): Promise<LocateResult> {
    const observed = await this.observe(targetOf(origin), [origin.agent_kind]);
    return observed.state === "alive"
      ? { state: "alive", target: observed.target }
      : { state: observed.state };
  }

  /** The composer is empty and the pane can take a line now (`decisionHold`): what the wake waits for too. */
  async isIdle(target: TerminalTarget): Promise<boolean> {
    const observed = await this.observe(target);
    if (observed.state !== "alive") return false;
    const hasDraft = this.deps.hasComposerDraft?.(target.paneId) === true;
    return decisionHold(observed.info, hasDraft, this.now()) === null;
  }

  async inject(target: TerminalTarget, text: string, injectionId: string): Promise<InjectResult> {
    const blocks = parseDecisionNotice(text);
    if (blocks === null || blocks[0].injectionId !== injectionId) {
      return { outcome: "unavailable", reason: "rejected", detail: "invalid-notice" };
    }
    const id = decisionWakeId(blocks);
    const injectionIds = blocks.map((block) => block.injectionId).join(",");
    const keys = blocks.map(blockKey);
    const early = this.joinOrRefuse(id, target, injectionIds, keys);
    if (early !== null) return early;
    const closures = closureQuestions(blocks);
    const superseded = () =>
      closures.length > 0 && this.deps.closureSuperseded?.(closures) === true;

    const [askerKinds, observed] = await Promise.all([
      this.askerKindsOf(blocks, target),
      this.observe(target),
    ]);
    // Another attempt may have queued these blocks while the pane was read,
    // and its wake can still type them whatever this read saw.
    const raced = this.joinOrRefuse(id, target, injectionIds, keys);
    if (raced !== null) return raced;
    // A reopen came while the pane was read: nothing is queued, so it applies now.
    if (superseded()) return SUPERSEDED;
    // A question moved to another run since the engine read it: it builds the chunk again.
    if (askerKinds === null) return ORIGIN_MOVED;
    if (observed.state !== "alive") return { outcome: "unavailable", reason: observed.state };
    // Another agent kind took the pane from one of the askers (#18116).
    if (askerKinds.some((kind) => askerReplaced(kind, observed.info))) {
      return { outcome: "unavailable", reason: "relaunched" };
    }
    const projectId = observed.info.projectId;
    if (projectId === undefined) return { outcome: "held", reason: "unreadable" };
    // What this attempt types: a staged block the screen shows submitted
    // goes on the proof instead (#18157).
    let typing: readonly DecisionBlock[] = blocks;
    let seenProof: string | null = null;
    if (this.mustReadComposer(keys, target)) {
      if (this.settling.has(target.paneId)) return IN_FLIGHT;
      this.settling.add(target.paneId);
      let settled: StagedSettlement;
      try {
        settled = await this.settleStaged(target, askerKinds, blocks);
      } finally {
        this.settling.delete(target.paneId);
      }
      if (settled.kind === "result") {
        const { outcome } = settled.result;
        if (outcome === "delivered" || outcome === "ambiguous") this.unstage(keys);
        return settled.result;
      }
      // The screen read clear: the attempt types, unless one joined or a
      // reopen came while it was read.
      const rejoined = this.joinOrRefuse(id, target, injectionIds, keys);
      if (rejoined !== null) return rejoined;
      if (superseded()) return SUPERSEDED;
      typing = settled.blocks;
      seenProof = settled.proof;
    }
    const typingClosures = closureQuestions(typing);

    let settle!: (result: InjectResult) => void;
    const result = new Promise<InjectResult>((resolve) => {
      settle = resolve;
    });
    const entry: PendingInjection = { target, injectionIds, result };
    let settled = false;
    const finish = (raw: InjectResult) => {
      if (settled) return;
      settled = true;
      if (this.pending.get(id) === entry) this.pending.delete(id);
      for (const key of keys) this.inFlight.delete(key);
      // Settled once the chunk is delivered or left uncertain; held or
      // unavailable, the library tries the chunk again.
      if (raw.outcome === "delivered" || raw.outcome === "ambiguous") this.unstage(keys);
      settle(
        raw.outcome === "delivered" && seenProof !== null
          ? { outcome: "delivered", proof: `${seenProof};${raw.proof}` }
          : raw
      );
    };
    // Installed before queueing: the engine can report synchronously.
    this.pending.set(id, entry);
    for (const key of keys) this.inFlight.add(key);

    const wake = createDecisionWake(
      this.deps,
      target,
      {
        id,
        text: renderDecisionSection(typing),
        askerKinds,
        superseded,
        closure: typingClosures.length > 0,
      },
      (outcome, evidence) => {
        // A hold is the engine still waiting on the pane; the line may yet go out.
        if (outcome.kind === "held") return;
        // Ended untyped some other way (its pane closing, the hold let go) once it stood superseded:
        // still the engine's to rebuild, never a refused write to resume or report.
        const untyped = (result: InjectResult) =>
          result.outcome === "unavailable" && superseded() ? SUPERSEDED : result;
        if (outcome.kind === "unavailable" && superseded()) {
          finish(SUPERSEDED);
          return;
        }
        this.resultFor(target, askerKinds, typing, outcome, evidence).then(
          (result) => finish(untyped(result)),
          () => finish({ outcome: "ambiguous", reason: "report-failed" })
        );
      }
    );
    try {
      this.deps.queueWake(
        { key: paneNotifyKey(target.ownershipPrincipal), terminalId: target.paneId },
        projectId,
        wake
      );
    } catch {
      // Nothing of the error: its message could quote the pane's state, and this log can leave the machine.
      console.error("[Decisions] Queueing an answer's wake failed: wake_queue_failed");
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
    return (await this.readMarker(target, injectionId)) === true;
  }

  /**
   * As `hasMarker`, telling a screen that couldn't be read (null) from one
   * read without the marker (false): the run was there a moment ago, so a
   * read that failed or a run that changed since says nothing either way.
   * `askerKind` is the agent kind the question's origin names, which the run
   * must still hold before and after the screen is read (#18116).
   */
  async readMarker(
    target: TerminalTarget,
    injectionId: string,
    askerKind?: string
  ): Promise<boolean | null> {
    if (!MARKER_ID.test(injectionId)) return false;
    const screen = await this.readScreen(target, askerKind === undefined ? [] : [askerKind]);
    if (screen === undefined) return false;
    return screen === null ? null : screen.includes(injectionId);
  }

  /**
   * The run's serialized screen, its newest `rows` of scrollback with it,
   * read between two checks that it is still the run `target` names: null
   * when it couldn't be read or the run changed, undefined when this host
   * can't read screens at all.
   */
  private async readSnapshot(
    target: TerminalTarget,
    askerKinds: readonly string[],
    rows: number
  ): Promise<{ data: string; agentId: string | undefined } | null | undefined> {
    const observed = await this.observe(target, askerKinds);
    if (observed.state !== "alive") return null;
    const client = this.deps.getPtyClient();
    if (client?.getSerializedStateAsync === undefined) return undefined;
    let data: string | undefined;
    try {
      data = (await client.getSerializedStateAsync(target.paneId, { tailRows: rows }))?.data;
    } catch {
      return null;
    }
    // The pty client answers a read that failed with nothing.
    if (data === undefined) return null;
    // The run may have changed while the screen was read, its agent kind with it.
    const after = await this.observe(target, askerKinds);
    if (after.state !== "alive") return null;
    return { data, agentId: after.info.detectedAgentId };
  }

  /** The run's screen as text with the wrap noise stripped, for a marker search. */
  private async readScreen(
    target: TerminalTarget,
    askerKinds: readonly string[],
    rows = MARKER_SEARCH_ROWS
  ): Promise<string | null | undefined> {
    const snapshot = await this.readSnapshot(target, askerKinds, rows);
    if (snapshot === null || snapshot === undefined) return snapshot;
    // The id is random hex, so it is found whole even across a wrapped row.
    return tailCapturedOutput(snapshot.data, rows, true).content.replace(WRAP_NOISE, "");
  }

  /**
   * The run's composer, read off the rows on view only, as every input-row
   * reader does: a frame left in scrollback is not the composer. An alternate
   * screen settles nothing, since a draft can sit in the other buffer.
   */
  private async readComposer(
    target: TerminalTarget,
    askerKinds: readonly string[]
  ): Promise<ComposerRead> {
    const snapshot = await this.readSnapshot(target, askerKinds, 0);
    if (snapshot === null || snapshot === undefined) return "unknown";
    if (snapshot.data.includes(ALT_SCREEN_ENTER)) return "unknown";
    const input = observeInputLine(snapshot.data, inputSuggestionRuleFor(snapshot.agentId))
      .inputLine.state;
    return input === "empty" || input === "suggestion" ? "empty" : input;
  }

  /**
   * An empty composer with every block's marker on screen: the line was
   * submitted, by the person if not by Daintree (#18157). Null when the
   * screen can't show that.
   */
  private async seenSubmitted(
    target: TerminalTarget,
    askerKinds: readonly string[],
    blocks: readonly DecisionBlock[]
  ): Promise<InjectResult | null> {
    if ((await this.readComposer(target, askerKinds)) !== "empty") return null;
    const screen = await this.readScreen(target, askerKinds, STAGED_SEARCH_ROWS);
    if (typeof screen !== "string") return null;
    const ids = blocks.map((block) => block.injectionId);
    if (!ids.every((id) => screen.includes(markerText(id)))) return null;
    // Still empty after the search: a draft redrawn between the reads put no marker there.
    if ((await this.readComposer(target, askerKinds)) !== "empty") return null;
    return { outcome: "delivered", proof: `marker:${ids.join(",")}` };
  }

  /** Whether an attempt into `target` reads its composer first: staged text may be in it. */
  private mustReadComposer(keys: readonly string[], target: TerminalTarget): boolean {
    // Another run starts with its own composer: the text was never there.
    const drafted = this.drafted.get(target.paneId);
    if (drafted !== undefined && !sameRun(drafted.target, target)) {
      this.drafted.delete(target.paneId);
    }
    let found = this.drafted.has(target.paneId);
    for (const key of keys) {
      for (const map of [this.staged, this.proven]) {
        const entry = map.get(key);
        if (entry === undefined) continue;
        if (!sameRun(entry.target, target)) map.delete(key);
        else found = true;
      }
    }
    return found;
  }

  /**
   * Remember that the host left `blocks` in the run's composer, for the next
   * attempt to look for. A closure notice is not staged: a reopen withdraws
   * it before any attempt could read its fate, so it stays uncertain, as it
   * always was; its pane still reads its composer.
   */
  private stage(target: TerminalTarget, blocks: readonly DecisionBlock[]): boolean {
    const at = this.now();
    for (const map of [this.staged, this.proven]) {
      for (const [key, entry] of map) {
        if (at - entry.at >= STAGED_FORGET_MS) map.delete(key);
      }
    }
    for (const [pane, entry] of this.drafted) {
      if (at - entry.at >= STAGED_FORGET_MS) this.drafted.delete(pane);
    }
    this.drafted.set(target.paneId, { target: { ...target }, at });
    if (closureQuestions(blocks).length > 0) return false;
    for (const block of blocks) {
      this.staged.set(blockKey(block), {
        target: { ...target },
        injectionId: block.injectionId,
        at,
      });
    }
    return true;
  }

  private unstage(keys: readonly string[]): void {
    for (const key of keys) {
      this.staged.delete(key);
      this.proven.delete(key);
    }
  }

  /**
   * What became of staged text, read off the run's screen before anything is
   * typed into it (#18157). Text in the composer waits: nothing is typed on
   * top of it, however long it stays, though staged blocks under it are left
   * uncertain after `STAGED_WAIT_MS`. A composer that can't be read waits
   * that long, then lets the chunk go on its gate. With the composer empty,
   * staged blocks whose markers all show were submitted and are proven;
   * none showing means their text was dropped, to be typed afresh; a mix
   * can't be settled from the screen and is left uncertain. Only the
   * chunk's unproven blocks are typed.
   */
  private async settleStaged(
    target: TerminalTarget,
    askerKinds: readonly string[],
    blocks: readonly DecisionBlock[]
  ): Promise<StagedSettlement> {
    const keys = blocks.map(blockKey);
    const staged = new Map<string, StagedBlock>();
    for (const key of keys) {
      const entry = this.staged.get(key);
      if (entry !== undefined) staged.set(key, entry);
    }
    const held: StagedSettlement = {
      kind: "result",
      result: { outcome: "held", reason: ENTER_HELD },
    };
    const uncertain = (reason: string): StagedSettlement => ({
      kind: "result",
      result: { outcome: "ambiguous", reason },
    });
    const now = this.now();
    const stagedSince = Math.min(...[...staged.values()].map((entry) => entry.at));
    const composer = await this.readComposer(target, askerKinds);
    if (composer === "typed") {
      return now - stagedSince >= STAGED_WAIT_MS ? uncertain("enter-held-unresolved") : held;
    }
    if (composer === "unknown") {
      const drafted = this.drafted.get(target.paneId);
      if (now - Math.min(stagedSince, drafted?.at ?? Infinity) < STAGED_WAIT_MS) return held;
      this.drafted.delete(target.paneId);
      if (staged.size > 0) return uncertain("enter-held-unresolved");
    } else if (staged.size > 0) {
      const screen = await this.readScreen(target, askerKinds, STAGED_SEARCH_ROWS);
      if (typeof screen !== "string") {
        return now - stagedSince >= STAGED_WAIT_MS ? uncertain("enter-held-unresolved") : held;
      }
      const seen = [...staged].filter(([, entry]) =>
        screen.includes(markerText(entry.injectionId))
      );
      if (seen.length > 0 && seen.length < staged.size) return uncertain("enter-held-partial");
      // Still empty after the search: a draft redrawn between the reads put no marker there.
      if ((await this.readComposer(target, askerKinds)) !== "empty") return held;
      this.drafted.delete(target.paneId);
      for (const [key, entry] of staged) {
        this.staged.delete(key);
        if (seen.length > 0) this.proven.set(key, { ...entry, at: now });
      }
    } else {
      this.drafted.delete(target.paneId);
    }
    const proven = keys.flatMap((key) => {
      const entry = this.proven.get(key);
      return entry === undefined ? [] : [entry];
    });
    const proof =
      proven.length === 0 ? null : `marker:${proven.map((entry) => entry.injectionId).join(",")}`;
    const rest = blocks.filter((block) => !this.proven.has(blockKey(block)));
    if (rest.length === 0)
      return { kind: "result", result: { outcome: "delivered", proof: proof! } };
    return { kind: "type", blocks: rest, proof };
  }

  /**
   * The distinct agent kinds that asked `blocks`' questions, as the store
   * holds their origins now; null when one is gone, unreadable, or names
   * another run than `target`.
   */
  private async askerKindsOf(
    blocks: readonly DecisionBlock[],
    target: TerminalTarget
  ): Promise<string[] | null> {
    const kinds = new Set<string>();
    for (const questionId of new Set(blocks.map((block) => block.questionId))) {
      let origin: QuestionOrigin | null;
      try {
        origin = await this.deps.originOf(questionId);
      } catch {
        return null;
      }
      if (origin === null || !sameTarget(targetOf(origin), target)) return null;
      kinds.add(origin.agent_kind);
    }
    return [...kinds];
  }

  /** The joined attempt's result, a refusal for overlapping blocks, or null to go ahead. */
  private joinOrRefuse(
    id: string,
    target: TerminalTarget,
    injectionIds: string,
    keys: readonly string[]
  ): Promise<InjectResult> | InjectResult | null {
    const pending = this.pending.get(id);
    if (pending !== undefined) {
      return sameTarget(pending.target, target) && pending.injectionIds === injectionIds
        ? pending.result
        : IN_FLIGHT;
    }
    return keys.some((key) => this.inFlight.has(key)) ? IN_FLIGHT : null;
  }

  private async resultFor(
    target: TerminalTarget,
    askerKinds: readonly string[],
    blocks: readonly DecisionBlock[],
    outcome: Exclude<LaneWakeOutcome, { kind: "held" }>,
    evidence: LaneWakeEvidence | undefined
  ): Promise<InjectResult> {
    switch (outcome.kind) {
      case "delivered":
        return evidence?.phase === "pty_written"
          ? { outcome: "delivered", proof: `pty_written:${evidence.submissionToken}` }
          : { outcome: "ambiguous", reason: "unproven" };
      case "ambiguous":
        // The body sits in the composer, its Enter held for a dialog or for
        // input (#18157): nothing more is typed until the screen says what
        // became of it, which the next attempt reads first.
        if (outcome.reason === ENTER_HELD && this.stage(target, blocks)) {
          return { outcome: "held", reason: ENTER_HELD };
        }
        // Submitted after all, as far as the screen shows (#18157).
        return (
          (await this.seenSubmitted(target, askerKinds, blocks)) ?? {
            outcome: "ambiguous",
            reason: outcome.reason,
          }
        );
      case "unavailable": {
        // Ended untyped for a reopen, whatever the pane is now: the whole chunk
        // goes back to the engine, which rebuilds it once the reopen applies.
        if (outcome.reason === DECISION_SUPERSEDED) return SUPERSEDED;
        if (UNAVAILABLE_REASONS.has(outcome.reason)) {
          return { outcome: "unavailable", reason: outcome.reason as UnavailableReason };
        }
        // Ended untyped for the engine's own reasons (stopped, expired, the
        // server or the hold gone): the pane as it is now says where it goes.
        const observed = await this.observe(target, askerKinds);
        return observed.state === "alive"
          ? { outcome: "held", reason: outcome.reason }
          : { outcome: "unavailable", reason: observed.state };
      }
    }
  }

  /** The pane, if it is still exactly the run `target` names, held by an agent of `askerKinds`. */
  private async observe(
    target: TerminalTarget,
    askerKinds: readonly string[] = []
  ): Promise<Observed> {
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
    const mismatch = identityMismatch(this.deps, target, info, askerKinds);
    if (mismatch === "unreadable") return { state: "host-offline" };
    if (mismatch !== null) return { state: mismatch };
    return { state: "alive", target: { ...target }, info };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
