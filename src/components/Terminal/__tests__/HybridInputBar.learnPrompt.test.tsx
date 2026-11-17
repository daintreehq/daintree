// @vitest-environment jsdom
/**
 * The offer to learn a word sits in a row painted as the composer's band, on
 * its rail, not on the pane's app canvas, which showed between the terminal and
 * the composer (#17278). The row stays outside the draft's typing root, whose
 * keys (a voice wait's Enter, type-anywhere) are not the offer's buttons'.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useDictionaryLearnPromptStore } from "@/store/dictionaryLearnPromptStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { hasUsefulFocus } from "@/lib/typeAnywhere";
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

let worktreeStore: ReturnType<typeof createWorktreeStore>;

beforeEach(() => {
  initBuiltInPanelKinds();
  worktreeStore = createWorktreeStore();
  setCurrentViewStore(worktreeStore);
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
  acceptSuggestion = vi.fn(async () => ({
    dictionary: [],
    suggestedDictionary: [],
    conflicts: [],
  }));
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
      <WorktreeStoreContext.Provider value={worktreeStore}>
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
  const band = result.container.querySelector<HTMLElement>('[data-hybrid-input-root="term-1"]');
  if (!band) throw new Error("the composer's band did not render");
  const before = { bandTop: utility(band, "pt") };
  act(() => {
    useDictionaryLearnPromptStore
      .getState()
      .offer("term-1", { word: "Zustand", utterance: "zoo stand" });
  });
  const offer = screen.getByText(/Learn/).closest<HTMLElement>('[role="status"]');
  if (!offer) throw new Error("the offer did not render");
  return { band, offer, row: offer.parentElement!, before };
}

/** The value of a spacing utility on `element`, such as `3.5` for `px-3.5`. */
function utility(element: Element, prefix: string): string | undefined {
  return new RegExp(`(?:^|\\s)${prefix}-([\\w.]+)(?=\\s|$)`).exec(element.className)?.[1];
}

describe("HybridInputBar learn-word offer", () => {
  it("paints its row as the band, with nothing of the pane between the terminal and the composer", async () => {
    const { band, row } = await mountWithOffer();

    expect(row.parentElement?.firstElementChild).toBe(row);
    expect(row.nextElementSibling).toBe(band);
    expect(band.style.backgroundColor).not.toBe("");
    expect(row.style.backgroundColor).toBe(band.style.backgroundColor);
  });

  it("holds the band's rail, and sits above the draft by the gap between strips", async () => {
    holdBackAttachments(composerUploadSurface("term-1"), [
      { type: "image", filePath: "/tmp/shot.png", thumbnailDataUrl: "data:x" },
    ]);
    const { band, row, before } = await mountWithOffer();
    const heldBack = band.querySelector<HTMLElement>('[data-testid="held-back-attachments"]');
    if (!heldBack) throw new Error("the held-back attachments did not render");

    expect(utility(band, "px")).toBeDefined();
    expect(utility(row, "px")).toBe(utility(band, "px"));
    // The row takes over the band's top edge; what the band keeps is the gap
    // the strips leave between one another.
    expect(utility(row, "pt")).toBe(before.bandTop);
    expect(utility(heldBack, "mb")).toBeDefined();
    expect(utility(band, "pt")).toBe(utility(heldBack, "mb"));
  });

  it("brings an opaque app surface for its app inks to read on", async () => {
    const { offer } = await mountWithOffer();

    expect(offer.className).toMatch(/(?:^|\s)bg-surface-[\w-]+(?=\s|$)/);
  });

  it("keeps its buttons out of the draft's typing root", async () => {
    const { offer } = await mountWithOffer();
    const add = within(offer).getByRole("button", { name: "Add" });

    expect(add.closest("[data-hybrid-input-root]")).toBeNull();
    act(() => add.focus());
    expect(hasUsefulFocus(document.activeElement)).toBe(false);
  });

  it("still takes its answer", async () => {
    const { offer } = await mountWithOffer();

    fireEvent.click(within(offer).getByRole("button", { name: "Add" }));
    await act(async () => {});

    expect(acceptSuggestion).toHaveBeenCalledWith({ word: "Zustand", utterance: "zoo stand" });
    expect(offer.isConnected).toBe(false);
  });
});
