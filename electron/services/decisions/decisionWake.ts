import type { TerminalTarget } from "@daintreehq/decisions-client";
import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry.js";
import { NOTIFY_SETTLE_GRACE_MS } from "../../../shared/types/terminalNotify.js";
import {
  decisionGateOptionsFor,
  evaluateWakeGate,
  wakeGateOptionsFor,
  type WakeBlockReason,
  type WakeGateSnapshot,
  type WakeHoldReason,
} from "../../../shared/utils/terminalWakeGate.js";
import type {
  LaneWake,
  LaneWakeCheck,
  LaneWakeEvidence,
  LaneWakeOutcome,
  NotifyTerminalInfo,
} from "../mcp-server/terminalNotify.js";

/** The slice of the pty client a run's identity is read from, synchronously. */
export interface DecisionGenerationReader {
  getLiveGeneration(terminalId: string): number | null;
  isLiveGeneration(terminalId: string, generation: number): boolean;
}

/** Where a pane's run identity comes from in main. */
export interface DecisionIdentitySources {
  /** This machine's Decisions host id; null before a relay identity exists. */
  hostId(): string | null;
  /** The pane's current ownership principal; null while it holds no bearer. */
  principalFor(paneId: string): string | null;
  getPtyClient(): DecisionGenerationReader | null;
}

/** What a decision wake reads beside the run's identity. */
export interface DecisionWakeSources extends DecisionIdentitySources {
  /** Whether a view's hybrid input holds text for the pane (#16282). */
  hasComposerDraft?(paneId: string): boolean;
  now?: () => number;
}

/**
 * The wake's own reason for ending untyped once a reopen of its question
 * waits for this write (#17941): never a library `UnavailableReason`, so the
 * sink tells it apart from any reading of the pane.
 */
export const DECISION_SUPERSEDED = "superseded";

/**
 * The longest a closure notice waits in the wake queue for its pane (#17941):
 * past the line's coalescing, its spacing after another line and the settle
 * grace, with room to spare. The queue can otherwise hold a line for minutes
 * after the library admitted it, sometimes without a word; ended by the
 * engine instead, it is admitted again on a later pass, against the question
 * and the ledger as they stand then.
 */
export const DECISION_CLOSURE_PENDING_MS = 15_000;

/** Why an answer can't be typed into the pane as it is now, or null when it can. */
export type DecisionHold = WakeHoldReason | WakeBlockReason | "settling";

/**
 * Whether an answer or follow-up may be typed into the pane now (#16282): an
 * empty composer, mid-turn when its CLI queues input, at its prompt or at a
 * question it asked in prose. A CLI that can't take a line mid-turn gets it
 * only once the prompt has held past the settle grace, so a prompt read for a
 * moment inside a turn never takes it.
 */
export function decisionHold(
  info: WakeGateSnapshot,
  hasComposerDraft: boolean,
  now: number
): DecisionHold | null {
  const verdict = evaluateWakeGate(
    { ...info, hasComposerDraft },
    decisionGateOptionsFor(info.detectedAgentId)
  );
  if (verdict.kind !== "ready") return verdict.reason;
  if (wakeGateOptionsFor(info.detectedAgentId).acceptWorking === true) return null;
  const settledFor = info.lastStateChange === undefined ? 0 : now - info.lastStateChange;
  return settledFor >= NOTIFY_SETTLE_GRACE_MS ? null : "settling";
}

/** Why a pane is not the run an answer is for, as the library names it. */
export type IdentityMismatch =
  "host-offline" | "relaunched" | "generation-mismatch" | "session-mismatch" | "gone";

/** The pane record's fields the identity check reads. */
export type DecisionTerminalInfo = Pick<
  NotifyTerminalInfo,
  | "hasPty"
  | "isTrashed"
  | "isClosing"
  | "isExited"
  | "launchGeneration"
  | "agentIncarnation"
  | "agentSessionId"
  | "worktreeId"
  | "detectedAgentId"
  | "launchAgentId"
>;

/** The worktree id a question's origin carries for a pane in no worktree. */
export const NO_WORKTREE = "";

/** A record's agent incarnation as the library compares it; never invented when unobserved. */
export function incarnationOf(info: Pick<NotifyTerminalInfo, "agentIncarnation">): string | null {
  return info.agentIncarnation === undefined ? null : String(info.agentIncarnation);
}

/**
 * Whether another agent holds the pane than `askerKind`, the kind that asked
 * (#18116): detection can hand a live PTY to another agent without a respawn,
 * so its incarnation stays the same. A pane whose agent isn't known yet is no
 * evidence of a swap. A built-in's executable names win over a plugin's, so
 * a plugin agent can be detected as a built-in; that is the one difference a
 * plugin asker's own run can show, and another plugin agent there is not it.
 */
