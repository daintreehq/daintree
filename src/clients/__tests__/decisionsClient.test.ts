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

  it("keeps a push that beat the read, and drops the older read", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(5));
    resolveRead(state(4));
    await Promise.resolve();
    push(state(6));

    expect(seen.map((s) => s.revision)).toEqual([5, 6]);
  });

  it("keeps a push when the read finds nothing or fails", async () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(2));
    resolveRead(null);
    await Promise.resolve();

    expect(seen.map((s) => s.revision)).toEqual([2]);

    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));
    rejectRead(new Error("host gone"));
    await Promise.resolve();
    expect(seen.map((s) => s.revision)).toEqual([2]);
  });

  it("ignores other panes' pushes", () => {
    const seen: PaneDecisionState[] = [];
    decisionsClient.watchPaneState("pane-a", (s) => seen.push(s));

    push(state(9, "pane-b"));

    expect(seen).toEqual([]);
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
