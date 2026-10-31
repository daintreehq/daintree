// @vitest-environment jsdom
/**
 * Enter while dictating, through the real composer, voice service and stores:
 * a dictation started on the same panel while the send waits for its cleanup
 * reopens the send, and the next send takes both passages (#14804, #15703).
 * Stop and send's key, through the real keybindings, does for a send it
 * started what a second Enter does for one Enter started (#15705).
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
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { subscribeDictationRangeTracking } from "@/store/dictationRangeStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { setPendingComposerSelection } from "@/lib/composerCaret";
import { makeDraftKey } from "@/lib/draftKey";
import { HybridInputBar } from "../HybridInputBar";
import { useGlobalKeybindings } from "@/hooks/useGlobalKeybindings";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { registerVoiceActions } from "@/services/actions/definitions/voiceActions";
import type { ActionRegistry } from "@/services/actions/actionTypes";
import { describeChord, formatChordText } from "@/lib/kbdShortcut";
import { hasWaitingStopAndSend } from "@/services/voiceDraftSend";
import { isMac } from "@/lib/platform";
import { addImageChip } from "../inputEditorExtensions";

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = {
  text: string;
  willCorrect: boolean;
  itemId?: string;
  transcriptId?: string;
};
type FileTokenPayload = {
  sessionId: string;
  transcriptId: string;
  references: Array<{ description: string; path: string | null; failed?: true }>;
};
type CorrectResult = { action: "no_change" | "replace"; correctedText: string; failed?: true };

const WT_ID = "/repo/wt";
const PANEL_ID = "term-1";

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  fileToken: ((payload: FileTokenPayload) => void) | null;
} = { delta: null, complete: null, fileToken: null };

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
        onFileTokenResolved: vi.fn((cb: (payload: FileTokenPayload) => void) => {
          callbacks.fileToken = cb;
          return () => {};
        }),
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

async function mount(onSend: (payload: { text: string }) => void, beside?: React.ReactNode) {
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId={PANEL_ID} cwd={WT_ID} agentId="claude" onSend={onSend} />
        {beside}
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  return EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
}

const statuses = () =>
  [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? "");

describe("HybridInputBar dictated send without its cleanup (#14959)", () => {
  it("names Enter while the cleanup is awaited, and says a second one skipped it", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, UI_INLINE_LOADING_GATE_MS + 50));
    });
    expect(statuses().some((text) => /Press Enter/.test(text))).toBe(true);

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    });
    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["hello wrld"]);
    expect(document.querySelector("[data-voice-submit-caption]")?.textContent).toMatch(
      /cleanup skipped/
    );
    expect(statuses().some((text) => /cleanup skipped/.test(text))).toBe(true);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
  });

  it("sends the words as dictated and says on its receipt that the cleanup failed", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await act(async () => {
      pending.resolve({ action: "no_change", correctedText: "hello wrld", failed: true });
    });

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["hello wrld"]);
    expect(document.querySelector("[data-voice-submit-caption]")?.textContent).toMatch(
      /cleanup failed/
    );
    // Its wait went inside the progress gate, unannounced, and still says so.
    expect(statuses().some((text) => /cleanup failed/.test(text))).toBe(true);
  });
});

describe("HybridInputBar dictated send reopened by the next dictation (#14804, #15703)", () => {
  // A progress strip a slow runner got to show fades out, as on screen, so
  // the border is free by the next act whether or not the gate opened.
  let stillAnimate: PropertyDescriptor | undefined;
  beforeEach(() => {
    stillAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => {
        const animation = { cancel() {}, pause() {} };
        Object.defineProperty(animation, "onfinish", {
          get: () => null,
          set: (finish: (() => void) | null) => {
            if (finish) queueMicrotask(finish);
          },
        });
        return animation;
      },
    });
  });
  afterEach(() => {
    if (stillAnimate) Object.defineProperty(Element.prototype, "animate", stillAnimate);
  });

  /** Enter on a passage whose cleanup is held, then the dictation key again. */
  async function enterThenDictate(onSend: (payload: { text: string }) => void, next: string) {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    expect(correct).toHaveBeenCalledTimes(1);
    await act(async () => {
      dictate(next);
    });
    return { view, pending };
  }

  const pressEnter = (view: EditorView) =>
    act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });

  it("unlocks the composer, says so while the dictation runs, and sends both at the next Enter", async () => {
    const onSend = vi.fn();
    const { view, pending } = await enterThenDictate(onSend, "these are the next prompt");
    expect(view.state.facet(EditorView.editable)).toBe(true);
    // Starting the microphone has the border first.
    expect(document.querySelector("[data-send-reopened-caption]")).toBeNull();
    await act(async () => useVoiceRecordingStore.getState().setMicSignal("live"));

    expect(document.querySelector("[data-send-reopened-caption]")?.textContent).toMatch(
      /^Send reopened/
    );
    expect(statuses().some((text) => text.startsWith("Send reopened"))).toBe(true);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("Hello world. these are the next prompt");

    await act(async () => {
      callbacks.complete!({ text: "and the rest", willCorrect: false, itemId: "item-late" });
    });
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
    await pressEnter(view);

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual([
      "Hello world. these are the next prompt and the rest",
    ]);
    expect(draft()).toBe("");
    expect(document.querySelector("[data-send-reopened-caption]")).toBeNull();
  });

  it("says so on the strip a wait past the gate showed, then on the border", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);
    await pressEnter(view);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, UI_INLINE_LOADING_GATE_MS + 50));
    });
    expect(document.querySelector("[data-voice-submit-caption]")?.textContent).toMatch(
      /^Polishing/
    );

    await act(async () => {
      dictate("these are the next prompt");
      useVoiceRecordingStore.getState().setMicSignal("live");
    });

    expect(document.querySelector("[data-voice-submit-caption]")).toBeNull();
    expect(document.querySelector("[data-send-reopened-caption]")?.textContent).toMatch(
      /^Send reopened/
    );
    expect(statuses().some((text) => text.startsWith("Send reopened"))).toBe(true);
  });

  it("writes after the prompt even over a selection a writer left for the composer to take", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);
    act(() => {
      view.focus();
    });
    await pressEnter(view);

    // A rule rewrites the passage and asks for "hello" to be selected once the
    // composer shows it; the dictation key lands before the composer syncs.
    act(() => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput(PANEL_ID, "hello world");
      setPendingComposerSelection(makeDraftKey(PANEL_ID, undefined), "hello world", {
        from: 0,
        to: "hello".length,
      });
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
      useVoiceRecordingStore.getState().setArming({ panelId: PANEL_ID });
    });
    expect(view.state.doc.toString()).toBe("hello world");
    await act(async () => {
      dictate("next");
    });

    expect(draft()).toBe("hello world next");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps a selection made in the reopened draft when the first cleanup comes back unchanged", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend);
    act(() => {
      view.focus();
    });
    await pressEnter(view);
    act(() => {
      // A hint a writer left for the text the composer already shows.
      setPendingComposerSelection(makeDraftKey(PANEL_ID, undefined), "hello wrld", {
        from: 0,
        to: "hello".length,
      });
      useVoiceRecordingStore.getState().setArming({ panelId: PANEL_ID });
    });
    expect(view.state.selection.main.head).toBe("hello wrld".length);

    act(() => {
      view.dispatch({ selection: { anchor: "hello ".length, head: "hello wrld".length } });
    });
    await act(async () => {
      pending.resolve({ action: "no_change", correctedText: "hello wrld" });
    });

    expect(view.state.selection.main).toMatchObject({
      from: "hello ".length,
      to: "hello wrld".length,
    });
  });

  it("leaves both passages unsent, and the note gone, when the next dictation stops without a send", async () => {
    const later = deferred<CorrectResult>();
    const onSend = vi.fn();
    const { view, pending } = await enterThenDictate(onSend, "the nxt prompt");
    correct.mockReturnValueOnce(later.promise);
    await act(async () => useVoiceRecordingStore.getState().setMicSignal("live"));
    expect(document.querySelector("[data-send-reopened-caption]")).not.toBeNull();

    await act(async () => {
      await voiceRecordingService.stop();
    });
    expect(document.querySelector("[data-send-reopened-caption]")).toBeNull();
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    await act(async () => {
      later.resolve({ action: "replace", correctedText: "The next prompt." });
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(draft()).toBe("Hello world. The next prompt.");
    expect(view.state.doc.toString()).toBe("Hello world. The next prompt.");

    // A later dictation here is just a dictation.
    await act(async () => {
      dictate("more");
      useVoiceRecordingStore.getState().setMicSignal("live");
    });
    expect(document.querySelector("[data-send-reopened-caption]")).toBeNull();
    expect(statuses().some((text) => text.startsWith("Send reopened"))).toBe(false);
  });

  it("sends the reopened prompt whole through an expansion it holds", async () => {
    const diff = deferred<string>();
    Object.assign(window.electron, { git: { getWorkingDiff: vi.fn(() => diff.promise) } });
    const onSend = vi.fn();
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, "@diff");
    const { view, pending } = await enterThenDictate(onSend, "these are the next prompt");
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
    await pressEnter(view);
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      diff.resolve("BODY");
    });

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual([
      "```diff\nBODY\n``` Hello world. these are the next prompt",
    ]);
    expect(draft()).toBe("");
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

    await pressEnter(view);
    await act(async () => {
      dictate("next");
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(draft()).toBe("Hello world. next");
  });
});

