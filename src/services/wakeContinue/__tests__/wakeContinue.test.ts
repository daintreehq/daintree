import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequestOptions } from "@/services/agentRequests";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const deliveries = vi.hoisted(
  () => [] as Array<{ options: AgentRequestOptions; settle: () => void }>
);
const cancelAgentRequests = vi.hoisted(() => vi.fn());
vi.mock("@/services/agentRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agentRequests")>()),
  cancelAgentRequests,
  deliverAgentRequest: (options: AgentRequestOptions) =>
    new Promise<void>((resolve) => {
      deliveries.push({
        options,
        settle: () => {
          options.onState({ id: "r", state: { status: "sent" }, title: "", terminalId: null });
          resolve();
        },
      });
    }),
}));

import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useWakeContinueStore } from "@/store/wakeContinueStore";
import type { WakeCandidate } from "../wakeCandidate";
import {
  WAKE_CONTINUE_MAX_IN_FLIGHT,
  WAKE_CONTINUE_SPACING_MS,
  dismissWakeContinue,
  publishWakeCandidates,
  sendWakeContinueNotes,
} from "../wakeContinue";

const RESTORED_AT = 10_000;

function candidate(id: string, outcome: WakeCandidate["outcome"] = "resumed"): WakeCandidate {
  return {
    terminalId: id,
    title: `Agent ${id}`,
    agentId: "claude",
    worktreeId: "wt-1",
    outcome,
    restoredAt: RESTORED_AT,
  };
}

function placePanels(ids: string[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(
      ids.map((id) => [id, { id, location: "grid", worktreeId: "wt-1" }])
    ) as unknown as ReturnType<typeof usePanelStore.getState>["panelsById"],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useProjectStore.setState({
    currentProject: { id: "p1" } as ReturnType<typeof useProjectStore.getState>["currentProject"],
  });
  dispatch.mockResolvedValue({ ok: true, result: { terminals: [] } });
});

afterEach(() => {
  vi.useRealTimers();
  deliveries.length = 0;
  cancelAgentRequests.mockReset();
  dispatch.mockReset();
  useWakeContinueStore.setState({ offer: null, dialogOpen: false });
  usePanelStore.setState({ panelsById: {} });
  useProjectStore.setState({ currentProject: null });
});

describe("publishWakeCandidates", () => {
  it("offers nothing when the restore resumed no agent", () => {
    publishWakeCandidates("p1", [candidate("a", "fresh"), candidate("b", "held")]);
    expect(useWakeContinueStore.getState().offer).toBeNull();
  });

  it("offers every relaunched pane, and a newer restore replaces the offer", () => {
    publishWakeCandidates("p1", [candidate("a"), candidate("b", "fresh")]);
    const first = useWakeContinueStore.getState().offer;
    expect(first?.phase).toBe("offered");
    expect(first?.entries.map((e) => e.terminalId)).toEqual(["a", "b"]);

    publishWakeCandidates("p1", []);
    expect(useWakeContinueStore.getState().offer).toBeNull();
    expect(cancelAgentRequests).toHaveBeenCalledWith(`wake-continue:${first!.id}:`);
  });
});

