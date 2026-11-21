// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import type { GlobalAssistantPhase } from "@shared/types/ipc/help";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/config/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/agents")>()),
  getAgentConfig: (id: string) => ({ name: id === "codex" ? "Codex" : "Claude Code" }),
}));

import {
  approveGlobalAssistantReplacement,
  GlobalAssistantReplaceConfirmDialog,
} from "../GlobalAssistantReplaceConfirmDialog";
import {
  stageGlobalAssistantReplacement,
  useGlobalAssistantReplaceConfirmStore,
} from "@/store/globalAssistantReplaceConfirmStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { ClientAppError } from "@/utils/clientAppError";

let replaceGlobalAssistant: Mock;

function stage(phase: GlobalAssistantPhase = "running"): string {
  expect(
    stageGlobalAssistantReplacement({
      agentId: "codex",
      prompt: "Continue from the hand-off:\n- tests pass",
      expected: { generation: 4, phase },
      currentAgentId: phase === "absent" ? null : "claude",
      pluginName: "Hand-off",
    })
  ).toBe(true);
  return useGlobalAssistantReplaceConfirmStore.getState().current!.requestId;
}

describe("GlobalAssistantReplaceConfirmDialog (#18140)", () => {
  beforeAll(async () => {
    await primeRadix();
  });

  beforeEach(() => {
    notify.mockReset();
    replaceGlobalAssistant = vi.fn(async () => ({}));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { help: { replaceGlobalAssistant } },
    });
    useGlobalAssistantReplaceConfirmStore.setState({ current: null, requestSeq: 0 });
    useHelpPanelStore.setState(useHelpPanelStore.getInitialState(), true);
  });

  afterEach(cleanup);

  it("names who asks, both agents and the hand-off, and replaces nothing when declined", async () => {
    stage();
    render(<GlobalAssistantReplaceConfirmDialog />);

    expect(await screen.findByText("Replace the global assistant?")).toBeTruthy();
    expect(
      screen.getByText(
        "Hand-off asks to continue the global assistant in Codex. Claude Code stops in every window and Codex starts a new conversation from the message below."
      )
    ).toBeTruthy();
    expect(screen.getByTestId("global-assistant-replace-prompt").textContent).toBe(
      "Continue from the hand-off:\n- tests pass"
    );
    expect(screen.getByRole("button", { name: "Replace global assistant" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useGlobalAssistantReplaceConfirmStore.getState().current).toBeNull();
    expect(replaceGlobalAssistant).not.toHaveBeenCalled();
    expect(useHelpPanelStore.getState().isOpen).toBe(false);
  });

  it("asks to start a new conversation when none runs", async () => {
    stage("absent");
    render(<GlobalAssistantReplaceConfirmDialog />);

    expect(await screen.findByText("Start a new global assistant conversation?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start global assistant" })).toBeTruthy();
  });

  it("replaces the run once, as it was shown, and shows the global assistant", async () => {
    const requestId = stage();

    await Promise.all([
      approveGlobalAssistantReplacement(requestId),
      approveGlobalAssistantReplacement(requestId),
    ]);

    expect(replaceGlobalAssistant).toHaveBeenCalledTimes(1);
    expect(replaceGlobalAssistant).toHaveBeenCalledWith({
      agentId: "codex",
      prompt: "Continue from the hand-off:\n- tests pass",
      expected: { generation: 4, phase: "running" },
    });
    expect(useGlobalAssistantReplaceConfirmStore.getState().current).toBeNull();
    expect(useHelpPanelStore.getState()).toMatchObject({ isOpen: true, globalSelected: true });
  });

  it("says why when main refuses it", async () => {
    replaceGlobalAssistant.mockRejectedValueOnce(
      new ClientAppError(
        "STALE_GENERATION",
        "changed",
        "The global assistant changed since you were asked. Nothing was replaced."
      )
    );

    await approveGlobalAssistantReplacement(stage());

    expect(notify).toHaveBeenCalledWith({
      type: "error",
      title: "Couldn't replace global assistant",
      message: "The global assistant changed since you were asked. Nothing was replaced.",
    });
  });

  it("stays quiet about a replacement stopped while it started", async () => {
    replaceGlobalAssistant.mockRejectedValueOnce(new ClientAppError("CANCELLED", "stopped"));

    await approveGlobalAssistantReplacement(stage());

    expect(notify).not.toHaveBeenCalled();
  });
});