export function askerReplaced(
  askerKind: string,
  info: Pick<NotifyTerminalInfo, "detectedAgentId" | "launchAgentId">
): boolean {
  const agent = info.detectedAgentId ?? info.launchAgentId;
  if (agent === undefined || agent === askerKind) return false;
  return Object.hasOwn(AGENT_REGISTRY, askerKind) || !Object.hasOwn(AGENT_REGISTRY, agent);
}

/**
 * Whether the pane is still exactly the run `target` names. Without `info`
 * only what main holds synchronously is checked (host, ownership principal,
 * live generation); with it, the record's own run identity too. A changed
 * principal or incarnation is a relaunch, checked before the generation that
 * a relaunch also changes, and so is another agent kind in place of any of
 * `askerKinds` (`askerReplaced`). `unreadable`: there is no pty client to
 * ask.
 */
export function identityMismatch(
  sources: DecisionIdentitySources,
  target: TerminalTarget,
  info?: DecisionTerminalInfo,
  askerKinds: readonly string[] = []
): IdentityMismatch | "unreadable" | null {
  const hostId = sources.hostId();
  if (hostId === null || hostId !== target.hostId) return "host-offline";
  if (
    info !== undefined &&
    (info.isExited === true ||
      info.hasPty === false ||
      info.isTrashed === true ||
      info.isClosing === true)
  ) {
    return "gone";
  }
  if (sources.principalFor(target.paneId) !== target.ownershipPrincipal) return "relaunched";
  if (info !== undefined && incarnationOf(info) !== target.agentIncarnation) return "relaunched";
  const client = sources.getPtyClient();
  if (client === null) return "unreadable";
  const generation = target.terminalGeneration;
  // Both: a spawn displacing the live one still answers `isLiveGeneration`.
  if (
    client.getLiveGeneration(target.paneId) !== generation ||
    !client.isLiveGeneration(target.paneId, generation)
  ) {
    return "generation-mismatch";
  }
  if (info === undefined) return null;
  if (info.launchGeneration !== undefined && info.launchGeneration !== generation) {
    return "generation-mismatch";
  }
  // One question asked by an agent that left takes the whole line with it: an asker whose kind
  // could stay was running as the agent that left, so its run is gone too.
  if (askerKinds.some((kind) => askerReplaced(kind, info))) return "relaunched";
  // A session learned since the question was asked is that run's; one that
  // changed, or went unknown, is not.
  if (target.agentSessionId !== null && info.agentSessionId !== target.agentSessionId) {
    return "session-mismatch";
  }
  // An answer for one worktree never lands in another. A pane outside any
  // worktree (a scratch folder) asked with none: `NO_WORKTREE`.
  if ((info.worktreeId ?? NO_WORKTREE) !== target.worktreeId) return "gone";
  return null;
}

/**
 * A Decisions answer on its pane's notice line (#16015), modeled on the
 * approval wake. The id is stable for the same answers (see
 * `decisionWakeId`), so a second attempt queued before the first goes out
 * joins it. Right before typing, with the record the attempt just read, it
 * checks the run is the one that asked and that the composer is empty
 * (`decisionHold`), which the engine's own gate doesn't know about, and
 * that no agent kind in `askerKinds` was replaced by another (#18116). A
 * section whose `superseded` says a reopen waits for it ends untyped first,
 * whatever the pane: a line already on its way is never taken back. A
 * `closure` section (an expiry, advisory or not, or a decline) waits for its
 * pane only `DECISION_CLOSURE_PENDING_MS`, so it is never typed on an
 * admission that has gone stale.
 */
export function createDecisionWake(
  sources: DecisionWakeSources,
  target: TerminalTarget,
  section: {
    id: string;
    text: string;
    /** The agent kinds that asked the questions it carries. */
    askerKinds?: readonly string[];
    superseded?: () => boolean;
    closure?: boolean;
  },
  report: (outcome: LaneWakeOutcome, evidence?: LaneWakeEvidence) => void
): LaneWake {
  const askerKinds = section.askerKinds ?? [];
  const recheck = (info?: NotifyTerminalInfo): LaneWakeCheck => {
    if (section.superseded?.() === true)
      return { kind: "unavailable", reason: DECISION_SUPERSEDED };
    const mismatch = identityMismatch(sources, target, info, askerKinds);
    if (mismatch === "unreadable") return { kind: "held", reason: "unreadable" };
    if (mismatch !== null) return { kind: "unavailable", reason: mismatch };
    if (info === undefined) return { kind: "ready" };
    const hold = decisionHold(
      info,
      sources.hasComposerDraft?.(target.paneId) === true,
      sources.now?.() ?? Date.now()
    );
    return hold === null ? { kind: "ready" } : { kind: "held", reason: hold };
  };
  return {
    id: section.id,
    kind: "decision",
    decision: { text: section.text },
    ...(section.closure === true ? { maxPendingMs: DECISION_CLOSURE_PENDING_MS } : {}),
    recheck,
    // The library records its injection intent before it asks the sink to
    // type, so nothing is left to reserve here.
    beforeType: () => true,
    report,
  };
}
