// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantSession } from "../useAssistantSession";
import {
  assistantStoreForSlot,
  releaseAssistantStore,
  selectAssistantLaneState,
  useAssistantStore,
} from "@/store/assistantStore";

/**
 * Parallel Daintree Assistant sessions, from the renderer's side (#12108).
 *
 * The panel shipped with a tab strip and one global store behind it, so clicking
 * Session 2 changed the tab and nothing else: both tabs read the same conversation from
 * the same engine. The fix is one store and one engine PER LANE, and these are the two
 * halves of it — a start names its lane, and two lanes' events never reach each other's
 * transcript.
 */

type EventCb = (event: Record<string, unknown>) => void;

let eventCbs: EventCb[] = [];
let start: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;

/** Resolves each pending `start()` by hand, keyed by the lane that asked. */
let pending: Array<{
  slot: number | undefined;
  resolve: (result: {
    sessionId: string;
    attachmentId: string;
    ready: null;
    replay?: Record<string, unknown>[];
  }) => void;
}> = [];

beforeEach(() => {
  eventCbs = [];
  pending = [];
  start = vi.fn(
    (payload: { slot?: number }) =>
      new Promise((resolve) => {
        pending.push({ slot: payload.slot, resolve: resolve as never });
      })
  );
  stop = vi.fn().mockResolvedValue({ stopped: true });
  send = vi.fn().mockResolvedValue({ delivered: true });

  (window as unknown as { electron: unknown }).electron = {
    assistantHost: {
      start,
      stop,
      send,
      onEvent: (cb: EventCb) => {
        eventCbs.push(cb);
        return () => {
          eventCbs = eventCbs.filter((c) => c !== cb);
        };
      },
      onPeerPrompt: () => () => {},
      onSequenceGap: () => () => {},
      onExit: () => () => {},
    },
  };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    clearTimeout(id as unknown as NodeJS.Timeout)
  );
  useAssistantStore.getState().reset(null);
  releaseAssistantStore(1);
  releaseAssistantStore(2);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  releaseAssistantStore(1);
  releaseAssistantStore(2);
});

const BASE = { projectId: "proj-1", cwd: "/repo", enabled: true };

describe("the lane store registry", () => {
  it("keeps slot 0 on the store it has always been", () => {
    // Not a nicety: everything outside this hook that reads the assistant reads the
    // module store, and moving slot 0 into a table would have moved the default
    // session's state out from under all of it.
    expect(assistantStoreForSlot(0)).toBe(useAssistantStore);
  });

  it("gives every other lane its own store", () => {
    expect(assistantStoreForSlot(1)).not.toBe(useAssistantStore);
    expect(assistantStoreForSlot(1)).toBe(assistantStoreForSlot(1));
    expect(assistantStoreForSlot(1)).not.toBe(assistantStoreForSlot(2));
  });

  it("resolves an out-of-range slot down to the default lane", () => {
    expect(assistantStoreForSlot(99)).toBe(useAssistantStore);
  });

  it("hands the next occupant of a released slot a clean transcript", () => {
    assistantStoreForSlot(1).getState().appendUserTurn("only mine");
    releaseAssistantStore(1);
    expect(assistantStoreForSlot(1).getState().turns).toEqual([]);
  });

  it("resets slot 0 rather than replacing it", () => {
    useAssistantStore.getState().appendUserTurn("hello");
    releaseAssistantStore(0);
    expect(assistantStoreForSlot(0)).toBe(useAssistantStore);
    expect(useAssistantStore.getState().turns).toEqual([]);
  });
});