describe("HybridInputBar dictated send with the next dictation's start already under way (#14804)", () => {
  /**
   * The dictation key, then Enter on the stopped passage before the new
   * start's session begins: that dictation is the next prompt's.
   */
  async function enterWhileArming(onSend: (payload: { text: string }) => void) {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    act(() => {
      dictate("hello wrld");
    });
    await act(async () => {
      await voiceRecordingService.stop();
    });
    const view = await mount(onSend);
    act(() => {
      useVoiceRecordingStore.getState().setArming({ panelId: PANEL_ID });
    });
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await act(async () => {
      dictate("these are the next prompt");
    });
    return { view, pending };
  }

  it("keeps what the next dictation adds while an expansion in the sent prompt is fetched", async () => {
    const diff = deferred<string>();
    Object.assign(window.electron, { git: { getWorkingDiff: vi.fn(() => diff.promise) } });
    const onSend = vi.fn();
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, "@diff");
    const { view, pending } = await enterWhileArming(onSend);
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
    const diff = deferred<string>();
    Object.assign(window.electron, { git: { getWorkingDiff: vi.fn(() => diff.promise) } });
    const onSend = vi.fn();
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, "@diff");
    const { view, pending } = await enterWhileArming(onSend);
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
});

describe("HybridInputBar with a missed file reference arriving during a dictated send (#14983)", () => {
  afterEach(() => {
    vi.useRealTimers();
    useVoiceRecordingStore.setState({ fileReferenceNote: null });
  });

  it("holds the note while the send waits, then shows it its full time after", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID }, "session-links");
      useVoiceRecordingStore.getState().setStatus("recording");
      callbacks.delta!({ text: "link to the old API", itemId: "item-links" });
      callbacks.complete!({
        text: "link to the old API",
        willCorrect: false,
        itemId: "item-links",
        transcriptId: "t1",
      });
    });
    const view = await mount(onSend);
    const caption = () => document.querySelector("[data-file-reference-caption]");

    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => {
      callbacks.fileToken!({
        sessionId: "session-links",
        transcriptId: "t1",
        references: [{ description: "old API", path: null }],
      });
    });
    const note = useVoiceRecordingStore.getState().fileReferenceNote;
    expect(note).toMatchObject({ panelId: PANEL_ID, references: [{ description: "old API" }] });
    expect(caption()).toBeNull();

    // A cleanup slower than the note lasts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(useVoiceRecordingStore.getState().fileReferenceNote).toBe(note);

    await act(async () => {
      pending.resolve({ action: "no_change", correctedText: "link to the old API" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].text).toBe("link to the old API");
    expect(caption()).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(useVoiceRecordingStore.getState().fileReferenceNote).toBeNull();
    expect(caption()).toBeNull();
  });
});

