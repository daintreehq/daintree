import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequestOptions } from "@/services/agentRequests";

const getOutputActivity = vi.hoisted(() => vi.fn());
vi.mock("@/clients/terminalClient", () => ({ terminalClient: { getOutputActivity } }));

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

import type { PanelInstance } from "@shared/types/panel";
import { claimComposerSendSeq, noteLastComposerSend } from "@/store/lastComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useWakeContinueStore } from "@/store/wakeContinueStore";
import type { WakeCandidate } from "../wakeCandidate";
import {
  WAKE_CONTINUE_PROMPT_SETTLE_MS,
  WAKE_CONTINUE_READY_TIMEOUT_MS,
  WAKE_CONTINUE_SPACING_MS,
  dismissWakeContinue,
  publishWakeCandidates,
  sendWakeContinueNotes,
} from "../wakeContinue";

const RESTORED_AT = 10_000;

const targetOf = (options: AgentRequestOptions) =>
  options.destination.kind === "terminal" ? options.destination.terminalId : null;
/** Long enough for the scheduler to see a prompt settle and admit it. */
const SETTLE = WAKE_CONTINUE_PROMPT_SETTLE_MS + 500;

type Project = ReturnType<typeof useProjectStore.getState>["currentProject"];

function candidate(id: string, overrides: Partial<WakeCandidate> = {}): WakeCandidate {
  return {
    terminalId: id,
    title: `Agent ${id}`,
    agentId: "codex",
    worktreeId: "wt-1",
    outcome: "resumed",
    restoredAt: RESTORED_AT,
    ...overrides,
  };
}

type Pane = {
  disposition?: "resume" | "fresh" | "held";
  at?: number;
  agentState?: string;
  waitingReason?: string;
  lastStateChange?: number;
  startedAt?: number;
  restoreRecovery?: unknown;
};

function setPane(id: string, pane: Pane = {}): void {
  const disposition = pane.disposition ?? "resume";
  usePanelStore.setState((state) => ({
    panelsById: {
      ...state.panelsById,
      [id]: {
        id,
        kind: "terminal",
        location: "grid",
        worktreeId: "wt-1",
        startedAt: pane.startedAt ?? 5,
        agentState: pane.agentState ?? "waiting",
        waitingReason: pane.waitingReason ?? "prompt",
        lastStateChange: pane.lastStateChange ?? 1,
        restoreProvenance: { at: pane.at ?? RESTORED_AT, disposition },
        ...(pane.restoreRecovery !== undefined && { restoreRecovery: pane.restoreRecovery }),
      } as unknown as PanelInstance,
    },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  useProjectStore.setState({ currentProject: { id: "p1" } as Project });
  getOutputActivity.mockImplementation(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { status: "read" }]))
  );
});

afterEach(() => {
  dismissWakeContinue();
  vi.useRealTimers();
  deliveries.length = 0;
  cancelAgentRequests.mockReset();
  getOutputActivity.mockReset();
  useWakeContinueStore.setState({ offer: null, dialogOpen: false });
  usePanelStore.setState({ panelsById: {} });
  useProjectStore.setState({ currentProject: null });
});

describe("publishWakeCandidates", () => {
  it("offers nothing when nothing can take a note", () => {
    publishWakeCandidates("p1", [
      candidate("a", { outcome: "fresh", agentId: "claude" }),
      candidate("b", { outcome: "held", holdReason: "held-by-plugin" }),
    ]);
    expect(useWakeContinueStore.getState().offer).toBeNull();
  });

  it("offers for a pane held only until the user starts it", () => {
    publishWakeCandidates("p1", [
      candidate("a", { outcome: "held", holdReason: "resume-deferred" }),
    ]);
    expect(useWakeContinueStore.getState().offer?.entries).toHaveLength(1);
  });

  it("replaces an open offer with a newer wake's, and withdraws the old one's notes", () => {
    publishWakeCandidates("p1", [candidate("a"), candidate("b", { outcome: "fresh" })]);
    const first = useWakeContinueStore.getState().offer!;
    useWakeContinueStore.getState().setDialogOpen(true);
    expect(first.entries.map((e) => e.terminalId)).toEqual(["a", "b"]);

    publishWakeCandidates("p1", [candidate("c")]);
    const second = useWakeContinueStore.getState().offer!;
    expect(second.id).not.toBe(first.id);
    expect(second.entries.map((e) => e.terminalId)).toEqual(["c"]);
    expect(useWakeContinueStore.getState().dialogOpen).toBe(false);
    expect(cancelAgentRequests).toHaveBeenCalledWith(`wake-continue:${first.id}:`);

    publishWakeCandidates("p1", []);
    expect(useWakeContinueStore.getState().offer).toBeNull();
  });

  it("goes with the project when the view drops it", () => {
    publishWakeCandidates("p1", [candidate("a")]);
    useProjectStore.setState({ currentProject: null });
    expect(useWakeContinueStore.getState().offer).toBeNull();
  });
});

