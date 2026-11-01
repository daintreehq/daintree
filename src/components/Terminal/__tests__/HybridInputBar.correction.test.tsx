// @vitest-environment jsdom
/**
 * A correction reaches the composer the way `runCorrection` writes it: the
 * draft swapped in the store, the landing recorded, the revision bumped. The
 * composer marks what changed, and Cmd+Z puts the raw transcription back in
 * the editor and the draft alike (#14614).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { startTransition } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useDictationRangeStore } from "@/store/dictationRangeStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import {
  recordCorrectionLanded,
  takeLandedCorrection,
  writeComposerDraftThrough,
} from "@/services/voiceCorrectionLanding";
import { recordScratchLanded, takeScratchLanded } from "@/services/voiceScratchCommand";
import { setPendingComposerSelection } from "@/lib/composerCaret";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { addImageChip, readImageChipPaths } from "../inputEditorExtensions";
import { correctionReviewField } from "../inputEditorExtensions/correctionReview";
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
    focusedId: panel.id,
  });
  useTerminalInputStore.setState({ draftInputs: new Map() });
  useVoiceRecordingStore.setState({ panelBuffers: {}, activeTarget: null, status: "idle" });
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

/** An outside write to the draft, as the voice service and handoffs make them. */
async function writeDraft(text: string): Promise<void> {
  await act(async () => {
    const inputs = useTerminalInputStore.getState();
    inputs.setDraftInput("term-1", text);
    inputs.bumpExternalDraftRevision();
  });
}

const draft = () => useTerminalInputStore.getState().getDraftInput("term-1");

const isMac = /Mac/.test(navigator.platform);
async function undo(view: EditorView): Promise<void> {
  await act(async () => {
    runScopeHandlers(
      view,
      new KeyboardEvent("keydown", { key: "z", metaKey: isMac, ctrlKey: !isMac }),
      "editor"
    );
  });
}

const reviewing = (view: EditorView) => view.state.field(correctionReviewField, false) != null;

async function beginDictation(sessionId: string): Promise<void> {
  await act(async () => {
    useVoiceRecordingStore.getState().beginSession({ panelId: "term-1" }, sessionId);
  });
}

const RAW = "Intro. um open the zoo stand store";
const CORRECTED = "Intro. Open the Zustand store.";
const FROM = "Intro. ".length;

async function landCorrection(sessionId = "session-1"): Promise<void> {
  await act(async () => {
    const inputs = useTerminalInputStore.getState();
    inputs.setDraftInput("term-1", CORRECTED + draft().slice(RAW.length));
    recordCorrectionLanded("term-1", undefined, {
      from: FROM,
      rawText: RAW.slice(FROM),
      correctedText: CORRECTED.slice(FROM),
      baseline: { raw: RAW.slice(FROM), corrected: CORRECTED.slice(FROM) },
      sessionId,
    });
    useVoiceRecordingStore.getState().setSessionCorrectedText("term-1", CORRECTED.slice(FROM));
    inputs.bumpExternalDraftRevision();
  });
}

