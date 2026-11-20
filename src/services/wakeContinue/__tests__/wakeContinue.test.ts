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
    lastSeen: { agentState: "working", at: 1 },
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
  agentSessionId?: string;
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
        ...(pane.agentSessionId !== undefined && { agentSessionId: pane.agentSessionId }),
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

  it("offers only for agents last seen working, and lists only them", async () => {
    publishWakeCandidates("p1", [
      candidate("idle", { lastSeen: { agentState: "idle", at: 1 } }),
      candidate("working"),
      candidate("waiting", { lastSeen: { agentState: "waiting", at: 1 } }),
      candidate("done", { lastSeen: { agentState: "completed", at: 1 } }),
      candidate("gone", { lastSeen: { agentState: "exited", at: 1 } }),
      // A snapshot from before observations were kept says nothing either way.
      candidate("unknown", { lastSeen: undefined }),
      candidate("fresh", { outcome: "fresh" }),
      candidate("heldIdle", {
        outcome: "held",
        holdReason: "resume-deferred",
        heldSessionId: "s-held",
        lastSeen: { agentState: "idle", at: 1 },
      }),
    ]);
    const offer = useWakeContinueStore.getState().offer!;
    expect(offer.entries.map((e) => e.terminalId)).toEqual(["working", "fresh"]);

    for (const id of ["idle", "working", "waiting", "done", "gone", "unknown", "fresh"]) {
      setPane(id, { disposition: id === "fresh" ? "fresh" : "resume" });
    }
    const sending = sendWakeContinueNotes("Carry on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries.map((d) => targetOf(d.options))).toEqual(["working"]);
    deliveries[0]!.settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;
    expect(deliveries).toHaveLength(1);
  });

  it("offers nothing when no agent it could reach was working, and withdraws the last offer", () => {
    publishWakeCandidates("p1", [candidate("a")]);
    const first = useWakeContinueStore.getState().offer!;
    // Interrupted mid-task, but its conversation is gone: nothing to note.
    publishWakeCandidates("p1", [
      candidate("b", { outcome: "fresh" }),
      candidate("c", { lastSeen: { agentState: "idle", at: 1 } }),
      candidate("d", {
        outcome: "held",
        holdReason: "resume-deferred",
        heldSessionId: "s-d",
        lastSeen: { agentState: "completed", at: 1 },
      }),
    ]);
    expect(useWakeContinueStore.getState().offer).toBeNull();
    expect(cancelAgentRequests).toHaveBeenCalledWith(`wake-continue:${first.id}:`);
  });

  it("offers for a pane held only until the user starts it on a named session", () => {
    publishWakeCandidates("p1", [
      candidate("a", { outcome: "held", holdReason: "resume-deferred", heldSessionId: "s-a" }),
    ]);
    expect(useWakeContinueStore.getState().offer?.entries).toHaveLength(1);
    // Without the session it was held with, no start of it could ever count.
    publishWakeCandidates("p1", [
      candidate("a", { outcome: "held", holdReason: "resume-deferred" }),
    ]);
    expect(useWakeContinueStore.getState().offer).toBeNull();
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
    const sending = useWakeContinueStore.getState().offer!;
    for (const id of ["b", "c", "d"]) {
      expect(sending.entries.find((e) => e.terminalId === id)?.delivery).toBeUndefined();
    }
    deliveries[0]!.settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    // Its one note went in, so there is nothing left to look at.
    expect(useWakeContinueStore.getState().offer).toBeNull();
  });

  describe("when sending ends", () => {
    it("keeps the report up when a note didn't go in", async () => {
      setPane("a");
      setPane("b", { agentState: "working", waitingReason: "" });
      publishWakeCandidates("p1", [candidate("a"), candidate("b")]);
      const run = sendWakeContinueNotes("Keep going");
      await vi.advanceTimersByTimeAsync(SETTLE);
      deliveries[0]!.settle();
      // The second agent never reaches its prompt.
      usePanelStore.setState((state) => ({
        panelsById: Object.fromEntries(
          Object.entries(state.panelsById).filter(([id]) => id !== "b")
        ),
      }));
      await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_SPACING_MS + 1_000);
      await run;
      const offer = useWakeContinueStore.getState().offer!;
      expect(offer.phase).toBe("done");
      expect(offer.entries.map((e) => e.delivery?.status)).toEqual(["sent", "failed"]);
    });

    it("keeps the report up when no note went in", async () => {
      setPane("a");
      publishWakeCandidates("p1", [candidate("a")]);
      useTerminalInputStore.getState().setDraftInput("a", "typed", "p1");
      await sendWakeContinueNotes("Keep going");
      useTerminalInputStore.getState().setDraftInput("a", "", "p1");
      const offer = useWakeContinueStore.getState().offer!;
      expect(offer.phase).toBe("done");
    });

    it("holds the clear until the review dialog closes", async () => {
      setPane("a");
      publishWakeCandidates("p1", [candidate("a")]);
      const run = sendWakeContinueNotes("Keep going");
      await vi.advanceTimersByTimeAsync(SETTLE);
      useWakeContinueStore.getState().setDialogOpen(true);
      deliveries[0]!.settle();
      await vi.advanceTimersByTimeAsync(1_000);
      await run;
      expect(useWakeContinueStore.getState().offer?.phase).toBe("done");
      useWakeContinueStore.getState().setDialogOpen(false);
      expect(useWakeContinueStore.getState().offer).toBeNull();
    });
  });

  it("sends to a held pane the user started on its own session, not on another", async () => {
    for (const id of ["a", "b"]) {
      setPane(id, { disposition: "held", restoreRecovery: { reason: "resume-deferred" } });
    }
    publishWakeCandidates("p1", [
      candidate("a", { outcome: "held", holdReason: "resume-deferred", heldSessionId: "s-a" }),
      candidate("b", { outcome: "held", holdReason: "resume-deferred", heldSessionId: "s-b" }),
    ]);
    setPane("a", { disposition: "resume", agentSessionId: "s-a" });
    // Started from its hold, but on a conversation picked from the list.
    setPane("b", { disposition: "resume", agentSessionId: "s-other" });
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries.map((d) => targetOf(d.options))).toEqual(["a"]);
  });

  it("offers nothing to a pane rebuilt by a different restore", async () => {
    setPane("a", { at: RESTORED_AT + 1 });
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries).toHaveLength(0);
  });

  it("hands a pane that leaves its prompt back to wait, freeing its slot", async () => {
    for (const id of ["a", "b", "c", "d"]) setPane(id);
    publishWakeCandidates(
      "p1",
      ["a", "b", "c", "d"].map((id) => candidate(id))
    );
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries.map((d) => targetOf(d.options))).toEqual(["a", "b", "c"]);

    // "a" picked something up before its note went in: the lane says so.
    setPane("a", { agentState: "working" });
    deliveries[0]!.options.onState({
      id: "r",
      state: { status: "queued" },
      title: "",
      terminalId: "a",
    });
    expect(deliveries[0]!.options.stillOwned()).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries.map((d) => targetOf(d.options))).toEqual(["a", "b", "c"]);
    // The lane ends the run on its next look; "d" takes the slot at once.
    deliveries[0]!.settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(deliveries.map((d) => targetOf(d.options))).toEqual(["a", "b", "c", "d"]);
    const a = useWakeContinueStore.getState().offer!.entries.find((e) => e.terminalId === "a");
    expect(a?.delivery?.status).toBe("starting");

    // Back at a prompt that has held: it goes again.
    setPane("a", { lastStateChange: 50 });
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(deliveries.slice(4).map((d) => targetOf(d.options))).toEqual([]);
    for (const d of deliveries.slice(1)) d.settle();
    await vi.advanceTimersByTimeAsync(WAKE_CONTINUE_SPACING_MS + 500);
    expect(deliveries.map((d) => targetOf(d.options))).toContain("a");
    expect(deliveries.filter((d) => targetOf(d.options) === "a")).toHaveLength(2);
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
    expect(first.every((id) => id !== null && ready.includes(id))).toBe(true);

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
    expect(entries.find((e) => e.terminalId === "b")?.delivery?.status).toBe("starting");
  });

  it("refuses a pane written in, sent to, or restarted after it resumed", async () => {
    setPane("a", { startedAt: 5 });
    setPane("x");
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const verify = deliveries[0]!.options.verify!;
    // The launch typing its own command, before the agent settled, is no one's draft.
    const launchTyped = { x: { status: "read" }, a: { status: "read", lastTypedInputAt: 0 } };
    getOutputActivity.mockResolvedValueOnce(launchTyped);
    expect(await verify()).toBeNull();
    getOutputActivity.mockResolvedValueOnce(launchTyped);
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

  it("asks the lane for the prompt it timed, never the idle reading or a newer prompt", async () => {
    setPane("a", { lastStateChange: 7 });
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const readiness = deliveries[0]!.options.readiness!;
    const at = (lastTransitionAt: number, agentState: "waiting" | "idle" = "waiting") =>
      readiness({
        terminalId: "a",
        agentId: "codex",
        agentState,
        waitingReason: "prompt",
        lastTransitionAt,
      });
    expect(at(7)).toBe("ready");
    expect(at(7, "idle")).toBe("not-yet");
    expect(at(8)).toBe("not-yet");
  });

  it("refuses a retry into a different agent the pty now runs", async () => {
    setPane("a");
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        a: { ...state.panelsById.a!, agentIncarnation: 0 } as PanelInstance,
      },
    }));
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    // The first attempt lapses; the agent quits and another is started in its shell.
    deliveries[0]!.options.onState({
      id: "r",
      state: { status: "queued" },
      title: "",
      terminalId: "a",
    });
    deliveries[0]!.settle();
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        a: { ...state.panelsById.a!, agentIncarnation: 1, lastStateChange: 9 } as PanelInstance,
      },
    }));
    await vi.advanceTimersByTimeAsync(SETTLE + WAKE_CONTINUE_SPACING_MS);
    expect(deliveries).toHaveLength(1);
    expect(
      useWakeContinueStore.getState().offer!.entries.find((e) => e.terminalId === "a")?.delivery
    ).toEqual({
      status: "failed",
      message: "Agent a was restarted after it resumed — no note sent",
    });
  });

  it("refuses typing it can't order against a renderer-stamped prompt", async () => {
    setPane("a", { lastStateChange: 1_000_000 });
    publishWakeCandidates("p1", [candidate("a")]);
    void sendWakeContinueNotes("Go on");
    await vi.advanceTimersByTimeAsync(SETTLE);
    const verify = deliveries[0]!.options.verify!;
    getOutputActivity.mockResolvedValueOnce({ a: { status: "read", lastTypedInputAt: 5 } });
    expect(await verify()).toBeNull();
    // Older than the prompt by the clocks, but new since the first look.
    getOutputActivity.mockResolvedValueOnce({ a: { status: "read", lastTypedInputAt: 6 } });
    expect(await verify()).toBe("Agent a was typed in after it resumed — no note sent");
  });
});
