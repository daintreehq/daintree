import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalArgsHash } from "../../../services/mcp-server/sessionDedup.js";
import {
  HostCallRuntime,
  type ObservedHost,
  type OpenRun,
  type RelayApprovalQuestion,
} from "../HostCallRuntime.js";
import type { McpCallAnswer, RelayApproveAnswer, RelayApprovePayload } from "../linkMethods.js";
import {
  MCP_REMOTE_CONFIRM_MARGIN_MS,
  MCP_REMOTE_DISPATCH_TIMEOUT_MS,
} from "../../../../shared/config/mcpConfirmWindow.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const HOST: ObservedHost = {
  hostId: "studio",
  name: "studio-01",
  connection: { status: "disconnected" },
  lastSeenAt: null,
  summary: null,
};

const DONE: McpCallAnswer = {
  status: "done",
  result: { isError: false, structured: {}, text: null },
};

function ask(overrides: Partial<RelayApprovePayload> = {}): RelayApprovePayload {
  const actionId = overrides.actionId ?? "worktree.delete";
  const args = overrides.args ?? { worktreeId: "/wt/feature" };
  return {
    approvalId: "approval-1",
    helpSessionId: "a",
    callId: "call-unset",
    projectId: "proj-2",
    actionId,
    args,
    argsHash: canonicalArgsHash(actionId, args),
    lines: ["No uncommitted changes."],
    ...overrides,
  };
}

