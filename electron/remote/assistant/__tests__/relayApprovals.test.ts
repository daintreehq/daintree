import { describe, expect, it, vi } from "vitest";
import { canonicalArgsHash } from "../../../services/mcp-server/sessionDedup.js";
import { askShellApproval, type RelayApprovalAsk } from "../relayApprovals.js";
import { AssistantLinkMethod, RelayApprovePayloadSchema } from "../linkMethods.js";
import {
  MCP_CONFIRM_ASK_MAX_MS,
  MCP_DISPATCH_TIMEOUT_MS,
} from "../../../../shared/config/mcpConfirmWindow.js";

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

    // Covered for the run an approval buys, from when it came (#15699).
    expect(decision).toEqual({ decision: "approved", deadline: 1_000 + MCP_DISPATCH_TIMEOUT_MS });
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

  it("takes the Shell's own Never ask as covering the call, marked as the skip it is (#15698)", async () => {
    let clock = 1_000;
    const skipped = (payload: Record<string, unknown>) => ({
      approvalId: payload.approvalId,
      argsHash: payload.argsHash,
      decision: "skip-preference",
    });

    await expect(
      askShellApproval(linkAnswering(skipped), ASK, { now: () => clock, windowMs: 40_000 })
    ).resolves.toEqual({
      decision: "approved",
      deadline: 1_000 + MCP_DISPATCH_TIMEOUT_MS,
      authorization: "skip-preference",
    });

    // Bound to the ask like any answer, and covering nothing once late.
    await expect(
      askShellApproval(
        linkAnswering((payload) => ({ ...skipped(payload), approvalId: "someone-else" })),
        ASK
      )
    ).resolves.toEqual({ decision: "unavailable" });
    const late = linkAnswering((payload) => {
      clock = 42_000;
      return skipped(payload);
    });
    clock = 1_000;
    await expect(
      askShellApproval(late, ASK, { now: () => clock, windowMs: 40_000 })
    ).resolves.toEqual({ decision: "timeout" });
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

  describe("how long it waits (#15699)", () => {
    const approving = (onAsk: () => void) =>
      linkAnswering((payload) => {
        onAsk();
        return { approvalId: payload.approvalId, argsHash: payload.argsHash, decision: "approved" };
      });

    it("waits out a whole confirmation at the Shell, so an answer minutes later still runs", async () => {
      let clock = 0;
      const link = approving(() => {
        clock = 200_000;
      });

      const decision = await askShellApproval(link, ASK, { now: () => clock });

      expect(decision).toEqual({
        decision: "approved",
        deadline: 200_000 + MCP_DISPATCH_TIMEOUT_MS,
      });
      const [, , options] = link.call.mock.calls[0] as unknown as [
        string,
        unknown,
        { timeoutMs: number },
      ];
      expect(options.timeoutMs).toBeGreaterThan(MCP_CONFIRM_ASK_MAX_MS);
    });

    it("ends inside the call's own wait, and covers nothing past it", async () => {
      let clock = 0;
      const link = approving(() => {
        clock = 95_000;
      });

      const decision = await askShellApproval(
        link,
        { ...ASK, holdUntil: 100_000 },
        {
          now: () => clock,
        }
      );

      expect(decision).toEqual({ decision: "approved", deadline: 100_000 });
      const [, payload, options] = link.call.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
        { timeoutMs: number },
      ];
      expect(options.timeoutMs).toBe(100_000);
      // The host's own clock never crosses the link.
      expect(payload).not.toHaveProperty("holdUntil");
    });

    it("refuses an approval that comes after the call stopped waiting", async () => {
      let clock = 0;
      const link = approving(() => {
        clock = 100_001;
      });

      await expect(
        askShellApproval(link, { ...ASK, holdUntil: 100_000 }, { now: () => clock })
      ).resolves.toEqual({ decision: "timeout" });
    });

    it("asks nothing once the call has stopped waiting", async () => {
      const link = approving(() => {});

      await expect(
        askShellApproval(link, { ...ASK, holdUntil: 1_000 }, { now: () => 1_000 })
      ).resolves.toEqual({ decision: "timeout" });
      expect(link.call).not.toHaveBeenCalled();
    });
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
