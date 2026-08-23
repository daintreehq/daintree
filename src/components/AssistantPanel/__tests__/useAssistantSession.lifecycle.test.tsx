// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantSession } from "../useAssistantSession";
import { useAssistantStore } from "@/store/assistantStore";

/**
 * Lifecycle of one engine session, from the renderer's side.
 *
 * Every case here is a way to end up with a headless Go process that nothing owns, or
 * with a transcript that lies about what the engine received. Neither is visible in
 * the UI — an orphaned engine holds the project's state lease and the next start fails
 * for a reason that looks unrelated, and a phantom user turn simply sits there
 * unanswered — so they are only ever caught by asserting the lifecycle directly.
 */

type EventCb = (event: Record<string, unknown>) => void;
type ExitCb = (payload: { sessionId: string; code: number | null }) => void;

let eventCbs: EventCb[] = [];
let exitCbs: ExitCb[] = [];
let start: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;

/** Resolves the pending `start()` by hand, so "still starting" is a state we can hold. */
let releaseStart: (result: {
  sessionId: string;
  ready: null;
  replay?: Record<string, unknown>[];
}) => void;

beforeEach(() => {
  eventCbs = [];
  exitCbs = [];
  start = vi.fn(
    () =>
      new Promise((resolve) => {
        releaseStart = resolve;
      })
  );
  stop = vi.fn().mockResolvedValue({ stopped: true });
  send = vi.fn().mockResolvedValue({ delivered: true });

  // Augmented, not replaced: swapping the whole jsdom `window` also takes
  // `window.document` with it, and testing-library renders into it.
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
      onSequenceGap: () => () => {},
      onExit: (cb: ExitCb) => {
        exitCbs.push(cb);
        return () => {
          exitCbs = exitCbs.filter((c) => c !== cb);
        };
      },
    },
  };
  // Frame-coalesced flushing needs a frame to actually arrive; jsdom's rAF is tied to
  // its own clock, so a timer keeps the flush deterministic.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    clearTimeout(id as unknown as NodeJS.Timeout)
  );
  useAssistantStore.getState().reset(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const OPTS = { projectId: "proj-1", cwd: "/repo", enabled: true };

describe("useAssistantSession — a session is never left running", () => {
  it("stops an engine whose start resolved after the panel went away", async () => {
    const { unmount } = renderHook(() => useAssistantSession(OPTS));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // The panel goes away while the engine is still coming up. Readiness can take up
    // to the engine's start timeout, so this is not a narrow window — it is every
    // project-view eviction and every close during a cold start.
    unmount();
    expect(stop).not.toHaveBeenCalled(); // nothing to stop yet — no session id exists

    await act(async () => {
      releaseStart({ sessionId: "ses_late", ready: null });
    });

    // The engine that arrived late is stopped rather than adopted. Without this it
    // keeps running with no component holding its id, holding the project's lease
    // against every subsequent start.
    expect(stop).toHaveBeenCalledWith("ses_late");
  });

  it("stops the superseded engine when the project changes mid-start", async () => {
    const { rerender } = renderHook((props: typeof OPTS) => useAssistantSession(props), {
      initialProps: OPTS,
    });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const releaseFirst = releaseStart;

    rerender({ ...OPTS, projectId: "proj-2", cwd: "/other" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    await act(async () => {
      releaseFirst({ sessionId: "ses_first", ready: null });
    });

    expect(stop).toHaveBeenCalledWith("ses_first");
  });
});

describe("useAssistantSession — a dead session refuses work", () => {
  async function live() {
    const hook = renderHook(() => useAssistantSession(OPTS));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await act(async () => {
      releaseStart({ sessionId: "ses_live", ready: null });
    });
    return hook;
  }

  it("accepts a prompt while the session is ready", async () => {
    const { result } = await live();
    let accepted = false;
    act(() => {
      accepted = result.current.submit("do the thing");
    });

    expect(accepted).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "prompt", sessionId: "ses_live" })
    );
    expect(useAssistantStore.getState().turns.some((t) => t.role === "user")).toBe(true);
  });

  it("refuses a prompt after the engine exits, and records no user turn", async () => {
    const { result } = await live();
    act(() => {
      for (const cb of exitCbs) cb({ sessionId: "ses_live", code: 1 });
    });

    let accepted = true;
    act(() => {
      accepted = result.current.submit("do the thing");
    });

    // The Send button is disabled on a stopped session, but Enter still reaches
    // submit. A submit that reported success here would clear the composer and paint
    // a user turn that no engine will ever answer.
    expect(accepted).toBe(false);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
    expect(useAssistantStore.getState().turns.some((t) => t.role === "user")).toBe(false);
  });
});

// NOT TESTED HERE: the session tag on buffered tokens.
//
// It cannot be exercised from this surface, and a test that appears to cover it would
// be worse than none. Tokens only reach the buffer once `sessionIdRef` holds their
// session — the subscriber drops events for any other id — and `onExit` flushes the
// buffer BEFORE clearing that ref, so no buffered token ever survives into a session
// it does not belong to. The tag, and the buffer clear in cleanup, are defence in
// depth for a future in which turn ids are reused across a resume; today every test
// written against them passes with or without the guard in place.

describe("useAssistantSession — what the engine said before anyone could hear it", () => {
  it("applies events the engine emitted before the session id was known", async () => {
    renderHook(() => useAssistantSession(OPTS));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    await act(async () => {
      releaseStart({
        sessionId: "ses_r",
        ready: null,
        // The engine reports its control plane at boot, before this renderer can match
        // any frame to a session. Without the replay it lands in that gap and the
        // panel says "Connected" for a session that cannot reach Daintree at all.
        replay: [
          {
            type: "mcp:status",
            sessionId: "ses_r",
            seq: 2,
            connected: false,
            error: "DAINTREE_MCP_URL / DAINTREE_MCP_TOKEN not set",
          },
        ],
      });
    });

    expect(useAssistantStore.getState().mcpUnavailable).toBe(
      "DAINTREE_MCP_URL / DAINTREE_MCP_TOKEN not set"
    );
  });
});

describe("useAssistantSession — a mid-turn message main refuses", () => {
  it("takes the queued entry back instead of leaving it to be promoted", async () => {
    send.mockResolvedValue({ delivered: false });
    const { result } = renderHook(() => useAssistantSession(OPTS));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await act(async () => {
      releaseStart({ sessionId: "ses_q", ready: null });
    });

    // A running turn: input is QUEUED rather than appended, so there is no local turn
    // id to take back — which is exactly how a refused send used to survive.
    act(() => {
      useAssistantStore.getState().applyEvent({
        sessionId: "ses_q",
        seq: 2,
        type: "turn:start",
        turnId: "t1",
        role: "assistant",
        startedAt: 1,
      } as never);
    });

    await act(async () => {
      result.current.submit("never arrives");
      await Promise.resolve();
    });

    expect(useAssistantStore.getState().queuedInterjections).toEqual([]);
  });
});
