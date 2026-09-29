// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { PluginUiPromptRequest } from "@shared/types/pluginUiPrompt";
import type { PluginSendToAgentResult } from "@shared/types/plugin";

const { draftAgentContext } = vi.hoisted(() => ({
  draftAgentContext: vi.fn((terminalId: string) => ({ status: "drafted", terminalId })),
}));
vi.mock("@/services/agentHandoff/agentDraft", () => ({ draftAgentContext }));

import { usePluginPromptBridge } from "../usePluginPromptBridge";
import { usePluginPromptStore } from "@/store/pluginPromptStore";

let deliver: ((request: PluginUiPromptRequest) => Promise<void> | void) | null = null;
let cancel: ((payload: { pluginId: string; promptId?: string }) => void) | null = null;
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
        onUiPromptCancel: (cb: typeof cancel) => {
          cancel = cb;
          return () => {};
        },
        sendUiPromptResponse,
      },
    },
  });
});

afterEach(() => {
  usePluginPromptStore.getState().reset();
  Reflect.deleteProperty(window, "electron");
  deliver = null;
  cancel = null;
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

  it("tells main a picker was accepted, then reports what the launch did despite a cancel", async () => {
    renderHook(() => usePluginPromptBridge());
    const answered = deliver!({
      promptId: "p3",
      pluginId: "acme",
      params: { kind: "sendToAgent", request: { text: "body", sourceLabel: "Acme" } },
    });

    // The user picks "New agent in new worktree"; setup is still running.
    let finishLaunch!: (value: PluginSendToAgentResult) => void;
    const launch = new Promise<PluginSendToAgentResult>((resolve) => {
      finishLaunch = resolve;
    });
    usePluginPromptStore.getState().resolveCurrent(launch);
    expect(sendUiPromptResponse).toHaveBeenCalledTimes(1);
    expect(sendUiPromptResponse).toHaveBeenLastCalledWith({ promptId: "p3", accepted: true });

    // The plugin gives up mid-setup: the picker is gone, so there is nothing to
    // dismiss and nothing to report yet.
    cancel!({ pluginId: "acme", promptId: "p3" });
    await Promise.resolve();
    expect(sendUiPromptResponse).toHaveBeenCalledTimes(1);

    const outcome: PluginSendToAgentResult = {
      status: "refused",
      reason: "launch-failed",
      worktreeId: "wt-new",
    };
    finishLaunch(outcome);
    await answered;
    expect(sendUiPromptResponse).toHaveBeenLastCalledWith({ promptId: "p3", result: outcome });
  });

  it("answers a picker dismissed by main's cancel without claiming an acceptance", async () => {
    renderHook(() => usePluginPromptBridge());
    const answered = deliver!({
      promptId: "p4",
      pluginId: "acme",
      params: { kind: "sendToAgent", request: { text: "body", sourceLabel: "Acme" } },
    });
    cancel!({ pluginId: "acme", promptId: "p4" });
    await answered;
    expect(sendUiPromptResponse).toHaveBeenCalledTimes(1);
    expect(sendUiPromptResponse).toHaveBeenCalledWith({
      promptId: "p4",
      result: { status: "cancelled" },
    });
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
