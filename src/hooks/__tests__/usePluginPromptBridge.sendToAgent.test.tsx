// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { PluginUiPromptRequest } from "@shared/types/pluginUiPrompt";

const { draftAgentContext } = vi.hoisted(() => ({
  draftAgentContext: vi.fn((terminalId: string) => ({ status: "drafted", terminalId })),
}));
vi.mock("@/services/agentHandoff/agentDraft", () => ({ draftAgentContext }));

import { usePluginPromptBridge } from "../usePluginPromptBridge";
import { usePluginPromptStore } from "@/store/pluginPromptStore";

let deliver: ((request: PluginUiPromptRequest) => Promise<void> | void) | null = null;
const sendUiPromptResponse = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      pluginBridge: {
        onUiPromptRequest: (cb: typeof deliver) => {
          deliver = cb;
          return () => {};
        },
        onUiPromptCancel: () => () => {},
        sendUiPromptResponse,
      },
    },
  });
});

afterEach(() => {
  usePluginPromptStore.getState().reset();
  Reflect.deleteProperty(window, "electron");
  deliver = null;
});

describe("usePluginPromptBridge — sendToAgent", () => {
  it("drafts a targeted send at once, without queueing a dialog", async () => {
    renderHook(() => usePluginPromptBridge());
    await deliver!({
      promptId: "p1",
      pluginId: "acme",
      params: {
        kind: "sendToAgent",
        request: { text: "body", sourceLabel: "Acme", terminalId: "t-1" },
      },
    });

    expect(draftAgentContext).toHaveBeenCalledWith("t-1", {
      text: "body",
      sourceLabel: "Acme",
      terminalId: "t-1",
    });
    expect(usePluginPromptStore.getState().current).toBeNull();
    expect(sendUiPromptResponse).toHaveBeenCalledWith({
      promptId: "p1",
      result: { status: "drafted", terminalId: "t-1" },
    });
  });

  it("drops a targeted send that arrives after main's deadline, drafting nothing", async () => {
    renderHook(() => usePluginPromptBridge());
    await deliver!({
      promptId: "late",
      pluginId: "acme",
      expiresAt: Date.now() - 1,
      params: {
        kind: "sendToAgent",
        request: { text: "body", sourceLabel: "Acme", terminalId: "t-1" },
      },
    });
    expect(draftAgentContext).not.toHaveBeenCalled();
    expect(sendUiPromptResponse).not.toHaveBeenCalled();
  });

  it("queues an untargeted send as a picker", () => {
    renderHook(() => usePluginPromptBridge());
    void deliver!({
      promptId: "p2",
      pluginId: "acme",
      params: { kind: "sendToAgent", request: { text: "body", sourceLabel: "Acme" } },
    });

    expect(draftAgentContext).not.toHaveBeenCalled();
    expect(usePluginPromptStore.getState().current?.promptId).toBe("p2");
  });
});
