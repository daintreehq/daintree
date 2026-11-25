// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import type { GlobalAssistantPhase } from "@shared/types/ipc/help";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));
const view = vi.hoisted(() => ({
  cached: false,
  listeners: new Set<(phase: string) => void>(),
}));
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  isProjectViewCached: () => view.cached,
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    view.listeners.add(listener);
    return () => view.listeners.delete(listener);
  },
}));
vi.mock("@/config/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/agents")>()),
  getAgentConfig: () => ({ name: "Claude Code" }),
}));

import {
  approveGlobalAssistantResume,
  GlobalAssistantResumeConfirmDialog,
} from "../GlobalAssistantResumeConfirmDialog";
import {
  stageGlobalAssistantResume,
  useGlobalAssistantResumeConfirmStore,
} from "@/store/globalAssistantResumeConfirmStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { ClientAppError } from "@/utils/clientAppError";

let resumeGlobalAssistantConversation: Mock;

function stage(
  phase: GlobalAssistantPhase = "running",
  extra: { pluginName?: string | null; namesSession?: boolean; slot?: 0 | 1 } = {}
): string {
  expect(
    stageGlobalAssistantResume({
      slot: extra.slot ?? 0,
      agentId: "claude",
      agentSessionId: "conv-a",
      title: "Planning the release",
      expected: { generation: 4, phase },
      pluginName: extra.pluginName ?? null,
      namesSession: extra.namesSession ?? false,
    })
  ).toBe(true);
  return useGlobalAssistantResumeConfirmStore.getState().current!.requestId;
}

describe("GlobalAssistantResumeConfirmDialog (#18169)", () => {
  beforeAll(async () => {
    await primeRadix();
  });

  beforeEach(() => {
    notify.mockReset();
    view.cached = false;
    view.listeners.clear();
    resumeGlobalAssistantConversation = vi.fn(async () => ({}));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { help: { resumeGlobalAssistantConversation } },
    });
    useGlobalAssistantResumeConfirmStore.setState({ current: null, requestSeq: 0 });
    useHelpPanelStore.setState(useHelpPanelStore.getInitialState(), true);
  });

  afterEach(cleanup);

  it("names the conversation and what it costs the run, and switches nothing when declined", async () => {
    stage();
    render(<GlobalAssistantResumeConfirmDialog />);

    expect(await screen.findByText("Reopen 'Planning the release'?")).toBeTruthy();
    const body = screen.getByRole("alertdialog").textContent ?? "";
    expect(body).toContain("Claude Code stops in every window");
    expect(body).toContain("stays in earlier conversations");
    expect(body).toContain("workers it launched move to this conversation");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useGlobalAssistantResumeConfirmStore.getState().current).toBeNull();
    expect(resumeGlobalAssistantConversation).not.toHaveBeenCalled();
  });

  it("says a session with nothing running starts on it, and names who asked", async () => {
    stage("absent", { pluginName: "Chief of staff", namesSession: true, slot: 1 });
    render(<GlobalAssistantResumeConfirmDialog />);

    expect(await screen.findByText("Reopen 'Planning the release' in session 2?")).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Chief of staff asks to reopen this conversation.");
    expect(body).toContain("Session 2 starts on it instead of any conversation it kept");
    expect(body).not.toContain("stops in every window");
  });

  it("reopens the conversation in the session it was asked about, as it was shown", async () => {
    const requestId = stage("running", { namesSession: true, slot: 1 });

    await approveGlobalAssistantResume(requestId);

    expect(resumeGlobalAssistantConversation).toHaveBeenCalledWith({
      slot: 1,
      agentSessionId: "conv-a",
      expected: { generation: 4, phase: "running" },
    });
    expect(useHelpPanelStore.getState()).toMatchObject({
      isOpen: true,
      globalSelected: true,
      globalSlot: 1,
    });
    // Answered once: a second answer finds nothing.
    await approveGlobalAssistantResume(requestId);
    expect(resumeGlobalAssistantConversation).toHaveBeenCalledTimes(1);
  });

  it("asks once at a time, and stops asking once its view is put away", async () => {
    const requestId = stage();
    expect(
      stageGlobalAssistantResume({
        slot: 0,
        agentId: "claude",
        agentSessionId: "conv-c",
        title: "Another",
        expected: { generation: 4, phase: "running" },
        pluginName: null,
        namesSession: false,
      })
    ).toBe(false);

    act(() => {
      for (const listener of view.listeners) listener("cached");
    });
    expect(useGlobalAssistantResumeConfirmStore.getState().current).toBeNull();
    await approveGlobalAssistantResume(requestId);
    expect(resumeGlobalAssistantConversation).not.toHaveBeenCalled();
  });

  it("says in main's words why it didn't reopen, and nothing when the launch was stopped", async () => {
    resumeGlobalAssistantConversation.mockRejectedValueOnce(
      new ClientAppError(
        "STALE_GENERATION",
        "changed",
        "The global assistant changed since you chose that conversation."
      )
    );
    await approveGlobalAssistantResume(stage());
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Couldn't reopen conversation",
        message: "The global assistant changed since you chose that conversation.",
      })
    );

    notify.mockReset();
    resumeGlobalAssistantConversation.mockRejectedValueOnce(
      new ClientAppError("CANCELLED", "stopped")
    );
    await approveGlobalAssistantResume(stage());
    expect(notify).not.toHaveBeenCalled();
  });
});
