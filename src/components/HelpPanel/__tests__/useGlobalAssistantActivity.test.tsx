// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalAssistantView } from "@shared/types/ipc/help";

const host = vi.hoisted(() => ({ id: null as string | null }));
const cache = vi.hoisted(() => ({ cached: false, listeners: new Set<() => void>() }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => host.id }));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => cache.cached,
  subscribeProjectViewLifecycle: (listener: () => void) => {
    cache.listeners.add(listener);
    return () => cache.listeners.delete(listener);
  },
}));

const { useGlobalAssistantActivity } = await import("../useGlobalAssistantActivity");

function viewOf(patch: Partial<GlobalAssistantView> = {}): GlobalAssistantView {
  return {
    phase: "running",
    generation: 1,
    agentId: "claude",
    terminalId: "g1",
    attachments: [],
    inputOwner: null,
    inputEpoch: 0,
    subject: { hostId: "local", scope: { kind: "global" }, terminalId: "g1", incarnation: 2 },
    agentState: null,
    ...patch,
  };
}

let listeners: Set<(state: GlobalAssistantView) => void>;
let answer: (state: GlobalAssistantView) => void;
let help: Record<string, ReturnType<typeof vi.fn>>;

function installHelp() {
  listeners = new Set();
  help = {
    getGlobalAssistantState: vi.fn(
      () => new Promise<GlobalAssistantView>((resolve) => (answer = resolve))
    ),
    onGlobalAssistantChanged: vi.fn((callback: (state: GlobalAssistantView) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    attachGlobalAssistant: vi.fn(),
    detachGlobalAssistant: vi.fn(),
    ensureGlobalAssistant: vi.fn(),
    claimGlobalAssistantInput: vi.fn(),
    releaseGlobalAssistantInput: vi.fn(),
    restartGlobalAssistant: vi.fn(),
    discardGlobalAssistant: vi.fn(),
  };
  Object.assign(window, { electron: { help } });
}

function push(state: GlobalAssistantView) {
  act(() => {
    for (const listener of [...listeners]) listener(state);
  });
}

async function reply(state: GlobalAssistantView) {
  await act(async () => answer(state));
}

describe("useGlobalAssistantActivity", () => {
  beforeEach(() => {
    host.id = null;
    cache.cached = false;
    cache.listeners.clear();
    installHelp();
  });

  afterEach(cleanup);

  it("shows a run already waiting as soon as it is read", async () => {
    const { result } = renderHook(() => useGlobalAssistantActivity(true));
    expect(result.current).toBeNull();
    await reply(viewOf({ agentState: "waiting" }));
    expect(result.current).toBe("waiting");
  });

  it("follows every change main tells it, down to the run ending", async () => {
    const { result } = renderHook(() => useGlobalAssistantActivity(true));
    await reply(viewOf({ agentState: "waiting" }));
    push(viewOf({ agentState: "working" }));
    expect(result.current).toBe("working");
    push(viewOf({ phase: "absent", terminalId: null, subject: null, agentState: null }));
    expect(result.current).toBeNull();
  });

  it("says nothing of a run it can't name a subject for", async () => {
    const { result } = renderHook(() => useGlobalAssistantActivity(true));
    await reply(viewOf({ subject: null, agentState: "waiting" }));
    expect(result.current).toBeNull();
  });

  it("only reads and listens: it never starts, attaches to, or takes the run's input", async () => {
    const { unmount } = renderHook(() => useGlobalAssistantActivity(true));
    await reply(viewOf({ agentState: "waiting" }));
    push(viewOf({ agentState: "working" }));
    unmount();
    for (const name of [
      "attachGlobalAssistant",
      "detachGlobalAssistant",
      "ensureGlobalAssistant",
      "claimGlobalAssistantInput",
      "releaseGlobalAssistantInput",
      "restartGlobalAssistant",
      "discardGlobalAssistant",
    ]) {
      expect(help[name]).not.toHaveBeenCalled();
    }
    expect(listeners.size).toBe(0);
  });

  it("does nothing while inactive, and rereads rather than show what it saw before", async () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useGlobalAssistantActivity(active),
      { initialProps: { active: false } }
    );
    expect(help.getGlobalAssistantState).not.toHaveBeenCalled();
    expect(help.onGlobalAssistantChanged).not.toHaveBeenCalled();

    rerender({ active: true });
    await reply(viewOf({ agentState: "waiting" }));
    expect(result.current).toBe("waiting");

    rerender({ active: false });
    expect(result.current).toBeNull();
    expect(listeners.size).toBe(0);

    rerender({ active: true });
    expect(result.current).toBeNull();
    expect(help.getGlobalAssistantState).toHaveBeenCalledTimes(2);
    await reply(viewOf({ agentState: "working" }));
    expect(result.current).toBe("working");
  });

  it("drops an answer that lands after it stopped looking", async () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useGlobalAssistantActivity(active),
      { initialProps: { active: true } }
    );
    const late = answer;
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => late(viewOf({ agentState: "waiting" })));
    expect(result.current).toBeNull();
  });

  it("stays quiet in a cached view and in one bound to another host", async () => {
    cache.cached = true;
    const cached = renderHook(() => useGlobalAssistantActivity(true));
    expect(help.onGlobalAssistantChanged).not.toHaveBeenCalled();
    act(() => {
      cache.cached = false;
      for (const listener of [...cache.listeners]) listener();
    });
    await reply(viewOf({ agentState: "waiting" }));
    expect(cached.result.current).toBe("waiting");
    cached.unmount();

    host.id = "remote-1";
    installHelp();
    renderHook(() => useGlobalAssistantActivity(true));
    expect(help.onGlobalAssistantChanged).not.toHaveBeenCalled();
    expect(help.getGlobalAssistantState).not.toHaveBeenCalled();
  });
});
