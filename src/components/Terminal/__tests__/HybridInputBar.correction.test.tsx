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
import { recordCorrectionLanded, takeLandedCorrection } from "@/services/voiceCorrectionLanding";
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
  useVoiceRecordingStore.setState({ panelBuffers: {} });
  takeLandedCorrection("term-1", undefined, "");
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

const RAW = "Intro. um open the zoo stand store";
const CORRECTED = "Intro. Open the Zustand store.";
const FROM = "Intro. ".length;

async function landCorrection(): Promise<void> {
  await act(async () => {
    const inputs = useTerminalInputStore.getState();
    inputs.setDraftInput("term-1", CORRECTED);
    recordCorrectionLanded("term-1", undefined, {
      from: FROM,
      rawText: RAW.slice(FROM),
      correctedText: CORRECTED.slice(FROM),
      baseline: { raw: RAW.slice(FROM), corrected: CORRECTED.slice(FROM) },
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
    expect(marks.map((el) => el.textContent)).toEqual(["Open", "Zustand store."]);
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

  it("shows a correction that landed before the composer mounted, and undoes it", async () => {
    useTerminalInputStore.getState().setDraftInput("term-1", CORRECTED);
    recordCorrectionLanded("term-1", undefined, {
      from: FROM,
      rawText: RAW.slice(FROM),
      correctedText: CORRECTED.slice(FROM),
      baseline: { raw: RAW.slice(FROM), corrected: CORRECTED.slice(FROM) },
    });
    useTerminalInputStore.getState().bumpExternalDraftRevision();

    const { view } = await mount();

    expect(view.contentDOM.querySelector(".cm-voice-restore")).not.toBeNull();
    await undo(view);
    expect(view.state.doc.toString()).toBe(RAW);
    expect(draft()).toBe(RAW);
  });
});