describe("HybridInputBar dictated send whose composer unmounts mid-wait (#15510)", () => {
  async function mountBar(onSend: (payload: { text: string }) => void) {
    const result = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar terminalId={PANEL_ID} cwd={WT_ID} agentId="claude" onSend={onSend} />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    const view = EditorView.findFromDOM(
      result.container.querySelector<HTMLElement>(".cm-editor")!
    )!;
    return { view, unmount: result.unmount };
  }

  async function enterThenLeave(onSend: (payload: { text: string }) => void) {
    const bar = await mountBar(onSend);
    await act(async () => {
      runScopeHandlers(bar.view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      bar.unmount();
    });
  }

  it("sends the cleaned prompt to its terminal once the cleanup lands, and clears the draft", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    await enterThenLeave(onSend);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["Hello world."]);
    expect(draft()).toBe("");
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("sends the fleet the images it had at Enter when its pane is armed (#15600)", async () => {
    const IMAGE = "/tmp/daintree/shot.png";
    const panel = usePanelStore.getState().panelsById[PANEL_ID]!;
    usePanelStore.setState({
      panelsById: { [PANEL_ID]: panel, "term-2": { ...panel, id: "term-2" } },
      panelIds: [PANEL_ID, "term-2"],
      panelIdsByWorktreeId: { [WT_ID]: [PANEL_ID, "term-2"] },
    });
    useFleetArmingStore.getState().armIds([PANEL_ID, "term-2"]);
    const submit = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.electron, {
      terminal: { submit },
      notification: { playUiEvent: vi.fn().mockResolvedValue(undefined) },
      runHistory: { append: vi.fn().mockResolvedValue(undefined) },
    });
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    try {
      act(() => {
        dictate("look at wrld");
      });
      const bar = await mountBar(onSend);
      await act(async () => {
        const at = bar.view.state.doc.length + 1;
        bar.view.dispatch({
          changes: { from: at - 1, insert: ` ${IMAGE}` },
          effects: addImageChip.of({
            from: at,
            to: at + IMAGE.length,
            filePath: IMAGE,
            thumbnailUrl: "data:image/png;base64,",
          }),
        });
      });
      await act(async () => {
        runScopeHandlers(bar.view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
      });
      act(() => {
        bar.unmount();
      });
      expect(submit).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Look at world." });
      });
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    } finally {
      useFleetArmingStore.setState({
        armedIds: new Set(),
        armOrder: [],
        armOrderById: {},
        lastArmedId: null,
      });
    }

    expect(onSend).not.toHaveBeenCalled();
    expect(submit.mock.calls.map(([id]) => id).sort()).toEqual([PANEL_ID, "term-2"]);
    for (const [, text, , , images] of submit.mock.calls) {
      expect(text).toBe(`Look at world. ${IMAGE}`);
      expect(images).toEqual([IMAGE]);
    }
  });

  it("sends the words as dictated when the cleanup fails", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    await enterThenLeave(onSend);

    await act(async () => {
      pending.resolve({ action: "no_change", correctedText: "hello wrld", failed: true });
    });

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["hello wrld"]);
    expect(draft()).toBe("");
  });

  it("is reopened by a dictation started in its draft, leaving both passages unsent (#15703)", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    await enterThenLeave(onSend);
    await act(async () => {
      dictate("these are the next prompt");
    });
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(draft()).toBe("Hello world. these are the next prompt");
  });

  it("shows the wait in the composer that mounts for it, whose second Enter sends what stands", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const onSend = vi.fn();
    act(() => {
      dictate("hello wrld");
    });
    await enterThenLeave(onSend);

    const again = await mountBar(onSend);
    expect(again.view.state.facet(EditorView.editable)).toBe(false);

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    });

    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["hello wrld"]);
    expect(again.view.state.doc.toString()).toBe("");
    expect(draft()).toBe("");

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe("HybridInputBar dictated send whose composer went disabled before it unmounted (#15510)", () => {
  it("still sends through its submit, which checks the destination itself", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    const submitText = vi.fn(async (_text: string, _imagePaths: readonly string[]) => true);
    const bar = (disabled: boolean) => (
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar
            terminalId={PANEL_ID}
            cwd={WT_ID}
            agentId="claude"
            disabled={disabled}
            onSend={vi.fn()}
            submitText={submitText}
          />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    act(() => {
      dictate("hello wrld");
    });
    const result = render(bar(false));
    await act(async () => {});
    const view = EditorView.findFromDOM(
      result.container.querySelector<HTMLElement>(".cm-editor")!
    )!;
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    // A Canopy reply's stream dropping mid-wait disables its composer.
    result.rerender(bar(true));
    await act(async () => {});
    act(() => {
      result.unmount();
    });

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(submitText.mock.calls.map(([text]) => text)).toEqual(["Hello world."]);
    expect(draft()).toBe("");
  });
});