describe("HostCallRuntime answering a host's approval ask (#13501)", () => {
  let runs: Map<string, OpenRun>;
  let control: Set<string>;
  let asked: RelayApprovalQuestion[];
  let decision: "approved" | "rejected" | "timeout" | null;
  let runtime: HostCallRuntime;
  let duringCall: ((runtime: HostCallRuntime, callId: string) => Promise<unknown>) | undefined;
  let answers: RelayApproveAnswer[];
  // This Shell's own preference for the asking assistant (#15698), and what read it.
  let skips: boolean | Error;
  let skipReads: string[];
  let skipNotes: number;

  beforeEach(() => {
    skips = false;
    skipReads = [];
    skipNotes = 0;
    runs = new Map([["a", RUN_A]]);
    control = new Set(["studio"]);
    asked = [];
    decision = "approved";
    answers = [];
    duringCall = undefined;
    const lanes = new Map<string, { projectId: string; slot: number }>([
      ["a", { projectId: "proj-1", slot: 0 }],
    ]);
    let ids = 0;
    runtime = new HostCallRuntime({
      getSessionLane: (id) => lanes.get(id) ?? null,
      callerRun: (id) => runs.get(id) ?? null,
      client: () =>
        ({
          relayCall: vi.fn(async (_hostId: string, payload: { callId: string }) => {
            if (duringCall) {
              answers.push((await duringCall(runtime, payload.callId)) as RelayApproveAnswer);
            }
            return DONE;
          }),
        }) as never,
      hosts: () => [HOST],
      inLocalView: () => true,
      controlEnabled: (hostId) => control.has(hostId),
      askApproval: async (question) => {
        asked.push(question);
        return decision;
      },
      confirmationsSkipped: (helpSessionId) => {
        skipReads.push(helpSessionId);
        if (skips instanceof Error) throw skips;
        return skips;
      },
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    });
  });

  const deleteCallWith = (callId: string) =>
    runtime.call(
      "a",
      {
        hostId: "studio",
        projectId: "proj-2",
        tool: "worktree.delete",
        args: { worktreeId: "/wt/feature" },
        callId,
      },
      { tier: "full" }
    );

  const deleteCall = (
    tool = "worktree.delete",
    args: Record<string, unknown> = { worktreeId: "/wt/feature" }
  ) =>
    runtime.call(
      "a",
      { hostId: "studio", projectId: "proj-2", tool, args },
      { tier: "full", noteSkipPreference: () => (skipNotes += 1) }
    );

  it("asks the person about exactly the call in flight, and echoes the ask in its answer", async () => {
    duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));

    await deleteCall();

    expect(asked).toEqual([
      {
        hostId: "studio",
        helpSessionId: "a",
        actionId: "worktree.delete",
        args: { worktreeId: "/wt/feature" },
        lines: ["No uncommitted changes."],
      },
    ]);
    expect(answers).toEqual([
      { approvalId: "approval-1", argsHash: ask().argsHash, decision: "approved" },
    ]);
  });

  describe("inside the wait the host names (#15699)", () => {
    it("holds the dialog inside it, measured from when the ask arrived", async () => {
      let arrived = 0;
      duringCall = (r, callId) => {
        arrived = Date.now();
        return r.receiveApproval("studio", { ...ask({ callId }), holdBudgetMs: 200_000 });
      };

      await deleteCall();
      const after = Date.now();

      const holdUntil = asked[0]!.holdUntil!;
      expect(holdUntil).toBeGreaterThanOrEqual(arrived + 200_000 - MCP_REMOTE_CONFIRM_MARGIN_MS);
      expect(holdUntil).toBeLessThanOrEqual(after + 200_000 - MCP_REMOTE_CONFIRM_MARGIN_MS);
    });

    it("never holds it longer than a whole confirmation, whatever a host names", async () => {
      duringCall = (r, callId) =>
        r.receiveApproval("studio", {
          ...ask({ callId }),
          holdBudgetMs: 10 * MCP_REMOTE_DISPATCH_TIMEOUT_MS,
        });

      await deleteCall();

      expect(asked[0]!.holdUntil! - Date.now()).toBeLessThanOrEqual(
        MCP_REMOTE_DISPATCH_TIMEOUT_MS - MCP_REMOTE_CONFIRM_MARGIN_MS
      );
    });

    it("names no hold for a host too old to say, so the dialog keeps the plain deadline", async () => {
      duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));

      await deleteCall();

      expect(asked[0]).not.toHaveProperty("holdUntil");
    });
  });

  it("asks about an owned delete as the plain delete the host runs on the same id", async () => {
    duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));

    await deleteCall("worktree.deleteOwned");

    expect(answers[0]?.decision).toBe("approved");
  });

  it("asks once per call: a second ask about the same call is refused", async () => {
    duringCall = async (r, callId) => {
      await r.receiveApproval("studio", ask({ callId }));
      return r.receiveApproval("studio", ask({ callId, approvalId: "approval-2" }));
    };

    await deleteCall();

    expect(asked).toHaveLength(1);
    expect(answers).toEqual([
      { approvalId: "approval-2", argsHash: ask().argsHash, decision: "refused" },
    ]);
  });

  it("refuses an ask that isn't about a call of its own in flight, without asking anyone", async () => {
    const mismatches = (callId: string): RelayApprovePayload[] => [
      ask({ callId: "someone-elses-call" }),
      ask({ callId, helpSessionId: "b" }),
      ask({ callId, projectId: "proj-9" }),
      ask({ callId, args: { worktreeId: "/wt/other" } }),
      ask({ callId, args: { worktreeId: "/wt/feature", force: true } }),
      ask({ callId, argsHash: "0".repeat(64) }),
      ask({ callId, actionId: "terminal.close", args: { terminalId: "t-1" } }),
    ];
    duringCall = async (r, callId) => {
      for (const payload of mismatches(callId)) {
        answers.push(await r.receiveApproval("studio", payload));
      }
      return r.receiveApproval("elsewhere", ask({ callId }));
    };

    await deleteCall();

    expect(asked).toEqual([]);
    expect(answers.map((answer) => answer.decision)).toEqual(new Array(8).fill("refused"));
  });

  it("keeps the ask good when the same call is resent while the person decides", async () => {
    let resent: Promise<unknown> | undefined;
    let resending = false;
    duringCall = async (r, callId) => {
      // The resend's own send arrives here too, possibly before it returns.
      if (resending) return { decision: "skipped" };
      resending = true;
      resent = deleteCallWith(callId);
      return r.receiveApproval("studio", ask({ callId }));
    };

    await deleteCall();
    await resent;

    expect(answers.find((answer) => answer.approvalId === "approval-1")?.decision).toBe("approved");
  });

  it("refuses once the call has settled", async () => {
    const settled = await deleteCall();
    if (!settled.ok) throw new Error("refused");

    const late = await runtime.receiveApproval("studio", ask({ callId: settled.value.callId! }));

    expect(late.decision).toBe("refused");
    expect(asked).toEqual([]);
  });

  it("refuses with the person's control switch off, or once the run that asked is replaced", async () => {
    duringCall = async (r, callId) => {
      control.delete("studio");
      const off = await r.receiveApproval("studio", ask({ callId }));
      control.add("studio");
      runs.set("a", { ...RUN_A, launchGeneration: 2 });
      answers.push(off);
      return r.receiveApproval("studio", ask({ callId, approvalId: "approval-2" }));
    };

    await deleteCall();

    expect(answers.map((answer) => answer.decision)).toEqual(["refused", "refused"]);
    expect(asked).toEqual([]);
  });

  it("withdraws an approval the person gave after the call's run was replaced", async () => {
    duringCall = async (r, callId) => {
      const pending = r.receiveApproval("studio", ask({ callId }));
      runs.set("a", { ...RUN_A, launchGeneration: 2 });
      return pending;
    };

    await deleteCall();

    expect(asked).toHaveLength(1);
    expect(answers[0]?.decision).toBe("refused");
  });

  it("passes a decline or a missed dialog through, and refuses when no window could ask", async () => {
    const decisions: Array<typeof decision> = ["rejected", "timeout", null];
    for (const next of decisions) {
      decision = next;
      duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));
      answers = [];
      await deleteCall();
      expect(answers[0]?.decision).toBe(next ?? "refused");
    }
  });
  describe("under the asking assistant's own Never ask on this Shell (#15698)", () => {
    it("answers a host's ask about its own call as a skip, asking nobody, and notes it on the call", async () => {
      skips = true;
      duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));

      await deleteCall("worktree.deleteOwned");

      expect(asked).toEqual([]);
      expect(skipReads).toEqual(["a"]);
      expect(answers).toEqual([
        { approvalId: "approval-1", argsHash: ask().argsHash, decision: "skip-preference" },
      ]);
      expect(skipNotes).toBe(1);
    });

    it("still asks under Always ask, or when the preference can't be read", async () => {
      for (const next of [false, new Error("store unreadable")]) {
        skips = next;
        asked = [];
        answers = [];
        duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));
        await deleteCall();
        expect(asked).toHaveLength(1);
        expect(answers[0]?.decision).toBe("approved");
      }
      expect(skipNotes).toBe(0);
    });

    it("never turns a host's ask about some other call into a skip", async () => {
      skips = true;
      duringCall = async (r, callId) => {
        answers.push(await r.receiveApproval("studio", ask({ callId: "someone-elses-call" })));
        answers.push(await r.receiveApproval("studio", ask({ callId, helpSessionId: "b" })));
        answers.push(
          await r.receiveApproval("studio", ask({ callId, args: { worktreeId: "/wt/other" } }))
        );
        return r.receiveApproval("elsewhere", ask({ callId }));
      };

      await deleteCall();

      expect(answers.map((answer) => answer.decision)).toEqual(new Array(4).fill("refused"));
      expect(skipReads).toEqual([]);
      expect(skipNotes).toBe(0);
    });

    describe("a host's dispatch into this Shell's view", () => {
      const dispatch = (
        callId: string,
        overrides: Partial<Parameters<HostCallRuntime["skipsRelayedDispatch"]>[1]> = {}
      ) => ({
        callId,
        helpSessionId: "a",
        projectId: "proj-2",
        actionId: "worktree.delete",
        args: { worktreeId: "/wt/feature" } as unknown,
        ...overrides,
      });
      let verdicts: boolean[];
      const during = (check: (r: HostCallRuntime, callId: string) => void) => {
        verdicts = [];
        duringCall = async (r, callId) => {
          check(r, callId);
          return { decision: "unused" };
        };
      };

      it("skips exactly the call out to that host, for the action an owned tool stands in for", async () => {
        skips = true;
        during((r, callId) => verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId))));

        await deleteCall("worktree.deleteOwned");

        expect(verdicts).toEqual([true]);
        expect(skipNotes).toBe(1);
      });

      it("skips once per call: a second dispatch of the same call asks", async () => {
        skips = true;
        during((r, callId) => {
          verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId)));
          verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId)));
        });

        await deleteCall("worktree.deleteOwned");

        expect(verdicts).toEqual([true, false]);
        expect(skipNotes).toBe(1);
      });

      it("rebuilds an owned tool's delegate from its id and the fields it forwards, nothing else", async () => {
        skips = true;
        const restart = (callId: string, args: Record<string, unknown>) =>
          dispatch(callId, { actionId: "terminal.restartOnPreset", args });
        during((r, callId) => {
          for (const args of [
            { terminalId: "t-9", presetId: "other" },
            { terminalId: "t-9" },
            { terminalId: "t-9", presetId: "p-1", extra: "x" },
            { terminalId: "t-8", presetId: "p-1" },
            { terminalId: "t-9", presetId: "p-1" },
          ]) {
            verdicts.push(r.skipsRelayedDispatch("studio", restart(callId, args)));
          }
        });

        await deleteCall("terminal.restartOnPresetOwned", {
          terminalId: "t-9",
          presetId: "p-1",
          extra: "dropped by the host",
        });

        expect(verdicts).toEqual([false, false, false, false, true]);
      });

      it("rebuilds an owned tool that delegates to itself, never matching what the host dropped", async () => {
        skips = true;
        const place = (callId: string, args: Record<string, unknown>) =>
          dispatch(callId, { actionId: "terminal.placeOwned", args });
        during((r, callId) => {
          verdicts.push(
            r.skipsRelayedDispatch(
              "studio",
              place(callId, { terminalId: "t-9", location: "dock", recipeId: "extra" })
            )
          );
          verdicts.push(
            r.skipsRelayedDispatch("studio", place(callId, { terminalId: "t-9", location: "dock" }))
          );
        });

        await deleteCall("terminal.placeOwned", {
          terminalId: "t-9",
          location: "dock",
          recipeId: "extra",
        });

        expect(verdicts).toEqual([false, true]);
      });

      it("notes the skip on every send of the call still out", async () => {
        skips = true;
        let resendNotes = 0;
        let resendOut!: () => void;
        const resendSent = new Promise<void>((resolve) => (resendOut = resolve));
        let releaseResend!: () => void;
        const resendHeld = new Promise<void>((resolve) => (releaseResend = resolve));
        let resent: Promise<unknown> | undefined;
        let resending = false;
        verdicts = [];
        duringCall = async (r, callId) => {
          if (resending) {
            resendOut();
            await resendHeld;
            return { decision: "unused" };
          }
          resending = true;
          resent = r.call(
            "a",
            {
              hostId: "studio",
              projectId: "proj-2",
              tool: "worktree.deleteOwned",
              args: { worktreeId: "/wt/feature" },
              callId,
            },
            { tier: "full", noteSkipPreference: () => (resendNotes += 1) }
          );
          await resendSent;
          verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId)));
          releaseResend();
          return { decision: "unused" };
        };

        await deleteCall("worktree.deleteOwned");
        await resent;

        expect(verdicts).toEqual([true]);
        expect(skipNotes).toBe(1);
        expect(resendNotes).toBe(1);
      });

      describe("a resend's own record", () => {
        const send = (
          callId: string | undefined,
          note: () => void,
          args: Record<string, unknown> = { worktreeId: "/wt/feature" }
        ) =>
          runtime.call(
            "a",
            {
              hostId: "studio",
              projectId: "proj-2",
              tool: "worktree.deleteOwned",
              args,
              ...(callId !== undefined ? { callId } : {}),
            },
            { tier: "full", noteSkipPreference: note }
          );
        // The first send's relay runs `first`; every later send's waits on `held`.
        let held: Promise<void>;
        let release: () => void;
        let laterOut: () => void;
        let laterSent: Promise<void>;
        const relayWith = (first: (r: HostCallRuntime, callId: string) => Promise<void>) => {
          held = new Promise((resolve) => (release = resolve));
          laterSent = new Promise((resolve) => (laterOut = resolve));
          let started = false;
          duringCall = async (r, callId) => {
            if (started) {
              laterOut();
              await held;
            } else {
              started = true;
              await first(r, callId);
            }
            return { decision: "unused" };
          };
        };

        it("is told of a skip granted before it joined the call", async () => {
          skips = true;
          let joined = 0;
          let resent: Promise<unknown> | undefined;
          relayWith(async (r, callId) => {
            expect(r.skipsRelayedDispatch("studio", dispatch(callId))).toBe(true);
            resent = send(callId, () => (joined += 1));
            await laterSent;
            release();
          });

          await deleteCall("worktree.deleteOwned");
          await resent;

          expect(skipNotes).toBe(1);
          expect(joined).toBe(1);
        });

        it("is never told for another call sent under the same id", async () => {
          skips = true;
          let other = 0;
          let resent: Promise<unknown> | undefined;
          relayWith(async (r, callId) => {
            // Any difference the host's ledger sees refuses it as a conflict, a request key's too.
            resent = send(callId, () => (other += 1), {
              worktreeId: "/wt/feature",
              requestKey: "rk-2",
            });
            await laterSent;
            expect(r.skipsRelayedDispatch("studio", dispatch(callId))).toBe(true);
            release();
          });

          await deleteCall("worktree.deleteOwned");
          await resent;

          expect(skipNotes).toBe(1);
          expect(other).toBe(0);
        });

        it("goes with its send: one that settled is told nothing, the one still out is", async () => {
          skips = true;
          // One callback for both sends, so only each send's own entry tells them apart.
          let noted = 0;
          const note = () => (noted += 1);
          let callIdOut = "";
          let resent: Promise<unknown> | undefined;
          relayWith(async (_r, callId) => {
            callIdOut = callId;
            resent = send(callId, note);
            await laterSent;
          });

          await send(undefined, note);
          expect(runtime.skipsRelayedDispatch("studio", dispatch(callIdOut))).toBe(true);
          release();
          await resent;

          expect(noted).toBe(1);
        });
      });

      it("skips a direct call's own action with the arguments it was sent", async () => {
        skips = true;
        during((r, callId) =>
          verdicts.push(
            r.skipsRelayedDispatch(
              "studio",
              dispatch(callId, { args: { worktreeId: "/wt/feature", force: true } })
            )
          )
        );

        await deleteCall("worktree.delete", {
          worktreeId: "/wt/feature",
          force: true,
          requestKey: "rk-1",
        });

        expect(verdicts).toEqual([true]);
      });

      it("asks for anything that isn't that call, or with the skip off", async () => {
        skips = true;
        during((r, callId) => {
          for (const candidate of [
            dispatch("someone-elses-call"),
            dispatch(callId, { helpSessionId: "b" }),
            dispatch(callId, { projectId: "proj-9" }),
            dispatch(callId, { args: { worktreeId: "/wt/other" } }),
            // An owned delete never carries more than the id.
            dispatch(callId, { args: { worktreeId: "/wt/feature", force: true } }),
            dispatch(callId, { actionId: "terminal.close", args: { terminalId: "t-1" } }),
            dispatch(callId, { args: null }),
          ]) {
            verdicts.push(r.skipsRelayedDispatch("studio", candidate));
          }
          verdicts.push(r.skipsRelayedDispatch("elsewhere", dispatch(callId)));
          skips = false;
          verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId)));
          skips = new Error("store unreadable");
          verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId)));
        });

        await deleteCall("worktree.deleteOwned");

        expect(verdicts).toEqual(new Array(10).fill(false));
        expect(skipNotes).toBe(0);
      });

      it("asks with the control switch off or the asking run replaced, and once the call settles", async () => {
        skips = true;
        during((r, callId) => {
          control.delete("studio");
          verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId)));
          control.add("studio");
          runs.set("a", { ...RUN_A, launchGeneration: 2 });
          verdicts.push(r.skipsRelayedDispatch("studio", dispatch(callId)));
        });

        const settled = await deleteCall("worktree.deleteOwned");
        if (!settled.ok) throw new Error("refused");
        runs.set("a", RUN_A);
        verdicts.push(runtime.skipsRelayedDispatch("studio", dispatch(settled.value.callId!)));

        expect(verdicts).toEqual([false, false, false]);
      });

      it.each(["host.switch", "project.openOnHost"])(
        "always asks before %s moves this window",
        async (actionId) => {
          skips = true;
          during((r, callId) =>
            verdicts.push(
              r.skipsRelayedDispatch("studio", dispatch(callId, { actionId, args: {} }))
            )
          );

          await deleteCall(actionId, {});

          expect(verdicts).toEqual([false]);
        }
      );
    });
  });
});
