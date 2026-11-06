import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneDecisionState } from "@shared/types/decisions";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let decisionsClient: typeof import("../decisionsClient").decisionsClient;
let push: (state: PaneDecisionState) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let getPaneState: ReturnType<typeof vi.fn>;
let resolveRead: (state: PaneDecisionState | null) => void;
let rejectRead: (err: Error) => void;
const order: string[] = [];

function emptyState(revision: number, terminalId = "pane-a"): PaneDecisionState {
  return { terminalId, openQuestions: [], waitingAnswers: [], needsAttention: [], revision };
}

function state(revision: number, terminalId = "pane-a"): PaneDecisionState {
  return {
    terminalId,
    openQuestions: [
      {
        questionId: `qid-${revision}`,
        alias: revision,
        status: "open",
        askedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ],
    waitingAnswers: [],
    needsAttention: [],
    revision,
  };
}

describe("decisionsClient.watchPaneState", () => {
  beforeEach(async () => {
    vi.resetModules();
    order.length = 0;
    unsubscribe = vi.fn();
    getPaneState = vi.fn(() => {
      order.push("read");
      return new Promise<PaneDecisionState | null>((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
    });
    typedGlobal.window = {
      electron: {
        decisions: { getPaneState },
        terminal: {
          onDecisionState: vi.fn((callback: (state: PaneDecisionState) => void) => {
            order.push("subscribe");
            push = callback;
            return unsubscribe;
          }),
        },
      },
    };
    ({ decisionsClient } = await import("../decisionsClient"));
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("subscribes before it reads, and shows what the read finds", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    resolveRead(state(3));
    await Promise.resolve();

    expect(order).toEqual(["subscribe", "read"]);
    expect(getPaneState).toHaveBeenCalledWith("pane-a");
    expect(seen.map((s) => s.revision)).toEqual([3]);
  });

  it.each([
    ["older", 4, [5]],
    ["the same", 5, [5]],
    ["newer", 6, [5, 6]],
  ])("after a push, takes a read with %s revision only if it is newer", async (_l, read, want) => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(5));
    resolveRead(state(read));
    await Promise.resolve();

    expect(seen.map((s) => s.revision)).toEqual(want);
  });

  it("calls nothing for a repeated push", () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(5));
    push(state(5));

    expect(seen.map((s) => s.revision)).toEqual([5]);
  });

  it("shows the empty state Decisions sends when turned off, then what follows when it is back on", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(1));
    push(emptyState(2));
    resolveRead(state(1));
    await Promise.resolve();
    push(state(3));

    expect(seen).toEqual([state(1), emptyState(2), state(3)]);
  });

  it("keeps a push when the read finds nothing", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(2));
    resolveRead(null);
    await Promise.resolve();

    expect(seen.map((s) => s.revision)).toEqual([2]);
  });

  it("keeps watching when the read fails", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(2));
    rejectRead(new Error("host gone"));
    await Promise.resolve();
    await Promise.resolve();
    push(state(3));

    expect(seen.map((s) => s.revision)).toEqual([2, 3]);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("ignores other panes' pushes, and their revisions", () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(9, "pane-b"));
    push(state(1));

    expect(seen.map((s) => [s.terminalId, s.revision])).toEqual([["pane-a", 1]]);
  });

  it("stops listening, and ignores a read still in flight, once stopped", async () => {
    const seen: PaneDecisionState[] = [];
    const stop = decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    stop();
    resolveRead(state(1));
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });
});