describe("sendWakeContinueNotes", () => {
  it("sends nothing until asked, and only to resumed agents when asked", async () => {
    placePanels(["a", "b", "c"]);
    publishWakeCandidates("p1", [candidate("a"), candidate("b", "fresh"), candidate("c", "held")]);
    expect(deliveries).toHaveLength(0);

    const run = sendWakeContinueNotes("  Keep going  ");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliveries.map((d) => d.options.destination)).toEqual([
      { kind: "terminal", terminalId: "a", title: "Agent a" },
    ]);
    expect(await deliveries[0]!.options.buildPrompt()).toBe("Keep going");
    deliveries[0]!.settle();
    await run;

    const offer = useWakeContinueStore.getState().offer!;
    expect(offer.phase).toBe("done");
    expect(offer.entries.find((e) => e.terminalId === "a")?.delivery).toEqual({ status: "sent" });
    expect(offer.entries.find((e) => e.terminalId === "b")?.delivery).toBeUndefined();
  });

  it("asks for the agent's prompt, not the default readiness that takes idle", async () => {
    placePanels(["a"]);
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(0);
    const readiness = deliveries[0]!.options.readiness!;
    expect(readiness({ terminalId: "a", agentId: "claude", agentState: "idle" })).toBe("not-yet");
    expect(
      readiness({
        terminalId: "a",
        agentId: "claude",
        agentState: "waiting",
        waitingReason: "prompt",
        lastTransitionAt: 1,
      })
    ).toBe("ready");
  });

  it("keeps a few notes in flight at a time, spaced out", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    placePanels(ids);
    publishWakeCandidates(
      "p1",
      ids.map((id) => candidate(id))
    );
    const run = sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliveries).toHaveLength(WAKE_CONTINUE_MAX_IN_FLIGHT);

    // Each lane takes its next note only after its last settled and a pause.
    deliveries[0]!.settle();
    await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_SPACING_MS - 1);
    expect(deliveries).toHaveLength(WAKE_CONTINUE_MAX_IN_FLIGHT);
    await vi.advanceTimersByTimeAsync(1);
    expect(deliveries).toHaveLength(WAKE_CONTINUE_MAX_IN_FLIGHT + 1);

    // Never more than the cap outstanding, however fast each one settles.
    let settled = 1;
    for (let round = 0; round < ids.length && settled < ids.length; round++) {
      expect(deliveries.length - settled).toBeLessThanOrEqual(WAKE_CONTINUE_MAX_IN_FLIGHT);
      while (settled < deliveries.length) deliveries[settled++]!.settle();
      await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_SPACING_MS);
    }
    await run;
    expect(deliveries.map((d) => d.options.destination.title)).toEqual(
      ids.map((id) => `Agent ${id}`)
    );
  });

  it("refuses a pane typed in after it resumed, or holding a draft", async () => {
    placePanels(["a"]);
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(0);
    const verify = deliveries[0]!.options.verify!;

    dispatch.mockResolvedValue({
      ok: true,
      result: { terminals: [{ terminalId: "a", lastTypedInputAt: RESTORED_AT - 1 }] },
    });
    expect(await verify()).toBeNull();

    dispatch.mockResolvedValue({
      ok: true,
      result: { terminals: [{ terminalId: "a", lastTypedInputAt: RESTORED_AT + 5 }] },
    });
    expect(await verify()).toBe("Agent a was typed in after it resumed — no note sent");

    dispatch.mockResolvedValue({ ok: true, result: { terminals: [] } });
    useTerminalInputStore.getState().setDraftInput("a", "half a thought", "p1");
    expect(await verify()).toBe("Agent a has a draft in its input — no note sent");
  });

  it("stops owning its notes once the offer is dismissed or the project leaves", async () => {
    placePanels(["a", "b"]);
    publishWakeCandidates("p1", [candidate("a"), candidate("b")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(0);
    const owned = deliveries[0]!.options.stillOwned;
    expect(owned()).toBe(true);

    useProjectStore.setState({ currentProject: null });
    expect(owned()).toBe(false);
    useProjectStore.setState({
      currentProject: { id: "p1" } as ReturnType<typeof useProjectStore.getState>["currentProject"],
    });
    const offerId = useWakeContinueStore.getState().offer!.id;
    dismissWakeContinue();
    expect(owned()).toBe(false);
    expect(cancelAgentRequests).toHaveBeenCalledWith(`wake-continue:${offerId}:`);
    expect(useWakeContinueStore.getState().offer).toBeNull();
  });

  it("does nothing for a blank note", async () => {
    placePanels(["a"]);
    publishWakeCandidates("p1", [candidate("a")]);
    await sendWakeContinueNotes("   ");
    expect(deliveries).toHaveLength(0);
    expect(useWakeContinueStore.getState().offer?.phase).toBe("offered");
  });
});
