import { describe, expect, it, vi } from "vitest";
import { canonicalArgsHash } from "../../../services/mcp-server/sessionDedup.js";
import { askShellApproval, type RelayApprovalAsk } from "../relayApprovals.js";
import { AssistantLinkMethod, RelayApprovePayloadSchema } from "../linkMethods.js";

const ASK: RelayApprovalAsk = {
  helpSessionId: "help-1",
  callId: "call-1",
  projectId: "project-1",
  actionId: "worktree.delete",
  args: { worktreeId: "/repo-wt/feature" },
  subject: "feature/thing",
  lines: ["No uncommitted changes."],
};

const HASH = canonicalArgsHash("worktree.delete", { worktreeId: "/repo-wt/feature" });

function linkAnswering(answer: (payload: Record<string, unknown>) => unknown) {
  return {
    call: vi.fn(async (_method: string, payload: unknown) =>
      answer(payload as Record<string, unknown>)
    ),
  };
}

describe("askShellApproval (#13501)", () => {
  it("asks the Shell about exactly the call, bound by id and argument hash", async () => {
    const link = linkAnswering((payload) => ({
      approvalId: payload.approvalId,
      argsHash: payload.argsHash,
      decision: "approved",
    }));

    const decision = await askShellApproval(link, ASK, {
      now: () => 1_000,
      newId: () => "approval-1",
      windowMs: 40_000,
    });

    expect(decision).toEqual({ decision: "approved", deadline: 41_000 });
    const [method, payload] = link.call.mock.calls[0]!;
    expect(method).toBe(AssistantLinkMethod.RELAY_APPROVE);
    expect(RelayApprovePayloadSchema.parse(payload)).toEqual({
      approvalId: "approval-1",
      helpSessionId: "help-1",
      callId: "call-1",
      projectId: "project-1",
      actionId: "worktree.delete",
      args: { worktreeId: "/repo-wt/feature" },
      argsHash: HASH,
      subject: "feature/thing",
      lines: ["No uncommitted changes."],
    });
  });

  it("counts nobody's approval in an answer that doesn't echo the ask", async () => {
    for (const answer of [
      { approvalId: "someone-else", argsHash: HASH, decision: "approved" },
      { approvalId: "approval-1", argsHash: "0".repeat(64), decision: "approved" },
      { decision: "approved" },
      null,
    ]) {
      const decision = await askShellApproval(
        linkAnswering(() => answer),
        ASK,
        { newId: () => "approval-1" }
      );
      expect(decision).toEqual({ decision: "unavailable" });
    }
  });

  it("gives an approval that lands after the window nothing to cover", async () => {
    let clock = 0;
    const link = linkAnswering((payload) => {
      clock = 41_000;
      return { approvalId: payload.approvalId, argsHash: payload.argsHash, decision: "approved" };
    });

    const decision = await askShellApproval(link, ASK, { now: () => clock, windowMs: 40_000 });

    expect(decision).toEqual({ decision: "timeout" });
  });

  it("passes a decline, a missed dialog and a refusal through as nobody approving", async () => {
    for (const [answered, expected] of [
      ["rejected", "rejected"],
      ["timeout", "timeout"],
      ["refused", "unavailable"],
    ] as const) {
      const link = linkAnswering((payload) => ({
        approvalId: payload.approvalId,
        argsHash: payload.argsHash,
        decision: answered,
      }));
      expect(await askShellApproval(link, ASK)).toEqual({ decision: expected });
    }
  });

  it("leaves a Shell too old to ask, or no link at all, refused as before", async () => {
    const unsupported = {
      call: vi.fn(async () => {
        throw Object.assign(new Error("No handler"), { code: "UNSUPPORTED" });
      }),
    };
    expect(await askShellApproval(unsupported, ASK)).toEqual({ decision: "unavailable" });
    expect(await askShellApproval(null, ASK)).toEqual({ decision: "unavailable" });
  });

  it("reads a lost answer as nobody having answered in time", async () => {
    const lost = {
      call: vi.fn(async () => {
        throw Object.assign(new Error("lost"), { code: "OUTCOME_UNKNOWN" });
      }),
    };
    expect(await askShellApproval(lost, ASK)).toEqual({ decision: "timeout" });
  });
});