describe("sendWakeContinueNotes", () => {
  it("sends nothing until asked, then only to panes running the resumed session", async () => {
    setPane("a");
    setPane("b", { disposition: "fresh" });
    setPane("c", { disposition: "held", restoreRecovery: { reason: "resume-deferred" } });
    setPane("d");
    publishWakeCandidates("p1", [
      candidate("a"),
      candidate("b", { outcome: "fresh" }),
      candidate("c", { outcome: "held", holdReason: "resume-deferred" }),
      candidate("d"),
    ]);
    // Restarted after the wake: the restart clears what the restore recorded.
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        d: { ...state.panelsById.d!, restoreProvenance: undefined } as PanelInstance,
      },
    }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliveries).toHaveLength(0);

    const run = sendWakeContinueNotes(" \tKeep going\n");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries.map((d) => d.options.destination)).toEqual([
      { kind: "terminal", terminalId: "a", title: "Agent a" },
    ]);
    expect(await deliveries[0]!.options.buildPrompt()).toBe("Keep going");
    deliveries[0]!.settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    const offer = useWakeContinueStore.getState().offer!;
    expect(offer.phase).toBe("done");
    expect(offer.entries.find((e) => e.terminalId === "a")?.delivery).toEqual({ status: "sent" });
    for (const id of ["b", "c", "d"]) {
      expect(offer.entries.find((e) => e.terminalId === id)?.delivery).toBeUndefined();
    }
  });

  it("sends to a held pane the user started on its session before sending", async () => {
    setPane("a", { disposition: "held", restoreRecovery: { reason: "resume-deferred" } });
    publishWakeCandidates("p1", [
      candidate("a", { outcome: "held", holdReason: "resume-deferred" }),
    ]);
    setPane("a", { disposition: "resume" });
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries.map((d) => targetOf(d.options))).toEqual(["a"]);
  });

  it("waits for a prompt to hold before typing at it", async () => {
    setPane("a", { agentState: "idle", waitingReason: "" });
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE * 2);
    expect(deliveries).toHaveLength(0);

    // A pause while loading history reads as a prompt for a moment, then moves on.
    setPane("a", { lastStateChange: 2 });
    await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_PROMPT_SETTLE_MS / 2);
    setPane("a", { lastStateChange: 3 });
    await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_PROMPT_SETTLE_MS / 2 + 250);
    expect(deliveries).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_PROMPT_SETTLE_MS);
    expect(deliveries).toHaveLength(1);
  });

  it("lets ready agents past busy ones, a few at a time with a pause between", async () => {
    const busy = ["a", "b", "c"];
    const ready = ["d", "e", "f", "g", "h"];
    for (const id of busy) setPane(id, { agentState: "working" });
    for (const id of ready) setPane(id);
    publishWakeCandidates(
      "p1",
      [...busy, ...ready].map((id) => candidate(id))
    );
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const first = deliveries.map((d) => targetOf(d.options));
    expect(first).toHaveLength(3);
    expect(first.every((id) => ready.includes(id))).toBe(true);

    // Nothing more goes out until one settles and its slot has paused.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliveries).toHaveLength(3);
    deliveries[0]!.settle();
    await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_SPACING_MS - 500);
    expect(deliveries).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliveries).toHaveLength(4);
  });

  it("gives up on an agent that never reaches its prompt, unless it is working", async () => {
    setPane("a", { agentState: "idle", waitingReason: "" });
    setPane("b", { agentState: "working" });
    publishWakeCandidates("p1", [candidate("a"), candidate("b")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_READY_TIMEOUT_MS + 1_000);
    const entries = useWakeContinueStore.getState().offer!.entries;
    expect(entries.find((e) => e.terminalId === "a")?.delivery).toEqual({
      status: "failed",
      message: "Agent a didn't reach its prompt",
    });
    expect(entries.find((e) => e.terminalId === "b")?.delivery?.status).toBe("queued");
  });

  it("refuses a pane written in, sent to, or restarted after it resumed", async () => {
    setPane("a", { startedAt: 5 });
    setPane("x");
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const verify = deliveries[0]!.options.verify!;
    expect(await verify()).toBeNull();

    getOutputActivity.mockResolvedValueOnce({ x: { status: "read" }, a: { status: "unreadable" } });
    expect(await verify()).toBe("Couldn't tell whether Agent a was typed in — no note sent");
    getOutputActivity.mockResolvedValueOnce({
      x: { status: "read" },
      a: { status: "read", lastTypedInputAt: 1 },
    });
    expect(await verify()).toBe("Agent a was typed in after it resumed — no note sent");

    useTerminalInputStore.getState().setDraftInput("a", "half a thought", "p1");
    expect(await verify()).toBe("Agent a has a draft in its input — no note sent");
    useTerminalInputStore.getState().setDraftInput("a", "", "p1");

    noteLastComposerSend("a", "do this instead", [], claimComposerSendSeq());
    expect(await verify()).toBe("Agent a was sent a message after it resumed — no note sent");
  });

  it("refuses a pane whose process was replaced after the note was admitted", async () => {
    setPane("a", { startedAt: 5 });
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    setPane("a", { startedAt: 6 });
    expect(await deliveries[0]!.options.verify!()).toBe(
      "Agent a was restarted after it resumed — no note sent"
    );
  });

  it("stops owning its notes once the offer is replaced or dismissed, or the project changes", async () => {
    setPane("a");
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const owned = deliveries[0]!.options.stillOwned;
    expect(owned()).toBe(true);

    useProjectStore.setState({ currentProject: { id: "p2" } as Project });
    expect(owned()).toBe(false);
  });

  it("does nothing for a blank note", async () => {
    setPane("a");
    publishWakeCandidates("p1", [candidate("a")]);
    await sendWakeContinueNotes(" \n\t ");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries).toHaveLength(0);
    expect(useWakeContinueStore.getState().offer?.phase).toBe("offered");
  });

  it("asks the lane for the agent's prompt, never the idle reading", async () => {
    setPane("a");
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const readiness = deliveries[0]!.options.readiness!;
    expect(readiness({ terminalId: "a", agentId: "codex", agentState: "idle" })).toBe("not-yet");
  });
});
