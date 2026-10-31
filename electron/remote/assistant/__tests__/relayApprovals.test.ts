import { describe, expect, it, vi } from "vitest";
import { canonicalArgsHash } from "../../../services/mcp-server/sessionDedup.js";
import { askShellApproval, type RelayApprovalAsk } from "../relayApprovals.js";
import {
  AssistantLinkMethod,
  RelayApprovePayloadSchema,
  RelayApproveTimedPayloadSchema,
} from "../linkMethods.js";
import {
  MCP_CONFIRM_ASK_MAX_MS,
  MCP_DISPATCH_TIMEOUT_MS,
  MCP_REMOTE_CONFIRM_MARGIN_MS,
} from "../../../../shared/config/mcpConfirmWindow.js";
import { relayRunMs } from "../HostCallRuntime.js";

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
    // Asked the timed way, saying how long it waits (#15699).
    expect(method).toBe(AssistantLinkMethod.RELAY_APPROVE_TIMED);
    expect(RelayApproveTimedPayloadSchema.parse(payload)).toEqual({
      approvalId: "approval-1",
      helpSessionId: "help-1",
      callId: "call-1",
      projectId: "project-1",
      actionId: "worktree.delete",
      args: { worktreeId: "/repo-wt/feature" },
      argsHash: HASH,
      subject: "feature/thing",
      lines: ["No uncommitted changes."],
      holdBudgetMs: 40_000,
    });
  });

  describe("a Shell too old to be told the wait (#15699)", () => {
    // Refuses the timed ask with `timedError` and approves anything asked the plain way.
    function olderShell(timedError: string, onTimed: () => void = () => {}) {
      return {
        call: vi.fn(async (method: string, payload: unknown, _options: { timeoutMs: number }) => {
          if (method === AssistantLinkMethod.RELAY_APPROVE_TIMED) {
            onTimed();
            throw Object.assign(new Error("refused"), { code: timedError });
          }
          const asked = payload as Record<string, unknown>;
          return { approvalId: asked.approvalId, argsHash: asked.argsHash, decision: "approved" };
        }),
      };
    }

    it("is asked the plain way, with only what is left of the wait", async () => {
      let clock = 1_000;
      const link = olderShell("UNSUPPORTED", () => {
        clock = 3_000;
      });

      const decision = await askShellApproval(link, ASK, {
        now: () => clock,
        newId: () => "approval-1",
        windowMs: 100_000,
      });

      expect(decision).toEqual({ decision: "approved", deadline: 3_000 + MCP_DISPATCH_TIMEOUT_MS });
      const [method, payload, options] = link.call.mock.calls[1]!;
      expect(method).toBe(AssistantLinkMethod.RELAY_APPROVE);
      // The plain payload an older Shell's strict schema takes.
      expect(RelayApprovePayloadSchema.safeParse(payload).success).toBe(true);
      expect(options.timeoutMs).toBe(98_000);
    });

    it("isn't asked once too little is left for the plain deadline it holds its dialog to", async () => {
      let clock = 1_000;
      const link = olderShell("UNSUPPORTED", () => {
        clock = 1_001;
      });
      const leastAsked = MCP_DISPATCH_TIMEOUT_MS + MCP_REMOTE_CONFIRM_MARGIN_MS;

      await expect(
        askShellApproval(link, ASK, { now: () => clock, windowMs: leastAsked })
      ).resolves.toEqual({ decision: "timeout" });
      expect(link.call).toHaveBeenCalledTimes(1);
    });

    it("is still asked with exactly the plain deadline and its margin left", async () => {
      let clock = 1_000;
      const leastAsked = MCP_DISPATCH_TIMEOUT_MS + MCP_REMOTE_CONFIRM_MARGIN_MS;
      const link = olderShell("UNSUPPORTED", () => {
        clock = 1_001;
      });

      await expect(
        askShellApproval(link, ASK, { now: () => clock, windowMs: leastAsked + 1 })
      ).resolves.toMatchObject({ decision: "approved" });
      expect(link.call.mock.calls[1]![2].timeoutMs).toBe(leastAsked);
    });

    it.each([
      ["OUTCOME_UNKNOWN", "timeout"],
      ["HOST_DISCONNECTED", "unavailable"],
      ["VALIDATION", "unavailable"],
    ])(
      "is never asked again after the timed ask fails any other way (%s)",
      async (code, decision) => {
        const link = olderShell(code);

        await expect(askShellApproval(link, ASK)).resolves.toEqual({ decision });
        // The timed ask may have reached the Shell: asking again could ask the person twice.
        expect(link.call).toHaveBeenCalledTimes(1);
      }
    );
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
    const answering = (decision: string, onAsk: () => void) =>
      linkAnswering((payload) => {
        onAsk();
        return { approvalId: payload.approvalId, argsHash: payload.argsHash, decision };
      });
    const covering = (decision: "approved" | "skip-preference", deadline: number) =>
      decision === "approved"
        ? { decision: "approved", deadline }
        : { decision: "approved", deadline, authorization: "skip-preference" };

    it("waits out a whole confirmation at the Shell, with room for the answer to come back", async () => {
      const link = answering("approved", () => {});

      await askShellApproval(link, ASK);

      const [, payload, options] = link.call.mock.calls[0] as unknown as [
        string,
        { holdBudgetMs: number },
        { timeoutMs: number },
      ];
      expect(options.timeoutMs - MCP_REMOTE_CONFIRM_MARGIN_MS).toBeGreaterThanOrEqual(
        MCP_CONFIRM_ASK_MAX_MS
      );
      // And inside the deadline of the call it asks for, with room for that answer too.
      expect(options.timeoutMs).toBeLessThanOrEqual(
        relayRunMs("worktree.delete", {}) - MCP_REMOTE_CONFIRM_MARGIN_MS
      );
      expect(payload.holdBudgetMs).toBe(options.timeoutMs);
    });

    it.each(["approved", "skip-preference"] as const)(
      "covers a run from when an answer minutes later came (%s)",
      async (answered) => {
        let clock = 0;
        const link = answering(answered, () => {
          clock = 200_000;
        });

        await expect(askShellApproval(link, ASK, { now: () => clock })).resolves.toEqual(
          covering(answered, 200_000 + MCP_DISPATCH_TIMEOUT_MS)
        );
      }
    );

    it.each(["approved", "skip-preference"] as const)(
      "ends inside the call's own wait, and covers nothing past it (%s)",
      async (answered) => {
        let clock = 0;
        const link = answering(answered, () => {
          clock = 95_000;
        });

        await expect(
          askShellApproval(link, { ...ASK, holdUntil: 100_000 }, { now: () => clock })
        ).resolves.toEqual(covering(answered, 100_000));
        const [, payload, options] = link.call.mock.calls[0] as unknown as [
          string,
          Record<string, unknown>,
          { timeoutMs: number },
        ];
        expect(options.timeoutMs).toBe(100_000);
        expect(payload.holdBudgetMs).toBe(100_000);
        // The host's own clock never crosses the link.
        expect(payload).not.toHaveProperty("holdUntil");
      }
    );

    it.each(["approved", "skip-preference"] as const)(
      "refuses an answer that comes after the call stopped waiting (%s)",
      async (answered) => {
        let clock = 0;
        const link = answering(answered, () => {
          clock = 100_001;
        });

        await expect(
          askShellApproval(link, { ...ASK, holdUntil: 100_000 }, { now: () => clock })
        ).resolves.toEqual({ decision: "timeout" });
      }
    );

    it("asks nothing once the call has stopped waiting", async () => {
      const link = answering("approved", () => {});

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
