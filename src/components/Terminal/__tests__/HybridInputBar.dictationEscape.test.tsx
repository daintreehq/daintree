// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { HybridInputBar } from "../HybridInputBar";

describe("HybridInputBar dictation Escape", () => {
  const WT_ID = "/repo/wt";

  beforeEach(() => {
    initBuiltInPanelKinds();
    setCurrentViewStore(createWorktreeStore());
    const panel = {
      id: "term-1",
      title: "claude",
      kind: "terminal",
      cwd: WT_ID,
      cols: 120,
      rows: 40,
      worktreeId: WT_ID,
      location: "grid",
      hasPty: true,
      detectedAgentId: "claude",
      launchAgentId: "claude",
      agentState: "waiting",
      runtimeStatus: "running",
    } as PtyPanelData;
    usePanelStore.setState({
      panelsById: { [panel.id]: panel },
      panelIds: [panel.id],
      panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
      focusedId: panel.id,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useVoiceRecordingStore.setState({ dictationCancelConfirm: null });
  });

  async function pressEscapeInComposer(dictationTakesIt: boolean) {
    const handleEscape = vi
      .spyOn(voiceRecordingService, "handleEscape")
      .mockReturnValue(dictationTakesIt);
    const onSendKey = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar
            terminalId="term-1"
            cwd={WT_ID}
            agentId="claude"
            onSend={() => {}}
            onSendKey={onSendKey}
          />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    const content = container.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      content.dispatchEvent(event);
    });
    return { handleEscape, onSendKey, event };
  }

  it("offers its own terminal's Escape to dictation before the agent", async () => {
    const { handleEscape, onSendKey, event } = await pressEscapeInComposer(true);

    expect(handleEscape).toHaveBeenCalledWith("term-1");
    expect(onSendKey).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("sends Escape to the agent when dictation declines it", async () => {
    const { handleEscape, onSendKey } = await pressEscapeInComposer(false);

    expect(handleEscape).toHaveBeenCalledWith("term-1");
    expect(onSendKey).toHaveBeenCalledWith("escape");
  });

  describe("while a first Escape waits for the second (#14927)", () => {
    async function renderComposer() {
      const { container } = render(
        <TooltipProvider>
          <WorktreeStoreContext.Provider value={createWorktreeStore()}>
            <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={() => {}} />
          </WorktreeStoreContext.Provider>
        </TooltipProvider>
      );
      await act(async () => {});
      const overlay = () => container.querySelector("[data-dictation-cancel-confirm]");
      const status = () =>
        Array.from(container.querySelectorAll('[role="status"]'))
          .map((node) => node.textContent)
          .join("|");
      return { container, overlay, status };
    }

    const arm = (panelId: string, msLeft: number) =>
      act(() => {
        useVoiceRecordingStore.setState({
          dictationCancelConfirm: {
            panelId,
            sessionId: "session-1",
            expiresAt: performance.now() + msLeft,
          },
        });
      });

    it("covers the composer with the prompt and the seconds left, and announces it", async () => {
      const { container, overlay, status } = await renderComposer();

      arm("term-1", 2_500);

      expect(overlay()?.textContent).toContain("Press Escape again to cancel dictation");
      expect(container.querySelector("[data-dictation-cancel-countdown]")?.textContent).toBe("3s");
      expect(status()).toContain("Press Escape again to cancel dictation");
      // The composer under it stays live.
      expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    });

    it("clears the overlay and the announcement when it stands down", async () => {
      const { overlay, status } = await renderComposer();

      arm("term-1", 4_000);
      act(() => {
        useVoiceRecordingStore.setState({ dictationCancelConfirm: null });
      });

      expect(overlay()).toBeNull();
      expect(status()).not.toContain("Press Escape again");
    });

    it("shows nothing for a dictation into another pane", async () => {
      const { overlay, status } = await renderComposer();

      arm("term-2", 4_000);

      expect(overlay()).toBeNull();
      expect(status()).not.toContain("Press Escape again");
    });
  });
});
