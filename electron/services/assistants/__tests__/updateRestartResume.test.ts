import { describe, expect, it, vi } from "vitest";
import { assistantSlotKey } from "../../../../shared/config/assistantSlots.js";
import type { AssistantLaunchRequest, AssistantLaunchResult } from "../assistantLaunch.js";
import { resumeLanesAfterUpdate, type UpdateRestartResumeDeps } from "../updateRestartResume.js";

type Pointer = { agentId: string; agentSessionId: string; cwd: string };

function harness(pointers: Record<string, Pointer>) {
  let claims = 0;
  const held = new Map<string, string>();
  const deps = {
    claim: vi.fn(async (projectId: string, slot: number) => {
      const key = assistantSlotKey(projectId, slot);
      const pointer = pointers[key];
      if (!pointer || held.has(key)) return null;
      const claimId = `claim-${++claims}`;
      held.set(key, claimId);
      return { ...pointer, claimId };
    }),
    release: vi.fn(async (projectId: string, slot: number, claimId: string) => {
      const key = assistantSlotKey(projectId, slot);
      if (held.get(key) === claimId) held.delete(key);
    }),
    start: vi.fn(async (request: AssistantLaunchRequest): Promise<AssistantLaunchResult> => ({
      status: "started",
      sessionId: `session-${request.slot}`,
      terminalId: `terminal-${request.slot}`,
      slot: request.slot!,
      agentId: request.agentId!,
      ready: true,
      notReadyReason: null,
    })),
    isShuttingDown: vi.fn(() => false),
  } satisfies UpdateRestartResumeDeps;
  return { deps, held };
}

const pointer = (agentSessionId: string, agentId = "claude"): Pointer => ({
  agentId,
  agentSessionId,
  cwd: `/sessions/${agentId}`,
});

describe("resumeLanesAfterUpdate (#16753)", () => {
  it("resumes every recorded lane into the conversation it ran, on its agent, with no view", async () => {
    const lanes = {
      [assistantSlotKey("p1", 0)]: "conv-0",
      [assistantSlotKey("p1", 2)]: "conv-2",
      [assistantSlotKey("p2", 1)]: "thread-1",
    };
    const { deps, held } = harness({
      [assistantSlotKey("p1", 0)]: pointer("conv-0"),
      [assistantSlotKey("p1", 2)]: pointer("conv-2"),
      [assistantSlotKey("p2", 1)]: pointer("thread-1", "codex"),
    });

    const outcomes = await resumeLanesAfterUpdate({ recordedAt: 1, lanes }, deps);

    expect(outcomes.filter((outcome) => outcome.status === "resumed")).toHaveLength(3);
    const requests = deps.start.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(3);
    expect(requests).toContainEqual(
      expect.objectContaining({
        projectId: "p2",
        slot: 1,
        agentId: "codex",
        startedBy: { kind: "update-restart" },
        resume: { agentSessionId: "thread-1", cwd: "/sessions/codex" },
      })
    );
    expect(held.size).toBe(0);
  });

  it("leaves down a lane that moved on, one a view holds, and one that has nothing left", async () => {
    const lanes = {
      [assistantSlotKey("p1", 0)]: "conv-0",
      [assistantSlotKey("p1", 1)]: "conv-1",
      [assistantSlotKey("p1", 2)]: "conv-2",
    };
    const { deps, held } = harness({
      // Discarded and relaunched since the quit recorded it.
      [assistantSlotKey("p1", 0)]: pointer("conv-0-new"),
      [assistantSlotKey("p1", 1)]: pointer("conv-1"),
    });
    held.set(assistantSlotKey("p1", 1), "a-view's-claim");

    const outcomes = await resumeLanesAfterUpdate({ recordedAt: 1, lanes }, deps);

    expect(deps.start).not.toHaveBeenCalled();
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { projectId: "p1", slot: 0, status: "skipped", reason: "moved-on" },
        { projectId: "p1", slot: 1, status: "skipped", reason: "unclaimed" },
        { projectId: "p1", slot: 2, status: "skipped", reason: "unclaimed" },
      ])
    );
    // Its own claim went back; the view's is untouched.
    expect([...held]).toEqual([[assistantSlotKey("p1", 1), "a-view's-claim"]]);
  });

  it("gives the claim back when a start is refused or throws, so the lane can be resumed by hand", async () => {
    const lanes = {
      [assistantSlotKey("p1", 0)]: "conv-0",
      [assistantSlotKey("p1", 1)]: "conv-1",
    };
    const { deps, held } = harness({
      [assistantSlotKey("p1", 0)]: pointer("conv-0"),
      [assistantSlotKey("p1", 1)]: pointer("conv-1"),
    });
    deps.start.mockImplementation(async (request) => {
      if (request.slot === 0) return { status: "refused", reason: "no-slot" };
      throw new Error("spawn exploded");
    });

    const outcomes = await resumeLanesAfterUpdate({ recordedAt: 1, lanes }, deps);

    expect(outcomes).toEqual(
      expect.arrayContaining([
        { projectId: "p1", slot: 0, status: "refused", reason: "no-slot" },
        { projectId: "p1", slot: 1, status: "refused", reason: "launch-failed" },
      ])
    );
    expect(held.size).toBe(0);
  });

  it("starts nothing more once a quit begins, and asks again right before each spawn", async () => {
    const lanes = Object.fromEntries(
      [0, 1, 2, 3].map((slot) => [assistantSlotKey("p1", slot), `conv-${slot}`])
    );
    const { deps } = harness(
      Object.fromEntries(
        [0, 1, 2, 3].map((slot) => [assistantSlotKey("p1", slot), pointer(`conv-${slot}`)])
      )
    );
    let quitting = false;
    deps.isShuttingDown.mockImplementation(() => quitting);
    deps.start.mockImplementation(async (request) => {
      quitting = true;
      expect(request.stillWanted?.()).toBe(false);
      return { status: "refused", reason: "launch-failed" };
    });

    const outcomes = await resumeLanesAfterUpdate({ recordedAt: 1, lanes }, deps);

    // The lanes already under way when the quit began; none after.
    expect(deps.start.mock.calls.length).toBeLessThanOrEqual(3);
    expect(outcomes.filter((outcome) => outcome.status === "skipped")).not.toHaveLength(0);
    expect(
      outcomes.every(
        (outcome) => outcome.status !== "skipped" || outcome.reason === "shutting-down"
      )
    ).toBe(true);
  });

  it("runs at most three starts at once", async () => {
    const slots = [0, 1, 2, 3, 4];
    const lanes = Object.fromEntries(
      slots.map((slot) => [assistantSlotKey(`p${slot}`, 0), `conv-${slot}`])
    );
    const { deps } = harness(
      Object.fromEntries(
        slots.map((slot) => [assistantSlotKey(`p${slot}`, 0), pointer(`conv-${slot}`)])
      )
    );
    let inFlight = 0;
    let peak = 0;
    const base = deps.start.getMockImplementation()!;
    deps.start.mockImplementation(async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return base(request);
    });

    const outcomes = await resumeLanesAfterUpdate({ recordedAt: 1, lanes }, deps);

    expect(outcomes.filter((outcome) => outcome.status === "resumed")).toHaveLength(5);
    expect(peak).toBe(3);
  });
});