describe("HybridInputBar stop-and-send pressed again while its send waits (#15705)", () => {
  const panes: HTMLElement[] = [];
  beforeEach(() => {
    const actions: ActionRegistry = new Map();
    registerVoiceActions(actions);
    actionService.register(actions.get("voiceInput.stopAndSend")!());
  });
  afterEach(() => {
    actionService.unregister("voiceInput.stopAndSend");
    panes.splice(0).forEach((pane) => pane.remove());
    useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
  });

  function GlobalKeys() {
    useGlobalKeybindings(true);
    return null;
  }

  const combo = () => keybindingService.getEffectiveCombo("voiceInput.stopAndSend")!;

  /** The key as the keyboard sends it, at whatever has focus. */
  function pressStopAndSend() {
    const parts = combo().split("+");
    const key = parts.pop()!;
    const event = new KeyboardEvent("keydown", {
      key: key.length === 1 ? key.toLowerCase() : key,
      code: /^[A-Z]$/.test(key) ? `Key${key}` : key === "." ? "Period" : key,
      metaKey: parts.includes("Cmd") && isMac(),
      ctrlKey: parts.includes("Ctrl") || (parts.includes("Cmd") && !isMac()),
      shiftKey: parts.includes("Shift"),
      altKey: parts.includes("Alt"),
      bubbles: true,
      cancelable: true,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  }

  /** Another pane's text field, which records every key that reaches it. */
  function otherPane() {
    const pane = document.createElement("textarea");
    const received: string[] = [];
    pane.addEventListener("keydown", (event) => received.push(event.key));
    document.body.appendChild(pane);
    panes.push(pane);
    return { pane, received };
  }

  const caption = () => document.querySelector("[data-voice-submit-caption]")?.textContent ?? "";
  const keyText = () => formatChordText(combo(), isMac());
  const status = () => statuses().find((text) => text.startsWith("Polishing")) ?? "";
  const inComposer = () =>
    document.activeElement?.closest(`[data-hybrid-input-root="${PANEL_ID}"]`) != null;

  async function pastTheGate() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, UI_INLINE_LOADING_GATE_MS + 50));
    });
  }

  /** Dictates a passage whose cleanup is held, and sends it with the key. */
  async function sendWithTheKey(onSend: (payload: { text: string }) => void, inPane: boolean) {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    act(() => {
      dictate("hello wrld");
    });
    const view = await mount(onSend, <GlobalKeys />);
    const other = otherPane();
    if (inPane) other.pane.focus();
    else view.focus();
    expect(inPane ? document.activeElement === other.pane : inComposer()).toBe(true);

    let first!: KeyboardEvent;
    await act(async () => {
      first = pressStopAndSend();
    });
    expect(first.defaultPrevented).toBe(true);
    await pastTheGate();
    expect(onSend).not.toHaveBeenCalled();
    return { pending, ...other };
  }

  it("sends what stands at the key pressed again with the keyboard in its composer", async () => {
    const onSend = vi.fn();
    const { pending } = await sendWithTheKey(onSend, false);
    expect(inComposer()).toBe(true);
    expect(caption()).toContain(`${keyText()} to send as dictated`);
    expect(caption()).toMatch(/Esc to cancel/);
    expect(status()).toContain(`Press ${describeChord(combo(), isMac())} to send it as dictated`);
    expect(status()).toMatch(/Escape to cancel the send/);

    let second!: KeyboardEvent;
    await act(async () => {
      second = pressStopAndSend();
    });

    expect(second.defaultPrevented).toBe(true);
    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["hello wrld"]);
    expect(caption()).toMatch(/cleanup skipped/);
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("sends what stands at the key pressed again with the keyboard in another pane, whose own keys stay its", async () => {
    const onSend = vi.fn();
    const { pending, pane, received } = await sendWithTheKey(onSend, true);
    expect(caption()).toBe(`Polishing… · ${keyText()} to send as dictated`);
    expect(status()).toBe(
      `Polishing dictation. Press ${describeChord(combo(), isMac())} to send it as dictated.`
    );
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      pane.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(received).toEqual(["Enter", "Escape"]);
    expect(onSend).not.toHaveBeenCalled();

    let second!: KeyboardEvent;
    await act(async () => {
      second = pressStopAndSend();
    });

    expect(second.defaultPrevented).toBe(true);
    expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["hello wrld"]);
    expect(caption()).toMatch(/cleanup skipped/);
    expect(document.activeElement).toBe(pane);

    // With no send waiting, the key is the pane's again.
    received.length = 0;
    let after!: KeyboardEvent;
    await act(async () => {
      after = pressStopAndSend();
    });
    expect(after.defaultPrevented).toBe(false);
    expect(received).toHaveLength(1);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("leaves the key to a dictation running elsewhere, and names it again once that ends", async () => {
    const onSend = vi.fn();
    const { pending } = await sendWithTheKey(onSend, true);
    const sendElsewhere = vi.fn();
    const unregister = voiceRecordingService.onSpokenSend("term-2", undefined, sendElsewhere);
    try {
      act(() => {
        useVoiceRecordingStore.getState().beginSession({ panelId: "term-2" });
        useVoiceRecordingStore.getState().setStatus("recording");
      });
      expect(caption()).toBe("Polishing…");

      await act(async () => {
        pressStopAndSend();
      });
      expect(sendElsewhere).toHaveBeenCalledWith({ spoken: false, asker: "stop_and_send_key" });
      expect(onSend).not.toHaveBeenCalled();

      act(() => {
        useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
      });
      expect(caption()).toContain(`${keyText()} to send as dictated`);
      await act(async () => {
        pressStopAndSend();
      });
      expect(onSend.mock.calls.map(([payload]) => payload.text)).toEqual(["hello wrld"]);
    } finally {
      unregister();
      await act(async () => {
        pending.resolve({ action: "no_change", correctedText: "hello wrld" });
      });
    }
  });

  it("names no key while a guest page or another app holds the keyboard, whose keys never reach it", async () => {
    const onSend = vi.fn();
    const { pending, pane } = await sendWithTheKey(onSend, true);
    const named = `${keyText()} to send as dictated`;
    const guest = document.createElement("iframe");
    document.body.appendChild(guest);
    panes.push(guest);
    try {
      act(() => {
        window.dispatchEvent(new FocusEvent("blur"));
      });
      expect(caption()).toBe("Polishing…");
      expect(status()).toBe("Polishing dictation.");

      act(() => {
        window.dispatchEvent(new FocusEvent("focus"));
      });
      expect(caption()).toContain(named);

      // Focus entering a guest page leaves the page with a focusout only.
      await act(async () => {
        guest.focus();
      });
      expect(document.activeElement).toBe(guest);
      expect(caption()).toBe("Polishing…");

      act(() => {
        pane.focus();
      });
      expect(caption()).toContain(named);
    } finally {
      window.dispatchEvent(new FocusEvent("focus"));
      await act(async () => {
        pending.resolve({ action: "no_change", correctedText: "hello wrld" });
      });
    }
  });

  // #15703: a dictation started in its draft reopens it, and the key no longer sends it.
  it("lets go of the key once a dictation in its draft reopens the send", async () => {
    const onSend = vi.fn();
    const { pending } = await sendWithTheKey(onSend, true);
    expect(hasWaitingStopAndSend()).toBe(true);

    act(() => {
      dictate("and more");
    });

    expect(hasWaitingStopAndSend()).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve({ action: "no_change", correctedText: "hello wrld" });
    });
    expect(onSend).not.toHaveBeenCalled();
  });
});