describe("HybridInputBar after an AI correction lands", () => {
  it("marks what the correction changed", async () => {
    const { view } = await mount();
    await writeDraft(RAW);
    await landCorrection();

    expect(view.state.doc.toString()).toBe(CORRECTED);
    const marks = [...view.contentDOM.querySelectorAll(".cm-voice-corrected")];
    expect(marks.map((el) => el.textContent)).toEqual(["Zustand"]);
  });

  it("puts the raw transcription back with one Cmd+Z, in the draft and the learning baseline", async () => {
    const { view } = await mount();
    await writeDraft(RAW);
    await landCorrection();

    await undo(view);

    expect(view.state.doc.toString()).toBe(RAW);
    expect(draft()).toBe(RAW);
    expect(useVoiceRecordingStore.getState().panelBuffers["term-1"]?.sessionCorrectedText).toBe(
      RAW.slice(FROM)
    );

    await undo(view);
    expect(view.state.doc.toString()).toBe("");
  });

  it("keeps typing after the correction its own step", async () => {
    const { view } = await mount();
    await writeDraft(RAW);
    await landCorrection();

    await act(async () => {
      view.dispatch({
        changes: { from: CORRECTED.length, insert: " Thanks" },
        userEvent: "input.type",
      });
    });
    await undo(view);
    expect(view.state.doc.toString()).toBe(CORRECTED);
    await undo(view);
    expect(view.state.doc.toString()).toBe(RAW);
  });

  it("has nothing to undo after a send", async () => {
    const onSend = vi.fn();
    const { view } = await mount(onSend);
    await act(async () => {
      view.dispatch({ changes: { from: 0, insert: "ship it" }, userEvent: "input.type" });
    });

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    expect(onSend).toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");

    await undo(view);
    expect(view.state.doc.toString()).toBe("");
  });

  it("has nothing to undo once the draft is emptied from outside", async () => {
    const { view } = await mount();
    await writeDraft("sent from another window");
    await writeDraft("");

    await undo(view);

    expect(view.state.doc.toString()).toBe("");
    expect(draft()).toBe("");
  });

  it("ends the review as the next dictation begins, and keeps the correction in undo (#14875)", async () => {
    const { view } = await mount();
    await beginDictation("session-1");
    await writeDraft(RAW);
    await landCorrection("session-1");
    expect(reviewing(view)).toBe(true);

    await beginDictation("session-2");
    expect(reviewing(view)).toBe(false);
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected")).toHaveLength(0);

    await writeDraft(CORRECTED + " And the next part.");
    expect(reviewing(view)).toBe(false);
    await undo(view);
    expect(view.state.doc.toString()).toBe(CORRECTED);
    await undo(view);
    expect(view.state.doc.toString()).toBe(RAW);
  });

  it("keeps a chunk's review while its own dictation carries on (#14772)", async () => {
    const { view } = await mount();
    await beginDictation("session-1");
    await act(async () => useVoiceRecordingStore.getState().setStatus("recording"));
    await writeDraft(RAW);
    await landCorrection("session-1");
    await act(async () => useVoiceRecordingStore.getState().appendDelta("And the", "item-2"));
    await writeDraft(CORRECTED + " And the next part.");

    expect(reviewing(view)).toBe(true);
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected")).not.toHaveLength(0);
  });

  it("keeps its review when a dictation begins on another panel", async () => {
    const { view } = await mount();
    await beginDictation("session-1");
    await writeDraft(RAW);
    await landCorrection("session-1");

    await act(async () => {
      useVoiceRecordingStore.getState().beginSession({ panelId: "term-2" }, "session-2");
    });

    expect(reviewing(view)).toBe(true);
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected")).not.toHaveLength(0);
  });

  it("lands a correction a newer dictation overtook without a review, still undoable", async () => {
    const { view } = await mount();
    await beginDictation("session-1");
    await writeDraft(RAW);
    await beginDictation("session-2");
    await writeDraft(RAW + " And the next part.");
    // The newer one may have stopped by the time the old cleanup lands.
    await act(async () => useVoiceRecordingStore.getState().finishSession());

    await landCorrection("session-1");
    expect(view.state.doc.toString()).toBe(CORRECTED + " And the next part.");
    expect(reviewing(view)).toBe(false);
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected")).toHaveLength(0);

    await undo(view);
    expect(view.state.doc.toString()).toBe(RAW + " And the next part.");
    expect(draft()).toBe(RAW + " And the next part.");
  });

  it("gives the new dictation's own correction its review", async () => {
    const { view } = await mount();
    await beginDictation("session-1");
    await writeDraft("Before. ");
    await beginDictation("session-2");
    await writeDraft(RAW);
    await landCorrection("session-2");

    expect(reviewing(view)).toBe(true);
  });

  function landBeforeMount(): void {
    useTerminalInputStore.getState().setDraftInput("term-1", CORRECTED);
    recordCorrectionLanded("term-1", undefined, {
      from: FROM,
      rawText: RAW.slice(FROM),
      correctedText: CORRECTED.slice(FROM),
      baseline: { raw: RAW.slice(FROM), corrected: CORRECTED.slice(FROM) },
      sessionId: "session-1",
    });
    useTerminalInputStore.getState().bumpExternalDraftRevision();
  }

  it("shows a correction that landed before the composer mounted, and undoes it", async () => {
    landBeforeMount();

    const { view } = await mount();

    expect(reviewing(view)).toBe(true);
    await undo(view);
    expect(view.state.doc.toString()).toBe(RAW);
    expect(draft()).toBe(RAW);
  });

  it("replays one a newer dictation overtook before the composer mounted without a review", async () => {
    landBeforeMount();
    useVoiceRecordingStore.getState().beginSession({ panelId: "term-1" }, "session-2");

    const { view } = await mount();

    expect(view.state.doc.toString()).toBe(CORRECTED);
    expect(reviewing(view)).toBe(false);
    await undo(view);
    expect(view.state.doc.toString()).toBe(RAW);
  });
});

