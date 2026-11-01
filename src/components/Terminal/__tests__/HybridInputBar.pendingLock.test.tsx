// @vitest-environment jsdom
/**
 * While a dictated passage's correction is in flight its words are locked in
 * the composer, and text typed at its edges stays outside it, in the editor
 * and in the dictation's record alike, so the correction can still land
 * (#15874).
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
import {
  subscribeDictationRangeTracking,
  useDictationRangeStore,
} from "@/store/dictationRangeStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";
const PANEL = "term-1";
const PASSAGE = "fix the bug";

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

let stopTracking: (() => void) | null = null;

beforeEach(() => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = {
    id: PANEL,
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
  useVoiceRecordingStore.setState({ panelBuffers: {}, activeTarget: null, status: "idle" });
  useDictationRangeStore.setState({ drafts: {}, anchors: {} });
  stopTracking = subscribeDictationRangeTracking();
});

afterEach(() => {
  cleanup();
  stopTracking?.();
  stopTracking = null;
});

const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL);

/** The passage dictated into an empty draft, as the session writes it, with its cleanup pending. */
async function mountPending() {
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId={PANEL} cwd={WT_ID} agentId="claude" onSend={vi.fn()} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();
  await act(async () => {
    const inputs = useTerminalInputStore.getState();
    useDictationRangeStore.getState().expectDraftChange(PANEL, undefined, "", PASSAGE, {
      from: 0,
      to: 0,
      insert: PASSAGE,
    });
    inputs.setDraftInput(PANEL, PASSAGE);
    useDictationRangeStore.getState().recordUtterance(
      { sessionId: "s1", panelId: PANEL },
      { insertion: { from: 0, to: PASSAGE.length }, words: { from: 0, to: PASSAGE.length } }
    );
    inputs.bumpExternalDraftRevision();
  });
  await act(async () => {
    useVoiceRecordingStore
      .getState()
      .setCorrectionRanges(PANEL, [{ from: 0, to: PASSAGE.length, session: "s1" }]);
  });

  const caretAt = async (pos: number) => {
    await act(async () => {
      view.dispatch({ selection: { anchor: pos }, userEvent: "select" });
    });
  };
  // One keystroke at a time at the caret, each written back before the next.
  const type = async (text: string) => {
    for (const char of text) {
      await act(async () => {
        const at = view.state.selection.main.head;
        view.dispatch({
          changes: { from: at, insert: char },
          selection: { anchor: at + 1 },
          userEvent: "input.type",
        });
      });
      await act(async () => {});
    }
  };
  const doc = () => view.state.doc.toString();
  return { view, caretAt, type, doc };
}

function passageRecord() {
  const [record] = useDictationRangeStore.getState().listDictations(PANEL, undefined);
  const utterance = record!.utterances[0]!;
  return { edited: utterance.range.edited, text: draft().slice(utterance.range.from, utterance.range.to) };
}

const isMac = /Mac/.test(navigator.platform);

describe("HybridInputBar while a dictated passage's correction is pending", () => {
  // The diff of `/fix the bug` and `/ffix the bug` puts the second `f` inside
  // the passage; it was typed in front of it.
  it("keeps a slash command typed in front of it out of the passage", async () => {
    const { caretAt, type, doc } = await mountPending();
    await caretAt(0);
    await type("/fix ");

    expect(doc()).toBe(`/fix ${PASSAGE}`);
    expect(draft()).toBe(`/fix ${PASSAGE}`);
    expect(passageRecord()).toEqual({ edited: false, text: PASSAGE });
  });

  it("keeps text typed straight after it out of the passage", async () => {
    const { caretAt, type, doc } = await mountPending();
    await caretAt(PASSAGE.length);
    await type("g now");

    expect(doc()).toBe(`${PASSAGE}g now`);
    expect(passageRecord()).toEqual({ edited: false, text: PASSAGE });
  });

  it("refuses typing inside it, in the editor and the draft", async () => {
    const { caretAt, type, doc } = await mountPending();
    await caretAt(4);
    await type("x");

    expect(doc()).toBe(PASSAGE);
    expect(draft()).toBe(PASSAGE);
    expect(passageRecord()).toEqual({ edited: false, text: PASSAGE });
  });

  it("can't undo the dictation that wrote it", async () => {
    const { view, doc } = await mountPending();
    await act(async () => {
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "z", metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });

    expect(doc()).toBe(PASSAGE);
    expect(draft()).toBe(PASSAGE);
  });

  it("unlocks when the correction settles", async () => {
    const { caretAt, type, doc } = await mountPending();
    await act(async () => {
      useVoiceRecordingStore.getState().setCorrectionRanges(PANEL, []);
    });
    await caretAt(4);
    await type("x");

    expect(doc()).toBe("fix xthe bug");
    expect(draft()).toBe("fix xthe bug");
  });
});
