// @vitest-environment jsdom
/**
 * The offer to learn a word sits on the composer's band with the other strips
 * above the draft, not over the pane's app canvas above the band, where the
 * canvas showed between the terminal and the composer (#17278).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useDictionaryLearnPromptStore } from "@/store/dictionaryLearnPromptStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";
import {
  _resetPendingUploadsForTests,
  composerUploadSurface,
  holdBackAttachments,
} from "../uploads/pendingUploads";

const WT_ID = "/repo/wt";
const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

let acceptSuggestion: ReturnType<typeof vi.fn>;

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
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  useDictionaryLearnPromptStore.setState({ prompts: new Map() });
  acceptSuggestion = vi.fn(async () => ({ dictionary: [], suggestedDictionary: [], conflicts: [] }));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      voiceDictionary: { acceptSuggestion, dismissSuggestion: vi.fn() },
      notification: { playUiEvent: vi.fn().mockResolvedValue(undefined) },
      runHistory: { append: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetPendingUploadsForTests();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  document.body.innerHTML = "";
});

async function mountWithOffer() {
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId="term-1"
          cwd={WT_ID}
          agentId="claude"
          onSend={() => Promise.resolve(true)}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  act(() => {
    useDictionaryLearnPromptStore
      .getState()
      .offer("term-1", { word: "Zustand", utterance: "zoo stand" });
  });
  const band = result.container.querySelector<HTMLElement>('[data-hybrid-input-root="term-1"]');
  if (!band) throw new Error("the composer's band did not render");
  const offer = screen.getByText(/Learn/).closest<HTMLElement>('[role="status"]');
  if (!offer) throw new Error("the offer did not render");
  return { band, offer };
}

describe("HybridInputBar learn-word offer", () => {
  it("sits on the composer's band, with nothing of the pane between the terminal and the band", async () => {
    const { band, offer } = await mountWithOffer();

    expect(offer.parentElement).toBe(band);
    expect(band.style.backgroundColor).not.toBe("");
    expect(band.previousElementSibling).toBeNull();
  });

  it("shares the band's rail with the held-back attachments above the draft", async () => {
    holdBackAttachments(composerUploadSurface("term-1"), [
      { type: "image", filePath: "/tmp/shot.png", thumbnailDataUrl: "data:x" },
    ]);
    const { band, offer } = await mountWithOffer();
    const heldBack = band.querySelector<HTMLElement>('[data-testid="held-back-attachments"]');

    expect(heldBack?.parentElement).toBe(band);
    expect(offer.parentElement).toBe(heldBack?.parentElement);
  });

  it("still takes its answer from inside the band", async () => {
    const { offer } = await mountWithOffer();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await act(async () => {});

    expect(acceptSuggestion).toHaveBeenCalledWith({ word: "Zustand", utterance: "zoo stand" });
    expect(offer.isConnected).toBe(false);
  });
});
