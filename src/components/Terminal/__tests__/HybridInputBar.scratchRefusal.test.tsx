// @vitest-environment jsdom
/**
 * A spoken "scratch that" that removed nothing says why on the composer's
 * border, and from a Canopy reply box's own status region (#14973).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { SCRATCH_REFUSAL_CAPTION, SCRATCH_REFUSAL_STATUS } from "@/services/voiceScratchCommand";
import {
  useVoiceRecordingStore,
  type VoiceRecordingTarget,
  type VoiceScratchRefusal,
} from "@/store/voiceRecordingStore";
import { HybridInputBar } from "../HybridInputBar";

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
  useVoiceRecordingStore.setState({ scratchRefusal: null });
});

async function renderComposer(voiceTarget?: VoiceRecordingTarget) {
  const { container } = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId="term-1"
          cwd={WT_ID}
          agentId="claude"
          onSend={() => {}}
          voiceTarget={voiceTarget}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const caption = () =>
    container.querySelector("[data-scratch-refused-caption]")?.textContent ?? null;
  const status = () =>
    Array.from(container.querySelectorAll('[role="status"]'))
      .map((node) => node.textContent)
      .join("|");
  return { caption, status };
}

const refuse = (
  panelId: string,
  reason: VoiceScratchRefusal["reason"],
  id = 1
): VoiceScratchRefusal => {
  const refusal = { panelId, reason, id };
  act(() => {
    useVoiceRecordingStore.setState({ scratchRefusal: refusal });
  });
  return refusal;
};

describe("HybridInputBar after a scratch that removed nothing (#14973)", () => {
  it("says why on the border, with nothing in the draft", async () => {
    const { caption } = await renderComposer();
    expect(caption()).toBeNull();

    refuse("term-1", "edited");
    expect(caption()).toBe(SCRATCH_REFUSAL_CAPTION.edited);

    refuse("term-1", "nothing", 2);
    expect(caption()).toBe(SCRATCH_REFUSAL_CAPTION.nothing);
  });

  it("clears the caption with the note", async () => {
    const { caption } = await renderComposer();

    refuse("term-1", "edited");
    act(() => {
      useVoiceRecordingStore.setState({ scratchRefusal: null });
    });

    expect(caption()).toBeNull();
  });

  it("shows nothing for a scratch in another pane", async () => {
    const { caption } = await renderComposer();

    refuse("term-2", "edited");

    expect(caption()).toBeNull();
  });

  it("leaves a pane's announcement to the app's announcer", async () => {
    const { status } = await renderComposer();

    refuse("term-1", "edited");

    expect(status()).not.toContain(SCRATCH_REFUSAL_STATUS.edited);
  });

  it("announces it from a Canopy reply box itself, and again for a second refusal", async () => {
    const reply = { panelId: "reply-1", surface: "canopy-reply" } as const;
    const { caption, status } = await renderComposer(reply);

    refuse("reply-1", "edited", 1);
    expect(caption()).toBe(SCRATCH_REFUSAL_CAPTION.edited);
    const first = status();
    expect(first).toContain(SCRATCH_REFUSAL_STATUS.edited);

    refuse("reply-1", "edited", 2);
    // The region's text has to change for the same words to be read again.
    expect(status()).not.toBe(first);
    expect(status()).toContain(SCRATCH_REFUSAL_STATUS.edited);
  });
});
