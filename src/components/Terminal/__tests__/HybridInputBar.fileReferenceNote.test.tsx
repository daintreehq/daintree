// @vitest-environment jsdom
/**
 * A spoken file reference that found no file says so on the composer's
 * border, and from a Canopy reply box's own status region (#14983).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import {
  unresolvedFileReferencesCaption,
  unresolvedFileReferencesStatus,
} from "@/services/voiceFileReferences";
import {
  useVoiceRecordingStore,
  type VoiceFileReferenceNote,
  type VoiceRecordingTarget,
} from "@/store/voiceRecordingStore";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";
const MISSED = [{ description: "input bar component" }];

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  useVoiceRecordingStore.setState({ fileReferenceNote: null, scratchRefusal: null });
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
    container.querySelector("[data-file-reference-caption]")?.textContent ?? null;
  const status = () =>
    Array.from(container.querySelectorAll('[role="status"]'))
      .map((node) => node.textContent)
      .join("|");
  return { caption, status };
}

const miss = (
  panelId: string,
  references: VoiceFileReferenceNote["references"] = MISSED,
  id = 1
): VoiceFileReferenceNote => {
  const note = { panelId, references, id };
  act(() => {
    useVoiceRecordingStore.setState({ fileReferenceNote: note });
  });
  return note;
};

describe("HybridInputBar after a spoken file reference found no file (#14983)", () => {
  it("says which description found nothing on the border, with nothing in the draft", async () => {
    const { caption } = await renderComposer();
    expect(caption()).toBeNull();

    miss("term-1");
    expect(caption()).toBe(unresolvedFileReferencesCaption(MISSED));

    const failed = [{ description: "router", failed: true as const }];
    miss("term-1", failed, 2);
    expect(caption()).toBe(unresolvedFileReferencesCaption(failed));
  });

  it("shows nothing for a miss in another pane", async () => {
    const { caption } = await renderComposer();

    miss("term-2");

    expect(caption()).toBeNull();
  });

  it("lets the note go once it has been on the border its time, and not a newer one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { caption } = await renderComposer();

    miss("term-1");
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    // A second miss starts the time again.
    const second = miss("term-1", MISSED, 2);
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(useVoiceRecordingStore.getState().fileReferenceNote).toBe(second);
    expect(caption()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(useVoiceRecordingStore.getState().fileReferenceNote).toBeNull();
    expect(caption()).toBeNull();
  });

  it("doesn't read a pane's miss out itself: the app's announcer does", async () => {
    const { status } = await renderComposer();

    miss("term-1");

    expect(status()).not.toContain(unresolvedFileReferencesStatus(MISSED));
  });

  it("announces it from a Canopy reply box itself, and again for a second miss", async () => {
    const reply = { panelId: "reply-1", surface: "canopy-reply" } as const;
    const { caption, status } = await renderComposer(reply);

    miss("reply-1", MISSED, 1);
    expect(caption()).toBe(unresolvedFileReferencesCaption(MISSED));
    const first = status();
    expect(first).toContain(unresolvedFileReferencesStatus(MISSED));

    miss("reply-1", MISSED, 2);
    // The region's text has to change for the same words to be read again.
    expect(status()).not.toBe(first);
    expect(status()).toContain(unresolvedFileReferencesStatus(MISSED));
  });
});
