import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAssistantChatStore } from "../assistantChatStore";

describe("assistantChatStore", () => {
  beforeEach(() => {
    useAssistantChatStore.getState().reset();
  });

  afterEach(() => {
    useAssistantChatStore.getState().reset();
  });

  it("clears conversation safely when electron bridge is unavailable", () => {
    (globalThis as unknown as { window?: unknown }).window = {
      ...((globalThis as unknown as { window?: unknown }).window as Record<string, unknown>),
      electron: undefined,
    } as unknown;

    useAssistantChatStore.getState().addMessage({
      id: "msg-1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(() => useAssistantChatStore.getState().clearConversation()).not.toThrow();

    const state = useAssistantChatStore.getState();
    expect(state.conversation.messages).toEqual([]);
    expect(state.streamingState).toBeNull();
    expect(state.streamingMessageId).toBeNull();
  });
});