describe("two lanes of one project", () => {
  it("starts an engine per lane, each naming its own slot", async () => {
    renderHook(() => useAssistantSession({ ...BASE, slot: 0 }));
    renderHook(() => useAssistantSession({ ...BASE, slot: 1 }));

    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(pending.map((p) => p.slot)).toEqual([0, 1]);
    // The lane travels with the start, because main keys the engine — and therefore
    // the engine's state namespace and lease — on `(projectId, slot)`.
    expect(start).toHaveBeenCalledWith({ projectId: "proj-1", cwd: "/repo", slot: 1 });
  });

  it("keeps each lane's turns out of the other's transcript", async () => {
    const laneOne = renderHook(() => useAssistantSession({ ...BASE, slot: 0 }));
    const laneTwo = renderHook(() => useAssistantSession({ ...BASE, slot: 1 }));
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => {
      pending[0]!.resolve({ sessionId: "ses_a", attachmentId: "att_a", ready: null });
      pending[1]!.resolve({ sessionId: "ses_b", attachmentId: "att_b", ready: null });
    });

    act(() => {
      laneOne.result.current.submit("question for one");
      laneTwo.result.current.submit("question for two");
    });

    // The whole user-visible bug in one assertion: before lanes, both of these landed
    // in the same store and both tabs showed both messages.
    expect(
      assistantStoreForSlot(0)
        .getState()
        .turns.map((t) => t.text)
    ).toEqual(["question for one"]);
    expect(
      assistantStoreForSlot(1)
        .getState()
        .turns.map((t) => t.text)
    ).toEqual(["question for two"]);
  });

  it("routes an engine event to the lane whose session it names", async () => {
    renderHook(() => useAssistantSession({ ...BASE, slot: 0 }));
    renderHook(() => useAssistantSession({ ...BASE, slot: 1 }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[0]!.resolve({ sessionId: "ses_a", attachmentId: "att_a", ready: null });
      pending[1]!.resolve({ sessionId: "ses_b", attachmentId: "att_b", ready: null });
    });

    // Every lane's hook is subscribed to ONE event channel and filters on its own
    // session id — the routing that lets a background lane keep streaming without
    // writing into the lane on screen.
    await act(async () => {
      for (const cb of eventCbs) {
        cb({ type: "turn:phase", sessionId: "ses_b", seq: 2, phase: "Thinking" });
      }
    });

    expect(assistantStoreForSlot(0).getState().phase).toBe(null);
    expect(assistantStoreForSlot(1).getState().phase).toBe("Thinking");
  });

  it("does not let a chatty lane evict another lane's pre-adoption frames", async () => {
    renderHook(() => useAssistantSession({ ...BASE, slot: 0 }));
    renderHook(() => useAssistantSession({ ...BASE, slot: 1 }));
    await waitFor(() => expect(pending).toHaveLength(2));

    // Both lanes are mid-start, so neither knows its own session id yet and both are
    // holding whatever arrives. A running sibling streaming a long answer through that
    // window used to spend the whole shared cap, and the lane that was actually cold
    // starting lost its own pre-ready frames to an eviction it had no part in.
    act(() => {
      for (const cb of eventCbs) {
        for (let seq = 2; seq < 700; seq += 1) {
          cb({ type: "turn:phase", sessionId: "ses_b", seq, phase: `noise ${seq}` });
        }
        cb({ type: "turn:phase", sessionId: "ses_a", seq: 900, phase: "mine" });
      }
    });

    await act(async () => {
      pending[0]!.resolve({ sessionId: "ses_a", attachmentId: "att_a", ready: null });
    });

    expect(assistantStoreForSlot(0).getState().phase).toBe("mine");
  });

  it("marks a background lane working from the same reading its own header uses", async () => {
    renderHook(() => useAssistantSession({ ...BASE, slot: 1 }));
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!.resolve({ sessionId: "ses_b", attachmentId: "att_b", ready: null });
    });

    const lane = assistantStoreForSlot(1);
    expect(selectAssistantLaneState(lane.getState())).toBe(null);

    // A wake's first phase lands BEFORE its turn opens. A marker that only watched for
    // an open turn showed this lane as idle while its own header said it was working.
    await act(async () => {
      for (const cb of eventCbs) {
        cb({ type: "turn:phase", sessionId: "ses_b", seq: 2, phase: "Waking", wake: true });
      }
    });
    expect(selectAssistantLaneState(lane.getState())).toBe("working");

    // An approval outranks it: the lane has stopped, and only a human can move it.
    await act(async () => {
      for (const cb of eventCbs) {
        cb({
          type: "approval:requested",
          sessionId: "ses_b",
          seq: 3,
          approvalId: "ap1",
          toolId: "git.push",
          summary: "Push to origin",
          needsTypedConfirm: false,
          rememberable: false,
        });
      }
    });
    expect(selectAssistantLaneState(lane.getState())).toBe("waiting");
  });

  it("stops only the lane that goes away", async () => {
    const laneOne = renderHook(() => useAssistantSession({ ...BASE, slot: 0 }));
    renderHook(() => useAssistantSession({ ...BASE, slot: 1 }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[0]!.resolve({ sessionId: "ses_a", attachmentId: "att_a", ready: null });
      pending[1]!.resolve({ sessionId: "ses_b", attachmentId: "att_b", ready: null });
    });

    laneOne.unmount();

    // Closing one tab must not detach the sibling: main stops an engine when its last
    // surface leaves, so a detach naming the wrong session ends a conversation nobody
    // asked to end.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("ses_a", "att_a");
  });
});
