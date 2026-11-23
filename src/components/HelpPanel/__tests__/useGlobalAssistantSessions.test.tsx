// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import { useGlobalAssistantSessions } from "../useGlobalAssistantSessions";

function viewOf(patch: Partial<GlobalAssistantView>): GlobalAssistantView {
  return {
    slot: 0,
    phase: "absent",
    occupied: false,
    pinnedAgentId: null,
    coordinating: false,
    generation: 0,
    agentId: null,
    terminalId: null,
    attachments: [],
    inputOwner: null,
    inputEpoch: 0,
    subject: null,
    agentState: null,
    ...patch,
  };
}

let listeners: Set<(state: GlobalAssistantView) => void>;
let answer: (views: GlobalAssistantView[]) => void;
let help: {
  listGlobalAssistantSessions: ReturnType<typeof vi.fn>;
  onGlobalAssistantChanged: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  listeners = new Set();
  help = {
    listGlobalAssistantSessions: vi.fn(
      () =>
        new Promise<GlobalAssistantView[]>((resolve) => {
          answer = resolve;
        })
    ),
    onGlobalAssistantChanged: vi.fn((listener: (state: GlobalAssistantView) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  Object.assign(window, { electron: { help } });
});

function push(state: GlobalAssistantView) {
  act(() => {
    for (const listener of [...listeners]) listener(state);
  });
}

describe("useGlobalAssistantSessions (#18142)", () => {
  it("lists every session, first first, and keeps each current by its changes", async () => {
    const { result } = renderHook(() => useGlobalAssistantSessions(true));
    expect(result.current).toBeNull();
    await act(async () => answer([viewOf({ slot: 0 }), viewOf({ slot: 1 })]));
    expect(result.current?.map((s) => s.slot)).toEqual([0, 1]);

    push(viewOf({ slot: 1, occupied: true, phase: "launching", pinnedAgentId: "codex" }));
    expect(result.current?.map((s) => [s.slot, s.occupied])).toEqual([
      [0, false],
      [1, true],
    ]);
  });

  it("never lets a listing that left before a change undo it", async () => {
    const { result } = renderHook(() => useGlobalAssistantSessions(true));
    push(viewOf({ slot: 1, occupied: true }));
    await act(async () => answer([viewOf({ slot: 0 }), viewOf({ slot: 1, occupied: false })]));
    expect(result.current?.find((s) => s.slot === 1)?.occupied).toBe(true);
    expect(result.current?.map((s) => s.slot)).toEqual([0, 1]);
  });

  it("reads and listens to nothing while disabled, and lets go when it stops", async () => {
    const { result, rerender } = renderHook(({ on }) => useGlobalAssistantSessions(on), {
      initialProps: { on: false },
    });
    expect(help.listGlobalAssistantSessions).not.toHaveBeenCalled();
    rerender({ on: true });
    await act(async () => answer([viewOf({ slot: 0 })]));
    expect(result.current).toHaveLength(1);
    rerender({ on: false });
    expect(result.current).toBeNull();
    expect(listeners.size).toBe(0);
  });
});
