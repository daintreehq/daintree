// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AssistantMessagingState } from "@shared/types/ipc/assistantMessaging";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    isAvailable: vi.fn(() => true),
    getState: vi.fn(),
    setLaneEnrolled: vi.fn(),
    setPaused: vi.fn(),
    onChanged: vi.fn(),
  },
}));

vi.mock("@/clients/assistantMessagingClient", () => ({ assistantMessagingClient: clientMock }));

import { useAssistantMessaging } from "../useAssistantMessaging";

function makeState(revision: number, enrolled = false): AssistantMessagingState {
  return {
    available: true,
    paused: false,
    canPause: true,
    lane: { enrolled, enrolledElsewhere: false, ended: null },
    revision,
  };
}

const listeners = new Set<() => void>();
let reads: Array<(state: AssistantMessagingState) => void> = [];

beforeEach(() => {
  reads = [];
  listeners.clear();
  clientMock.getState.mockImplementation(
    () => new Promise<AssistantMessagingState>((resolve) => reads.push(resolve))
  );
  clientMock.onChanged.mockImplementation((callback: () => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clientMock.isAvailable.mockImplementation(() => true);
});

describe("useAssistantMessaging", () => {
  it("subscribes before its first read, and reads again on every push", async () => {
    const { result } = renderHook(() => useAssistantMessaging("proj", 0, "s1"));
    expect(clientMock.onChanged.mock.invocationCallOrder[0]).toBeLessThan(
      clientMock.getState.mock.invocationCallOrder[0]!
    );
    expect(clientMock.getState).toHaveBeenCalledWith({ projectId: "proj", slot: 0 });
    await act(async () => reads[0]!(makeState(1)));
    expect(result.current.state?.revision).toBe(1);

    act(() => {
      for (const listener of [...listeners]) listener();
    });
    expect(clientMock.getState).toHaveBeenCalledTimes(2);
  });

  it("drops a read that a newer one overtook", async () => {
    const { result } = renderHook(() => useAssistantMessaging("proj", 0, "s1"));
    act(() => {
      for (const listener of [...listeners]) listener();
    });
    await act(async () => reads[1]!(makeState(4, true)));
    await act(async () => reads[0]!(makeState(2)));
    expect(result.current.state?.revision).toBe(4);
    expect(result.current.state?.lane.enrolled).toBe(true);
  });

  it("reads again when the lane's session changes, and stops listening on unmount", () => {
    const { rerender, unmount } = renderHook(
      ({ sessionId }) => useAssistantMessaging("proj", 0, sessionId),
      { initialProps: { sessionId: "s1" as string | null } }
    );
    rerender({ sessionId: "s2" });
    expect(clientMock.getState).toHaveBeenCalledTimes(2);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("reads nothing where the bridge has no messaging", () => {
    clientMock.isAvailable.mockImplementation(() => false);
    const { result } = renderHook(() => useAssistantMessaging("proj", 0, "s1"));
    expect(clientMock.onChanged).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it("reads nothing without a project", () => {
    const { result } = renderHook(() => useAssistantMessaging(null, 0, null));
    expect(clientMock.getState).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it("keeps a refusal until it's dismissed or the next attempt", async () => {
    clientMock.setLaneEnrolled.mockResolvedValueOnce({
      state: makeState(3),
      refusal: "not-running",
    });
    const { result } = renderHook(() => useAssistantMessaging("proj", 1, null));
    await act(async () => result.current.setLaneEnrolled(true));
    expect(clientMock.setLaneEnrolled).toHaveBeenCalledWith({
      projectId: "proj",
      slot: 1,
      enrolled: true,
    });
    expect(result.current.refusal).toBe("not-running");
    act(() => result.current.dismissRefusal());
    expect(result.current.refusal).toBeNull();
  });

  it("takes the pause main reports back, not the one it asked for", async () => {
    clientMock.setPaused.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useAssistantMessaging("proj", 0, null));
    await act(async () => reads[0]!(makeState(1)));
    await act(async () => result.current.setPaused(true));
    expect(result.current.state?.paused).toBe(false);
  });
});
