// @vitest-environment jsdom
/**
 * A spoken "send it" on a reply too short to send by voice, through the real
 * composer, voice service and stores: the reply stays, and the composer says it
 * wasn't sent and how to send it, rather than the stop passing for any other
 * (#14944).
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
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string; send?: boolean };
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
function startDictating() {
  useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID });
  useVoiceRecordingStore.getState().setStatus("recording");
}
// The utterance's words as main hands them over, the "send it" already taken off.
function say(text: string, send = false) {
  const itemId = `item-${++itemSeq}`;
  callbacks.delta!({ text, itemId });
  callbacks.complete!({ text, willCorrect: false, itemId, ...(send ? { send } : {}) });
}

const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL_ID);

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
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
  useVoiceRecordingStore.setState({
    panelBuffers: {},
    activeTarget: null,
    status: "idle",
    announcement: null,
  });
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

async function mount() {
  const onSend = vi.fn();
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId={PANEL_ID} cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const caption = () =>
    result.container.querySelector("[data-send-refused-caption]")?.textContent ?? null;
  const spoken = () =>
    Array.from(result.container.querySelectorAll('[role="status"]'))
      .map((el) => el.textContent)
      .join("");
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
  };
  return { view, onSend, caption, spoken, pressEnter };
}

const SHORT_CAPTION = "Too short to send by voice · Enter to send";

describe("HybridInputBar spoken send of a reply too short to send by voice (#14944)", () => {
  it("keeps the reply, says so through its cleanup, and sends it on Enter", async () => {
    const cleanup = deferred<CorrectResult>();
    correct.mockReturnValueOnce(cleanup.promise);
    const { view, onSend, caption, spoken, pressEnter } = await mount();

    await act(async () => {
      startDictating();
      say("yes", true);
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(draft()).toBe("yes");
    expect(caption()).toBe(SHORT_CAPTION);
    expect(spoken()).toContain("Not sent: a voice send needs three or more words");
    expect(spoken()).toContain("Press Enter");
    // The composer says what became of the reply; the stop doesn't say it stopped over it.
    expect(useVoiceRecordingStore.getState().status).toBe("idle");
    expect(useVoiceRecordingStore.getState().announcement).toBeNull();

    // The stop's cleanup lands after it, over the reply the note is about.
    expect(correct).toHaveBeenCalledTimes(1);
    await act(async () => {
      cleanup.resolve({ action: "replace", correctedText: "Yes." });
    });
    expect(view.state.doc.toString()).toBe("Yes.");
    expect(caption()).toBe(SHORT_CAPTION);

    await pressEnter();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].text).toBe("Yes.");
    expect(caption()).toBeNull();
    expect(spoken()).not.toContain("Not sent");
  });

  it("drops the note once the reply is edited", async () => {
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const { view, caption, spoken } = await mount();
    await act(async () => {
      startDictating();
      say("go ahead", true);
    });
    expect(caption()).toBe(SHORT_CAPTION);

    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: " please" },
        userEvent: "input.type",
      });
    });

    expect(caption()).toBeNull();
    expect(spoken()).not.toContain("Not sent");
  });

  it("drops the note when dictation starts again on the reply, and leaves it gone after", async () => {
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const { caption } = await mount();
    await act(async () => {
      startDictating();
      say("continue", true);
    });
    expect(caption()).toBe(SHORT_CAPTION);

    await act(async () => {
      startDictating();
    });
    expect(caption()).toBeNull();

    await act(async () => {
      await voiceRecordingService.stop("Dictation stopped.", { reason: "user" });
    });
    expect(caption()).toBeNull();
  });

  it("says nothing more than the stop for a send on an empty draft", async () => {
    const { onSend, caption, spoken } = await mount();

    await act(async () => {
      startDictating();
      say("", true);
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(caption()).toBeNull();
    expect(spoken()).not.toContain("Not sent");
    expect(useVoiceRecordingStore.getState().announcement?.text).toBe("Dictation stopped.");
  });

  it("says the same of a reply its cleanup leaves too short to send", async () => {
    const cleanup = deferred<CorrectResult>();
    correct.mockReturnValueOnce(cleanup.promise);
    const { view, onSend, caption, spoken } = await mount();

    await act(async () => {
      startDictating();
      say("um so yeah", true);
    });
    // Long enough as heard, so the send waits on the cleanup as Enter would.
    expect(caption()).toBeNull();

    await act(async () => {
      cleanup.resolve({ action: "replace", correctedText: "Yeah." });
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("Yeah.");
    expect(caption()).toBe(SHORT_CAPTION);
    expect(spoken()).toContain("Not sent: a voice send needs three or more words");
    expect(spoken()).not.toContain("The draft is still here");
  });
});
