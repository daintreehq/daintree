// @vitest-environment jsdom
/**
 * Outside writes reach the composer through the draft store and a revision
 * bump. Dictation's writes leave the caret where the user has it, or move it
 * after the words when it sat where they went; every other writer still puts
 * it at the end (#14634).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { takeLandedCorrection } from "@/services/voiceCorrectionLanding";
import { setPendingComposerSelection } from "@/lib/composerCaret";
import { recordScratchLanded, takeScratchLanded } from "@/services/voiceScratchCommand";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";

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
    // Unfocused, so the composer never takes real focus: jsdom's DOM
    // selection would be read back over the caret (focus is stubbed below).
    focusedId: null,
  });
  useTerminalInputStore.setState({ draftInputs: new Map() });
  useVoiceRecordingStore.setState({ panelBuffers: {} });
  takeLandedCorrection("term-1", undefined, "");
  takeScratchLanded("term-1", undefined, "");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount(onSend: (payload: unknown) => void = () => {}) {
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { ...result, view };
}

async function write(text: string, options?: { keepsSelection?: boolean }): Promise<void> {
  await act(async () => {
    const inputs = useTerminalInputStore.getState();
    inputs.setDraftInput("term-1", text);
    inputs.bumpExternalDraftRevision(options);
  });
}

// Focus is stubbed rather than given: jsdom's DOM selection never follows a
// dispatched one, and a focused editor reads it back over the caret.
async function focusAt(view: EditorView, anchor: number, head = anchor): Promise<void> {
  Object.defineProperty(view, "hasFocus", { configurable: true, get: () => true });
  await act(async () => {
    view.dispatch({ selection: { anchor, head } });
  });
}

const selection = (view: EditorView) => {
  const { anchor, head } = view.state.selection.main;
  return { anchor, head };
};

describe("HybridInputBar caret through outside writes", () => {
  it("keeps the caret where the user is when dictation lands elsewhere", async () => {
    const { view } = await mount();
    await write("Fix the bug. Then test.");
    await focusAt(view, 3);
    expect(view.hasFocus).toBe(true);

    await write("Fix the bug. Hello. Then test.", { keepsSelection: true });

    expect(view.state.doc.toString()).toBe("Fix the bug. Hello. Then test.");
    expect(selection(view)).toEqual({ anchor: 3, head: 3 });
  });

  it("carries a caret after the dictation along with its text", async () => {
    const { view } = await mount();
    await write("one two");
    await focusAt(view, 4);

    await write("zero one two", { keepsSelection: true });

    expect(selection(view)).toEqual({ anchor: 9, head: 9 });
  });

  it("moves the caret to where the writer asked when it followed the words", async () => {
    const { view } = await mount();
    await write("hello world");
    await focusAt(view, 6);

    setPendingComposerSelection("term-1", "hello big world", { from: 9, to: 9 });
    await write("hello big world", { keepsSelection: true });

    expect(selection(view)).toEqual({ anchor: 9, head: 9 });
  });

  it("ignores a requested caret for a draft the composer never shows", async () => {
    const { view } = await mount();
    await write("hello world");
    await focusAt(view, 2);

    setPendingComposerSelection("term-1", "something else", { from: 9, to: 9 });
    await write("hello big world", { keepsSelection: true });

    expect(selection(view)).toEqual({ anchor: 2, head: 2 });
    // Used up, so it can't land if that draft turns up later.
    await write("something else", { keepsSelection: true });
    expect(selection(view)).not.toEqual({ anchor: 9, head: 9 });
  });

  it("collapses the selection after words that replaced it with the same text", async () => {
    const { view } = await mount();
    await write("hello world");
    await focusAt(view, 6, 11);

    setPendingComposerSelection("term-1", "hello world", { from: 11, to: 11 });
    await write("hello world", { keepsSelection: true });

    expect(selection(view)).toEqual({ anchor: 11, head: 11 });
  });

  it("still puts the caret at the end for any other writer", async () => {
    const { view } = await mount();
    await write("hello");
    await focusAt(view, 1);

    await write("hello there");

    expect(selection(view)).toEqual({ anchor: 11, head: 11 });
  });

  it("puts the caret at the end when another writer's write lands in the same pass", async () => {
    const { view } = await mount();
    await write("hello");
    await focusAt(view, 1);

    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput("term-1", "hello x");
      inputs.bumpExternalDraftRevision();
      inputs.setDraftInput("term-1", "hello x dictated");
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
    });

    expect(selection(view)).toEqual({ anchor: 16, head: 16 });
  });
});

describe("HybridInputBar scrolling on outside writes (#14928)", () => {
  it("leaves dictation's writes to its follower, and scrolls to the caret for any other", async () => {
    const { view } = await mount();
    await write("hello");
    const dispatch = vi.spyOn(view, "dispatch");
    const scrolls = () =>
      dispatch.mock.calls.flatMap(([spec]) => (spec?.changes ? [spec.scrollIntoView] : []));

    await write("hello dictated", { keepsSelection: true });
    await write("hello dictated there");

    expect(scrolls()).toEqual([false, true]);
  });
});

describe("HybridInputBar after a spoken scratch mid-draft (#14636)", () => {
  it("puts the caret where the words were, and undo brings them back", async () => {
    const { view } = await mount();
    await write("Intro. Outro.");
    await focusAt(view, 7);
    setPendingComposerSelection("term-1", "Intro. One. Outro.", { from: 11, to: 11 });
    await write("Intro. One. Outro.", { keepsSelection: true });
    expect(selection(view)).toEqual({ anchor: 11, head: 11 });

    // As `scratchLastUtterance` writes it.
    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      setPendingComposerSelection("term-1", "Intro. Outro.", { from: 7, to: 7 });
      inputs.setDraftInput("term-1", "Intro. Outro.");
      recordScratchLanded("term-1", undefined, "Intro. Outro.");
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
    });
    expect(view.state.doc.toString()).toBe("Intro. Outro.");
    expect(selection(view)).toEqual({ anchor: 7, head: 7 });

    await act(async () => {
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", {
          key: "z",
          metaKey: /Mac/.test(navigator.platform),
          ctrlKey: !/Mac/.test(navigator.platform),
        }),
        "editor"
      );
    });
    expect(view.state.doc.toString()).toBe("Intro. One. Outro.");
    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe("Intro. One. Outro.");
  });
});

describe("HybridInputBar dictation caret", () => {
  afterEach(() => {
    act(() => useVoiceRecordingStore.getState().finishSession());
  });

  it("marks where a dictation started away from the composer will write, and says when it hears", async () => {
    const { view } = await mount();
    expect(view.hasFocus).toBe(false);
    const placeholder = () => view.contentDOM.querySelector(".cm-placeholder")?.textContent;
    const caretPhase = () =>
      view.contentDOM.querySelector<HTMLElement>(".cm-voice-caret")?.dataset.phase ?? null;
    const seen: [string | null | undefined, string | null][] = [];
    const record = () => seen.push([placeholder(), caretPhase()]);

    record();
    await act(async () => {
      useVoiceRecordingStore.getState().beginSession({ panelId: "term-1" }, "s1");
      useVoiceRecordingStore.getState().setStatus("recording");
    });
    record();
    await act(async () => useVoiceRecordingStore.getState().setMicSignal("silent"));
    record();
    await act(async () => useVoiceRecordingStore.getState().setMicSignal("live"));
    record();
    await act(async () => useVoiceRecordingStore.getState().setStatus("paused"));
    record();
    await act(async () => useVoiceRecordingStore.getState().setStatus("finishing"));
    record();
    await act(async () => useVoiceRecordingStore.getState().finishSession());
    record();

    // An empty draft's status speaks for itself: the meter waits for a live
    // mic, and then needs no words beside it.
    expect(seen).toEqual([
      ["Ask Claude", null],
      ["Starting microphone…", null],
      ["No audio from microphone", null],
      [undefined, "live"],
      ["Paused · Resume to continue", null],
      ["Finishing transcription…", null],
      ["Ask Claude", null],
    ]);
  });
});
