// @vitest-environment jsdom
/**
 * The Assistant's sessions share one spot in the sidebar. Each has its own
 * input, through the real composer, voice service and stores: nothing typed or
 * dictated into one reaches another across a switch (#16571).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { act, cleanup, render } from "@testing-library/react";
import { undoDepth } from "@codemirror/commands";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import {
  triggerPopStash,
  triggerStashInput,
  useTerminalInputStore,
} from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { subscribeDictationRangeTracking } from "@/store/dictationRangeStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { HybridInputBar } from "../HybridInputBar";

type CorrectResult = { action: "no_change" | "replace"; correctedText: string; failed?: true };
type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = {
  text: string;
  willCorrect: boolean;
  itemId?: string;
  transcriptId?: string;
};

const WT_ID = "/repo/wt";
const LANE_A = "term-a";
const LANE_B = "term-b";

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
} = { delta: null, complete: null };

const correct = vi.fn<(request: { rawText: string }) => Promise<CorrectResult>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let itemSeq = 0;
function dictateInto(panelId: string, text: string) {
  useVoiceRecordingStore.getState().beginSession({ panelId });
  useVoiceRecordingStore.getState().setStatus("recording");
  const itemId = `item-${++itemSeq}`;
  callbacks.delta!({ text, itemId });
  callbacks.complete!({ text, willCorrect: false, itemId });
}

const draftOf = (panelId: string) => useTerminalInputStore.getState().getDraftInput(panelId);

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
// jsdom has no Web Animations, and a wait shown again animates the composer's fill.
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel: () => {}, pause: () => {}, onfinish: null }),
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
  for (const [name, original] of [
    ["animate", originalAnimate],
    ["getAnimations", originalGetAnimations],
  ] as const) {
    if (original) Object.defineProperty(Element.prototype, name, original);
    else delete (Element.prototype as Partial<Element>)[name];
  }
});

let unsubscribeRanges: () => void;

beforeEach(async () => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = (id: string) =>
    ({
      id,
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
    }) as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [LANE_A]: panel(LANE_A), [LANE_B]: panel(LANE_B) },
    panelIds: [LANE_A, LANE_B],
    panelIdsByWorktreeId: { [WT_ID]: [LANE_A, LANE_B] },
    focusedId: LANE_A,
  });
  Object.assign(window, {
    electron: {
      voiceInput: {
        onTranscriptionDelta: vi.fn((cb: (payload: DeltaPayload) => void) => {
          callbacks.delta = cb;
          return () => {};
        }),
        onTranscriptionComplete: vi.fn((cb: (payload: CompletePayload) => void) => {
          callbacks.complete = cb;
          return () => {};
        }),
        onParagraphBoundary: vi.fn(() => () => {}),
        onCorrectionProgress: vi.fn(() => () => {}),
        onFileTokenResolved: vi.fn(() => () => {}),
        onError: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        onSessionEnded: vi.fn(() => () => {}),
        onLiveSession: vi.fn(() => () => {}),
        onStopRequested: vi.fn(() => () => {}),
        onRevealRequested: vi.fn(() => () => {}),
        onLiveLevel: vi.fn(() => () => {}),
        onPauseRequested: vi.fn(() => () => {}),
        publishDetails: vi.fn().mockResolvedValue(undefined),
        setPausedLive: vi.fn().mockResolvedValue(true),
        getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
        getSettings: vi.fn().mockResolvedValue({
          enabled: true,
          openaiApiKey: "sk-key",
          correctionEnabled: true,
          learnFromCorrections: false,
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        correct,
      },
      systemSleep: {
        onSuspend: vi.fn(() => () => {}),
        onWake: vi.fn(() => () => {}),
      },
    },
  });
  correct.mockReset();
  sends.length = 0;
  useTerminalInputStore.setState({
    draftInputs: new Map(),
    voiceSubmittingPanels: new Set(),
    stashedEditorStates: new Map(),
  });
  useVoiceRecordingStore.setState({ panelBuffers: {}, activeTarget: null, status: "idle" });
  unsubscribeRanges = subscribeDictationRangeTracking();
  voiceRecordingService.initialize();
  await voiceRecordingService.refreshConfiguration();
});

afterEach(() => {
  cleanup();
  voiceRecordingService.destroy();
  unsubscribeRanges();
  vi.restoreAllMocks();
});

const worktreeStore = createWorktreeStore();
const onSend = vi.fn();
const sends: Array<{ to: string; text: string }> = [];

function bar(terminalId: string) {
  return (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <HybridInputBar terminalId={terminalId} cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

/** The sidebar's composer as `HelpPanel` renders it: its send closes over its own session. */
function session(terminalId: string) {
  return (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <HybridInputBar
          key={terminalId}
          terminalId={terminalId}
          cwd={WT_ID}
          agentId="claude"
          onSend={({ text }) => {
            sends.push({ to: terminalId, text });
          }}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

const editorIn = (container: HTMLElement) =>
  EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;

const shownText = (container: HTMLElement) => editorIn(container).state.doc.toString();

const pressEnter = (view: EditorView) =>
  act(async () => {
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
  });

const typeInto = (view: EditorView, text: string) =>
  act(async () => {
    view.dispatch({
      changes: { from: view.state.doc.length, insert: text },
      selection: { anchor: view.state.doc.length + text.length },
      userEvent: "input.type",
    });
  });

describe("HybridInputBar handed another terminal in place (#16571)", () => {
  it("shows the other terminal's draft and leaves it as it was, after a dictation", async () => {
    act(() => {
      useTerminalInputStore.getState().setDraftInput(LANE_B, "b's own draft");
    });
    const { container, rerender } = render(bar(LANE_A));
    await act(async () => {});
    await act(async () => {
      dictateInto(LANE_A, "words for a");
    });
    expect(shownText(container)).toBe("words for a");

    await act(async () => {
      rerender(bar(LANE_B));
    });

    expect(draftOf(LANE_B)).toBe("b's own draft");
    expect(shownText(container)).toBe("b's own draft");
    expect(draftOf(LANE_A)).toBe("words for a");
  });

  it("leaves an empty draft empty, after a dictation", async () => {
    const { container, rerender } = render(bar(LANE_A));
    await act(async () => {});
    await act(async () => {
      dictateInto(LANE_A, "words for a");
    });

    await act(async () => {
      rerender(bar(LANE_B));
    });

    expect(draftOf(LANE_B)).toBe("");
    expect(shownText(container)).toBe("");
    expect(draftOf(LANE_A)).toBe("words for a");
  });
});

describe("HybridInputBar, one per Assistant session (#16571)", () => {
  async function showing(terminalId: string) {
    const result = render(session(terminalId));
    await act(async () => {});
    return {
      container: result.container,
      show: async (next: string) => {
        await act(async () => {
          result.rerender(session(next));
        });
      },
    };
  }

  it("keeps typed text with its session, whichever way the switch goes", async () => {
    const { container, show } = await showing(LANE_A);
    await typeInto(editorIn(container), "typed for a");

    await show(LANE_B);
    expect(shownText(container)).toBe("");
    expect(draftOf(LANE_B)).toBe("");

    await typeInto(editorIn(container), "typed for b");
    await show(LANE_A);
    expect(shownText(container)).toBe("typed for a");
    expect(draftOf(LANE_B)).toBe("typed for b");

    await show(LANE_B);
    expect(shownText(container)).toBe("typed for b");
    expect(draftOf(LANE_A)).toBe("typed for a");
  });

  it("lands a transcription still finishing in the session it started in, ready on return", async () => {
    act(() => {
      useTerminalInputStore.getState().setDraftInput(LANE_B, "b's own draft");
    });
    const { container, show } = await showing(LANE_A);
    act(() => {
      useVoiceRecordingStore.getState().beginSession({ panelId: LANE_A });
      useVoiceRecordingStore.getState().setStatus("finishing");
      callbacks.delta!({ text: "words on their way", itemId: "late" });
    });

    await show(LANE_B);
    expect(shownText(container)).toBe("b's own draft");

    await act(async () => {
      callbacks.complete!({ text: "words on their way", willCorrect: false, itemId: "late" });
    });
    expect(draftOf(LANE_A)).toBe("words on their way");
    expect(draftOf(LANE_B)).toBe("b's own draft");
    expect(shownText(container)).toBe("b's own draft");

    await show(LANE_A);
    expect(shownText(container)).toBe("words on their way");
  });

  it("sends a send waiting on its cleanup to its own session, leaving the one on screen alone", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    act(() => {
      useTerminalInputStore.getState().setDraftInput(LANE_B, "b's own draft");
      dictateInto(LANE_A, "hello wrld");
    });
    const { container, show } = await showing(LANE_A);
    await pressEnter(editorIn(container));
    expect(sends).toEqual([]);

    await show(LANE_B);
    expect(sends).toEqual([]);
    // The wait's lock stayed with its session.
    expect(editorIn(container).state.facet(EditorView.editable)).toBe(true);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sends).toEqual([{ to: LANE_A, text: "Hello world." }]);
    expect(draftOf(LANE_A)).toBe("");
    expect(draftOf(LANE_B)).toBe("b's own draft");
    expect(shownText(container)).toBe("b's own draft");
    expect(useTerminalInputStore.getState().isVoiceSubmitting(LANE_A)).toBe(false);
  });

  it("shows a waiting send again on return, where a second Enter sends it to its own session", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    act(() => {
      dictateInto(LANE_A, "hello wrld");
    });
    const { container, show } = await showing(LANE_A);
    await pressEnter(editorIn(container));

    await show(LANE_B);
    await show(LANE_A);
    expect(editorIn(container).state.facet(EditorView.editable)).toBe(false);

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    });

    expect(sends).toEqual([{ to: LANE_A, text: "hello wrld" }]);
    expect(shownText(container)).toBe("");

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(sends).toHaveLength(1);
  });

  it("sends nothing from the session on screen when asked to send a dictation running in another", async () => {
    act(() => {
      useTerminalInputStore.getState().setDraftInput(LANE_B, "b's own draft");
      dictateInto(LANE_A, "still dictating");
    });
    const { show } = await showing(LANE_A);

    await show(LANE_B);
    expect(voiceRecordingService.canSendActiveSession()).toBe(false);
    await act(async () => {
      expect(voiceRecordingService.sendActiveSession()).toBe(false);
    });

    expect(sends).toEqual([]);
    expect(draftOf(LANE_A)).toBe("still dictating");
    expect(draftOf(LANE_B)).toBe("b's own draft");
  });

  it("keeps a popped stash in its session's draft when switched away straight after", async () => {
    const { container, show } = await showing(LANE_A);
    await typeInto(editorIn(container), "half a prompt");
    await act(async () => {
      triggerStashInput(LANE_A);
    });
    expect(draftOf(LANE_A)).toBe("");
    await act(async () => {
      triggerPopStash(LANE_A);
    });
    expect(draftOf(LANE_A)).toBe("half a prompt");

    await show(LANE_B);
    await show(LANE_A);
    expect(shownText(container)).toBe("half a prompt");
  });

  it("leaves a stash stashed while a send waits on the draft, which goes as it stood", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const { container } = await showing(LANE_A);
    await typeInto(editorIn(container), "old prompt");
    await act(async () => {
      triggerStashInput(LANE_A);
    });
    await act(async () => {
      dictateInto(LANE_A, "hello wrld");
    });
    await pressEnter(editorIn(container));
    const restore = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Restore stashed input"]'
    )!;
    expect(restore.disabled).toBe(true);

    await act(async () => {
      triggerPopStash(LANE_A);
    });

    expect(useTerminalInputStore.getState().hasStashedEditorState(LANE_A)).toBe(true);
    expect(shownText(container)).toBe("hello wrld");
    expect(draftOf(LANE_A)).toBe("hello wrld");
    expect(editorIn(container).state.facet(EditorView.editable)).toBe(false);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sends).toEqual([{ to: LANE_A, text: "Hello world." }]);
    expect(useTerminalInputStore.getState().hasStashedEditorState(LANE_A)).toBe(true);
    expect(restore.disabled).toBe(false);
  });

  it("pops a stash onto the composer showing it now, whose typing and Enter are its own", async () => {
    const { container, show } = await showing(LANE_A);
    await typeInto(editorIn(container), "half a prompt");
    await act(async () => {
      triggerStashInput(LANE_A);
    });
    expect(shownText(container)).toBe("");

    await show(LANE_B);
    await show(LANE_A);
    await act(async () => {
      triggerPopStash(LANE_A);
    });

    const view = editorIn(container);
    expect(view.state.doc.toString()).toBe("half a prompt");
    expect(draftOf(LANE_A)).toBe("half a prompt");
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    await typeInto(view, ", finished");
    expect(draftOf(LANE_A)).toBe("half a prompt, finished");

    await pressEnter(view);
    expect(sends).toEqual([{ to: LANE_A, text: "half a prompt, finished" }]);
    expect(shownText(container)).toBe("");
    expect(draftOf(LANE_A)).toBe("");
  });
});