describe("HybridInputBar after a correction over several passages lands", () => {
  const IMAGE = "/tmp/screenshot.png";
  const BEFORE = `look at the parsr ${IMAGE} and the lexr`;
  const AFTER = `Look at the parser ${IMAGE} and the lexer.`;

  async function pasteImage(view: EditorView): Promise<void> {
    await act(async () => {
      const at = view.state.doc.length;
      view.dispatch({
        changes: { from: at, insert: IMAGE + " " },
        effects: addImageChip.of({
          from: at,
          to: at + IMAGE.length,
          filePath: IMAGE,
          thumbnailUrl: "data:image/png;base64,",
        }),
        selection: { anchor: at + IMAGE.length + 1 },
      });
    });
  }

  it("keeps an image pasted between the passages attached, through undo too", async () => {
    const { view } = await mount();
    await writeDraft("look at the parsr ");
    await pasteImage(view);
    await writeDraft(BEFORE);
    expect(readImageChipPaths(view)).toEqual([IMAGE]);

    const lexer = BEFORE.indexOf("and the lexr");
    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput("term-1", AFTER);
      recordCorrectionLanded("term-1", undefined, {
        from: 0,
        rawText: BEFORE,
        correctedText: AFTER,
        baseline: null,
        sessionId: "session-1",
        write: {
          before: BEFORE,
          after: AFTER,
          changes: [
            { from: 0, to: "look at the parsr".length, insert: "Look at the parser" },
            { from: lexer, to: BEFORE.length, insert: "and the lexer." },
          ],
        },
      });
      inputs.bumpExternalDraftRevision();
    });

    expect(view.state.doc.toString()).toBe(AFTER);
    expect(readImageChipPaths(view)).toEqual([IMAGE]);

    await undo(view);
    expect(view.state.doc.toString()).toBe(BEFORE);
    expect(readImageChipPaths(view)).toEqual([IMAGE]);
  });
});

describe("HybridInputBar after a spoken scratch", () => {
  it("undoes one that emptied the draft with one Cmd+Z", async () => {
    const { view } = await mount();
    await writeDraft("One.");

    // As `scratchLastUtterance` writes it (#14636).
    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput("term-1", "");
      recordScratchLanded("term-1", undefined, "");
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
    });
    expect(view.state.doc.toString()).toBe("");

    await undo(view);

    expect(view.state.doc.toString()).toBe("One.");
    expect(draft()).toBe("One.");
  });
});

describe("HybridInputBar after Escape cancels a dictation", () => {
  it("brings back a dictation that emptied the draft with one Cmd+Z", async () => {
    const { view } = await mount();
    const voice = useVoiceRecordingStore.getState();
    voice.beginSession({ panelId: "term-1" }, "session-1");
    voice.setStatus("recording");
    useDictationRangeStore.setState({ drafts: {} });
    await writeDraft("Hello there.");
    useDictationRangeStore
      .getState()
      .recordUtterance(
        { sessionId: "session-1", panelId: "term-1", projectId: undefined },
        { insertion: { from: 0, to: 12 }, words: { from: 0, to: 12 } }
      );

    await act(async () => {
      // The first press asks for a second (#14927).
      expect(voiceRecordingService.handleEscape("term-1")).toBe(true);
      expect(voiceRecordingService.handleEscape("term-1")).toBe(true);
    });
    expect(draft()).toBe("");
    expect(view.state.doc.toString()).toBe("");

    await undo(view);

    expect(view.state.doc.toString()).toBe("Hello there.");
    expect(draft()).toBe("Hello there.");
  });
});

