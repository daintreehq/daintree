// @vitest-environment jsdom
/**
 * Enter while dictating, through the real composer, voice service and stores:
 * a dictation started on the same panel while the send waits for its cleanup
 * stays out of the send, and every word of it stays in the draft (#14804).
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
import { subscribeDictationRangeTracking } from "@/store/dictationRangeStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { HybridInputBar } from "../HybridInputBar";

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string };
type CorrectResult = { action: "no_change" | "replace"; correctedText: string };

const WT_ID = "/repo/wt";
const PANEL_ID = "term-1";

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
function dictate(text: string) {
  useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID });
  useVoiceRecordingStore.getState().setStatus("recording");
  const itemId = `item-${++itemSeq}`;
  callbacks.delta!({ text, itemId });
  callbacks.complete!({ text, willCorrect: false, itemId });
}

const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL_ID);

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
// jsdom has no Web Animations, and a wait that outlasts the progress gate on a
// slow runner animates the composer's fill.
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
  const panel = {
    id: PANEL_ID,
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
  useTerminalInputStore.setState({ draftInputs: new Map(), voiceSubmittingPanels: new Set() });
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

async function mount(onSend: (payload: { text: string }) => void) {
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId={PANEL_ID} cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  return EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
}

describe("HybridInputBar dictated send with the next dictation already started (#14804)", () => {
  it("sends the cleaned prompt alone and keeps every word of the next one in the composer", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);
    expect(view.state.doc.toString()).toBe("hello wrld");

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    expect(correct).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    // The dictation key again straight away, for the next prompt.
    await act(async () => {
      dictate("these are the next prompt");
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].text).toBe("Hello world.");
    expect(draft()).toBe("these are the next prompt");
    expect(view.state.doc.toString()).toBe("these are the next prompt");

    await act(async () => {
      callbacks.complete!({ text: "and the rest", willCorrect: false, itemId: "item-late" });
    });
    expect(draft()).toBe("these are the next prompt and the rest");
    expect(view.state.doc.toString()).toBe("these are the next prompt and the rest");
  });

  it("doesn't wait for, or drop, the cleanup of a next dictation already stopped", async () => {
    const pending = deferred<CorrectResult>();
    const later = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise).mockReturnValueOnce(later.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await act(async () => {
      dictate("the nxt prompt");
      await voiceRecordingService.stop();
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["Hello world."]);
    expect(view.state.doc.toString()).toBe("the nxt prompt");
    expect(voiceRecordingService.hasPendingCorrection(PANEL_ID)).toBe(true);

    await act(async () => {
      later.resolve({ action: "replace", correctedText: "The next prompt." });
    });
    expect(draft()).toBe("The next prompt.");
    expect(view.state.doc.toString()).toBe("The next prompt.");
  });

  it("keeps what the next dictation adds while an expansion in the sent prompt is fetched", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const diff = deferred<string>();
    Object.assign(window.electron, { git: { getWorkingDiff: vi.fn(() => diff.promise) } });
    const onSend = vi.fn();
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, "@diff");
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await act(async () => {
      dictate("these are the next prompt");
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      callbacks.complete!({ text: "and the rest", willCorrect: false, itemId: "item-late" });
    });
    await act(async () => {
      diff.resolve("BODY");
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].text).toBe("```diff\nBODY\n``` Hello world.");
    expect(draft()).toBe("these are the next prompt and the rest");
    expect(view.state.doc.toString()).toBe("these are the next prompt and the rest");
  });

  it("leaves the draft whole rather than drop typing the store hasn't heard yet", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const diff = deferred<string>();
    Object.assign(window.electron, { git: { getWorkingDiff: vi.fn(() => diff.promise) } });
    const onSend = vi.fn();
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, "@diff");
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await act(async () => {
      dictate("these are the next prompt");
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    // A keystroke the editor has but its write-back to the store hasn't
    // committed yet when the expansion comes back.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: " now" },
      userEvent: "input.type",
    });
    await act(async () => {
      diff.resolve("BODY");
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("@diff Hello world. these are the next prompt now");
  });

  it("starts the next dictation after the prompt, not over text selected in it", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: "hello".length } });
    });

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await act(async () => {
      dictate("next");
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["Hello world."]);
    expect(draft()).toBe("next");
  });
});
