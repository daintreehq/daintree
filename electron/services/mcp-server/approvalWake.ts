import { createHash } from "node:crypto";
import type { AssistantApproval } from "./noticeFormat.js";
import type { SessionStore } from "./sessionStore.js";
import type { LaneWake, LaneWakeCheck } from "./terminalNotify.js";

export interface HelpLane {
  helpSessionId: string;
  terminalId: string;
  projectId: string;
}

export interface ApprovalWakeDeps {
  sessionStore: Pick<SessionStore, "getTier" | "grantCache">;
  /** The lane the session serves now; a different terminal means it was relaunched. */
  helpLaneFor(sessionId: string): HelpLane | null;
}

/**
 * The line telling a help lane's assistant the user approved what its tier
 * refused (#14995). The refusal itself is final and nothing is replayed: the
 * line only says the next attempt can go through, and only while that is
 * still true when it is typed.
 *
 * The id is stable per tool or tier, so a second approval queued before the
 * first line goes out joins it rather than typing the same line twice.
 */
export function createApprovalWake(
  deps: ApprovalWakeDeps,
  sessionId: string,
  lane: HelpLane,
  approval: AssistantApproval
): LaneWake {
  const id =
    approval.kind === "tool"
      ? `approval-tool-${createHash("sha256").update(approval.toolId).digest("hex").slice(0, 32)}`
      : `approval-tier-${approval.tier}`;
  const recheck = (): LaneWakeCheck => {
    const tier = deps.sessionStore.getTier(sessionId);
    if (tier === null) return { kind: "unavailable", reason: "session-gone" };
    const now = deps.helpLaneFor(sessionId);
    if (now?.helpSessionId !== lane.helpSessionId || now.terminalId !== lane.terminalId) {
      return { kind: "unavailable", reason: "relaunched" };
    }
    const stillApproved =
      approval.kind === "tool"
        ? deps.sessionStore.grantCache.check(sessionId, approval.toolId).granted
        : tier === approval.tier;
    return stillApproved ? { kind: "ready" } : { kind: "unavailable", reason: "approval-ended" };
  };
  return {
    id,
    kind: "approval",
    approval,
    recheck,
    beforeType: () => true,
    report: () => {},
  };
}
