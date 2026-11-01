import type { TerminalTarget } from "@daintreehq/decisions-client";
import { EXACT_PROMPT_GATE, evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";
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

/** Why a pane is not the run an answer is for, as the library names it. */
export type IdentityMismatch =
  "host-offline" | "relaunched" | "generation-mismatch" | "session-mismatch" | "gone";

/** The pane record's fields the identity check reads. */
export type DecisionTerminalInfo = Pick<
  NotifyTerminalInfo,
  | "hasPty"
  | "isTrashed"
  | "isExited"
  | "launchGeneration"
  | "agentIncarnation"
  | "agentSessionId"
  | "worktreeId"
>;

/** The worktree id a question's origin carries for a pane in no worktree. */
export const NO_WORKTREE = "";

/** A record's agent incarnation as the library compares it; never invented when unobserved. */
export function incarnationOf(info: Pick<NotifyTerminalInfo, "agentIncarnation">): string | null {
  return info.agentIncarnation === undefined ? null : String(info.agentIncarnation);
}

/**
 * Whether the pane is still exactly the run `target` names. Without `info`
 * only what main holds synchronously is checked (host, ownership principal,
 * live generation); with it, the record's own run identity too. A changed
 * principal or incarnation is a relaunch, checked before the generation that
 * a relaunch also changes. `unreadable`: there is no pty client to ask.
 */
export function identityMismatch(
  sources: DecisionIdentitySources,
  target: TerminalTarget,
  info?: DecisionTerminalInfo
): IdentityMismatch | "unreadable" | null {
  const hostId = sources.hostId();
  if (hostId === null || hostId !== target.hostId) return "host-offline";
  if (
    info !== undefined &&
    (info.isExited === true || info.hasPty === false || info.isTrashed === true)
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
 * checks the run is the one that asked and that the agent waits at its own
 * prompt; the engine's gate alone would let a CLI that queues input take it
 * mid-turn.
 */
export function createDecisionWake(
  sources: DecisionIdentitySources,
  target: TerminalTarget,
  section: { id: string; text: string },
  report: (outcome: LaneWakeOutcome, evidence?: LaneWakeEvidence) => void
): LaneWake {
  const recheck = (info?: NotifyTerminalInfo): LaneWakeCheck => {
    const mismatch = identityMismatch(sources, target, info);
    if (mismatch === "unreadable") return { kind: "held", reason: "unreadable" };
    if (mismatch !== null) return { kind: "unavailable", reason: mismatch };
    if (info === undefined) return { kind: "ready" };
    const verdict = evaluateWakeGate(info, EXACT_PROMPT_GATE);
    return verdict.kind === "ready" ? verdict : { kind: "held", reason: verdict.reason };
  };
  return {
    id: section.id,
    kind: "decision",
    decision: { text: section.text },
    recheck,
    // The library records its injection intent before it asks the sink to
    // type, so nothing is left to reserve here.
    beforeType: () => true,
    report,
  };
}
