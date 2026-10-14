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
import { notifyHostResync } from "@/store/hostResyncSignal";

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

  it("asks main to pause, then shows the versioned state rather than the bare reply", async () => {
    clientMock.setPaused.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useAssistantMessaging("proj", 0, null));
    await act(async () => reads[0]!(makeState(1)));
    await act(async () => result.current.setPaused(true));
    expect(clientMock.setPaused).toHaveBeenCalledWith(true);
    expect(result.current.state?.paused).toBe(false);
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]!({ ...makeState(2), paused: true }));
    expect(result.current.state?.paused).toBe(true);
  });

  it("a pause reply never overwrites a newer push", async () => {
    let answerPause: (paused: boolean) => void = () => {};
    clientMock.setPaused.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answerPause = resolve))
    );
    const { result } = renderHook(() => useAssistantMessaging("proj", 0, null));
    await act(async () => reads[0]!(makeState(1)));
    act(() => result.current.setPaused(true));
    act(() => {
      for (const listener of [...listeners]) listener();
    });
    await act(async () => reads[1]!({ ...makeState(5), paused: false }));
    await act(async () => answerPause(true));
    await act(async () => reads[2]!({ ...makeState(4), paused: true }));
    expect(result.current.state?.paused).toBe(false);
    expect(result.current.state?.revision).toBe(5);
  });

  it("never shows one lane's state or refusal on another", async () => {
    let answerEnroll: (value: unknown) => void = () => {};
    clientMock.setLaneEnrolled.mockImplementationOnce(
      () => new Promise((resolve) => (answerEnroll = resolve))
    );
    const { result, rerender } = renderHook(
      ({ slot }) => useAssistantMessaging("proj", slot, null),
      { initialProps: { slot: 0 } }
    );
    await act(async () => reads[0]!(makeState(1, true)));
    act(() => result.current.setLaneEnrolled(true));
    rerender({ slot: 1 });
    expect(result.current.state).toBeNull();
    await act(async () => answerEnroll({ state: makeState(9, true), refusal: "hub-taken" }));
    expect(result.current.state).toBeNull();
    expect(result.current.refusal).toBeNull();
    await act(async () => reads[1]!(makeState(2)));
    expect(result.current.state?.lane.enrolled).toBe(false);
  });

  it("reads again when a remote link resyncs, since pushes may have been lost", () => {
    renderHook(() => useAssistantMessaging("proj", 0, null));
    act(() => notifyHostResync());
    expect(clientMock.getState).toHaveBeenCalledTimes(2);
  });
});
