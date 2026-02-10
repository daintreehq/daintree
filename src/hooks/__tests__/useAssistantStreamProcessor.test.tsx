// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { onChunkMock, subscribeMock } = vi.hoisted(() => ({
  onChunkMock: vi.fn(() => undefined),
  subscribeMock: vi.fn(() => () => {}),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: vi.fn(() => []),
  },
}));

vi.mock("@/components/Assistant/assistantContext", () => ({
  getAssistantContext: vi.fn(() => ({})),
}));

vi.mock("@/store/assistantChatStore", () => {
  const state = {
    conversation: {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    },
    pendingAutoResume: null,
    inputHasFocus: false,
    inputDraftText: "",
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    setStreamingState: vi.fn(),
    setRetryState: vi.fn(),
    setLoading: vi.fn(),
    setError: vi.fn(),
    setPendingAutoResume: vi.fn(),
  };

  return {
    useAssistantChatStore: {
      getState: vi.fn(() => state),
      subscribe: subscribeMock,
    },
  };
});

import { useAssistantStreamProcessor } from "../useAssistantStreamProcessor";

describe("useAssistantStreamProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    Object.defineProperty(window, "electron", {
      value: {
        assistant: {
          onChunk: onChunkMock,
          acknowledgeEvent: vi.fn().mockResolvedValue(true),
          cancel: vi.fn(),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
      },
      configurable: true,
      writable: true,
    });
  });

  it("unmounts safely even when onChunk returns non-function cleanup", () => {
    const { unmount } = renderHook(() => useAssistantStreamProcessor());
    expect(() => unmount()).not.toThrow();
  });
});