describe("HybridInputBar after Escape cancels a dictation over a selection (#14805)", () => {
  /** A session whose first words replaced "old" in "Keep old text.", as the voice service records it. */
  function recordWordsOverOld(words: string): void {
    const voice = useVoiceRecordingStore.getState();
    voice.beginSession({ panelId: "term-1" }, "session-1");
    voice.setStatus("recording");
    useDictationRangeStore.setState({ drafts: {} });
    useDictationRangeStore.getState().recordUtterance(
      { sessionId: "session-1", panelId: "term-1", projectId: undefined },
      {
        insertion: { from: 5, to: 5 + words.length },
        words: { from: 5, to: 5 + words.length },
        replaced: "old",
      }
    );
  }
  const selection = (view: EditorView) => {
    const { from, to } = view.state.selection.main;
    return { from, to };
  };
  const stubFocus = (view: EditorView, focused: boolean) =>
    Object.defineProperty(view, "hasFocus", { configurable: true, get: () => focused });

  it("selects the text it brings back in a composer that lost focus, and undo restores the dictation", async () => {
    const { view } = await mount();
    await writeDraft("Keep old text.");
    // Selected while focused, then focus moved on: the tracker keeps publishing.
    stubFocus(view, true);
    await act(async () => {
      view.dispatch({ selection: { anchor: 5, head: 8 } });
    });
    stubFocus(view, false);

    // As the voice service writes the words over it: the caret follows them.
    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      setPendingComposerSelection("term-1", "Keep new text.", { from: 8, to: 8 });
      inputs.setDraftInput("term-1", "Keep new text.");
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
    });
    recordWordsOverOld("new");
    expect(view.hasFocus).toBe(false);
    expect(selection(view)).toEqual({ from: 8, to: 8 });

    await act(async () => {
      // The first press asks for a second (#14927).
      expect(voiceRecordingService.handleEscape("term-1")).toBe(true);
      expect(voiceRecordingService.handleEscape("term-1")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("Keep old text.");
    expect(draft()).toBe("Keep old text.");
    expect(selection(view)).toEqual({ from: 5, to: 8 });

    await undo(view);

    expect(view.state.doc.toString()).toBe("Keep new text.");
    expect(draft()).toBe("Keep new text.");
  });

  it("selects the text it brings back in a composer nobody focused", async () => {
    const { view } = await mount();
    await writeDraft("Keep new text.");
    recordWordsOverOld("new");

    await act(async () => {
      // The first press asks for a second (#14927).
      expect(voiceRecordingService.handleEscape("term-1")).toBe(true);
      expect(voiceRecordingService.handleEscape("term-1")).toBe(true);
    });

    expect(view.state.doc.toString()).toBe("Keep old text.");
    expect(selection(view)).toEqual({ from: 5, to: 8 });
  });

  it("selects the text again when the dictated word was the selected one", async () => {
    const { view } = await mount();
    await writeDraft("Keep old text.");
    recordWordsOverOld("old");

    await act(async () => {
      expect(voiceRecordingService.handleEscape("term-1")).toBe(true);
    });

    expect(view.state.doc.toString()).toBe("Keep old text.");
    expect(selection(view)).toEqual({ from: 5, to: 8 });
  });
});

describe("HybridInputBar when a correction lands while a keystroke is on its way to the draft (#15873)", () => {
  const TYPED = "/review ";
  const PASSAGE = RAW.slice(FROM);
  const FIXED = CORRECTED.slice(FROM);

  /**
   * A correction reply as `requestCorrection` lands it: the composer's typing
   * written through, its passage placed in the stored draft, the draft
   * swapped, the landing recorded, the revision bumped.
   */
  function replyWithCorrection(): void {
    writeComposerDraftThrough("term-1", undefined);
    const inputs = useTerminalInputStore.getState();
    const before = inputs.getDraftInput("term-1");
    const from = before.indexOf(PASSAGE);
    if (from < 0) return;
    const to = from + PASSAGE.length;
    const after = before.slice(0, from) + FIXED + before.slice(to);
    inputs.setDraftInput("term-1", after);
    recordCorrectionLanded("term-1", undefined, {
      from,
      rawText: PASSAGE,
      correctedText: FIXED,
      baseline: { raw: PASSAGE, corrected: FIXED },
      sessionId: "session-1",
      write: { before, after, changes: [{ from, to, insert: FIXED }] },
    });
    useVoiceRecordingStore.getState().setSessionCorrectedText("term-1", FIXED);
    inputs.bumpExternalDraftRevision({ keepsSelection: true });
  }

  /** A keystroke the editor shows and the draft store doesn't hold yet. */
  function type(view: EditorView, at: number, text: string): void {
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: "input.type",
    });
  }

  async function mountWithDictation(): Promise<EditorView> {
    const { view } = await mount();
    await beginDictation("session-1");
    await writeDraft(RAW);
    await act(async () => {
      useVoiceRecordingStore.getState().setSessionCorrectedText("term-1", PASSAGE);
    });
    Object.defineProperty(view, "hasFocus", { configurable: true, get: () => true });
    return view;
  }

  const marks = (view: EditorView) =>
    [...view.contentDOM.querySelectorAll(".cm-voice-corrected")].map((el) => el.textContent);

  it("keeps the keystroke when the composer writes its value back after the correction", async () => {
    const view = await mountWithDictation();

    // One render takes both: the write-back effect runs before the sync.
    await act(async () => {
      type(view, 0, TYPED);
      expect(view.state.doc.toString()).toBe(TYPED + RAW);
      expect(draft()).toBe(RAW);
      replyWithCorrection();
    });

    expect(draft()).toBe(TYPED + CORRECTED);
    expect(view.state.doc.toString()).toBe(TYPED + CORRECTED);
    expect(view.state.selection.main.head).toBe(TYPED.length);
    expect(marks(view)).toEqual(["Zustand"]);

    await act(async () => {});
    expect(draft()).toBe(TYPED + CORRECTED);
    expect(view.state.doc.toString()).toBe(TYPED + CORRECTED);

    await undo(view);
    expect(view.state.doc.toString()).toBe(TYPED + RAW);
    expect(draft()).toBe(TYPED + RAW);
  });

  it("keeps the keystroke when the correction syncs into the editor before the write-back", async () => {
    const view = await mountWithDictation();

    // The keystroke's render waits behind the store's: the sync runs alone first.
    await act(async () => {
      startTransition(() => type(view, 0, TYPED));
      expect(view.state.doc.toString()).toBe(TYPED + RAW);
      expect(draft()).toBe(RAW);
      replyWithCorrection();
    });

    expect(draft()).toBe(TYPED + CORRECTED);
    expect(view.state.doc.toString()).toBe(TYPED + CORRECTED);
    expect(view.state.selection.main.head).toBe(TYPED.length);
    expect(marks(view)).toEqual(["Zustand"]);

    await act(async () => {});
    expect(draft()).toBe(TYPED + CORRECTED);
    expect(view.state.doc.toString()).toBe(TYPED + CORRECTED);

    await undo(view);
    expect(view.state.doc.toString()).toBe(TYPED + RAW);
    expect(draft()).toBe(TYPED + RAW);
  });

  it("keeps a keystroke typed after the passage", async () => {
    const view = await mountWithDictation();

    await act(async () => {
      type(view, RAW.length, " now");
      replyWithCorrection();
    });

    expect(draft()).toBe(CORRECTED + " now");
    expect(view.state.doc.toString()).toBe(CORRECTED + " now");
    expect(view.state.selection.main.head).toBe(CORRECTED.length + " now".length);
  });

  it("drops a correction the editor was typed into again before it could show it", async () => {
    const view = await mountWithDictation();

    await act(async () => {
      type(view, 0, TYPED);
      replyWithCorrection();
      type(view, TYPED.length, "now ");
    });

    const typed = TYPED + "now " + RAW;
    expect(view.state.doc.toString()).toBe(typed);
    expect(draft()).toBe(typed);
    expect(view.state.selection.main.head).toBe(TYPED.length + "now ".length);
    expect(reviewing(view)).toBe(false);
    expect(marks(view)).toEqual([]);
    expect(useVoiceRecordingStore.getState().panelBuffers["term-1"]?.sessionCorrectedText).not.toBe(
      FIXED
    );

    await act(async () => {});
    expect(view.state.doc.toString()).toBe(typed);
    expect(draft()).toBe(typed);
  });

  it("still lands a correction in a composer that was only behind the draft", async () => {
    const view = await mountWithDictation();

    // A dictated write the editor hasn't shown, then the correction over it.
    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput("term-1", "Intro. " + RAW);
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
      replyWithCorrection();
    });

    expect(draft()).toBe("Intro. " + CORRECTED);
    expect(view.state.doc.toString()).toBe("Intro. " + CORRECTED);
  });
});
