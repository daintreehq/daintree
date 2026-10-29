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
  // jsdom has no Web Animations. A send's wait that outlasts the progress gate
  // on a slow runner fades out before the note shows, so each fade finishes.
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => {
      let onfinish: (() => void) | null = null;
      return {
        cancel: () => {},
        pause: () => {},
        get onfinish() {
          return onfinish;
        },
        set onfinish(fn: (() => void) | null) {
          onfinish = fn;
          if (fn) queueMicrotask(() => onfinish?.());
        },
      };
    },
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
    scratchRefusal: null,
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

async function mount({
  submitText,
}: { submitText?: (text: string, imagePaths: readonly string[]) => Promise<boolean> } = {}) {
  const onSend = vi.fn();
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId={PANEL_ID}
          cwd={WT_ID}
          agentId="claude"
          onSend={onSend}
          submitText={submitText}
        />
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
  const type = async (text: string) => {
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        userEvent: "input.type",
      });
    });
  };
  return { view, onSend, caption, spoken, pressEnter, type };
}

// A draft written from outside the composer, as a recalled prompt or a host
// writes it (moving the caret), or as the dictation does (leaving it).
async function writeDraft(text: string, { dictation = false } = {}) {
  await act(async () => {
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, text);
    useTerminalInputStore
      .getState()
      .bumpExternalDraftRevision(dictation ? { keepsSelection: true } : undefined);
  });
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
    const { view, caption, spoken, type } = await mount();
    await act(async () => {
      startDictating();
      say("go ahead", true);
    });
    expect(caption()).toBe(SHORT_CAPTION);

    await type(" please");

    expect(view.state.doc.toString()).toBe("go ahead please");
    expect(draft()).toBe("go ahead please");
    expect(caption()).toBeNull();
    expect(spoken()).not.toContain("Not sent");
  });

  it("drops the note when another prompt takes the reply's place", async () => {
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const { view, caption, spoken } = await mount();
    await act(async () => {
      startDictating();
      say("yes", true);
    });
    expect(caption()).toBe(SHORT_CAPTION);

    await writeDraft("fix the login bug");

    expect(view.state.doc.toString()).toBe("fix the login bug");
    expect(caption()).toBeNull();
    expect(spoken()).not.toContain("Not sent");
  });

  it.each(["", "  "])("drops the note when the dictation leaves the draft %j", async (emptied) => {
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const { caption, spoken } = await mount();
    await act(async () => {
      startDictating();
      say("yes", true);
    });
    expect(caption()).toBe(SHORT_CAPTION);

    await writeDraft(emptied, { dictation: true });

    expect(caption()).toBeNull();
    expect(spoken()).not.toContain("Not sent");
  });

  it.each(["arming", "connecting", "recording"] as const)(
    "drops the note when dictation on the reply is %s again, and leaves it gone after",
    async (status) => {
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });
      const { caption } = await mount();
      await act(async () => {
        startDictating();
        say("continue", true);
      });
      expect(caption()).toBe(SHORT_CAPTION);

      await act(async () => {
        const voice = useVoiceRecordingStore.getState();
        if (status === "arming") voice.setArming({ panelId: PANEL_ID });
        else voice.beginSession({ panelId: PANEL_ID });
        if (status === "recording") voice.setStatus("recording");
      });
      expect(useVoiceRecordingStore.getState().status).toBe(status);
      expect(caption()).toBeNull();

      await act(async () => {
        await voiceRecordingService.stop("Dictation stopped.", { reason: "user" });
      });
      expect(caption()).toBeNull();
    }
  );

  it("keeps the note while dictation goes to another pane", async () => {
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const { caption } = await mount();
    await act(async () => {
      startDictating();
      say("continue", true);
    });

    await act(async () => {
      useVoiceRecordingStore.getState().beginSession({ panelId: "term-2" });
      useVoiceRecordingStore.getState().setStatus("recording");
    });

    expect(caption()).toBe(SHORT_CAPTION);
  });

  it("keeps the note over an earlier send turned down after it", async () => {
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const settles: Array<(accepted: boolean) => void> = [];
    const submitText = vi.fn(() => new Promise<boolean>((resolve) => settles.push(resolve)));
    const { caption, spoken, type, pressEnter } = await mount({ submitText });
    await type("ok");
    await pressEnter();
    expect(submitText).toHaveBeenCalledTimes(1);

    await act(async () => {
      startDictating();
      say("yes", true);
    });
    expect(caption()).toBe(SHORT_CAPTION);

    await act(async () => {
      settles.shift()!(false);
    });

    expect(caption()).toBe(SHORT_CAPTION);
    expect(spoken()).toContain("Not sent: a voice send needs three or more words");
  });

  it("retires the scratch refusal it found on the border, never a newer one (#14973)", async () => {
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const { caption } = await mount();
    const scratchCaption = () => document.querySelector("[data-scratch-refused-caption]");

    await act(async () => {
      startDictating();
      say("Scratch that.");
    });
    expect(useVoiceRecordingStore.getState().scratchRefusal?.reason).toBe("nothing");
    expect(scratchCaption()).not.toBeNull();

    await act(async () => {
      say("yes", true);
    });

    expect(useVoiceRecordingStore.getState().scratchRefusal).toBeNull();
    expect(scratchCaption()).toBeNull();
    expect(caption()).toBe(SHORT_CAPTION);

    const newer = { panelId: PANEL_ID, reason: "edited" as const, id: 99 };
    act(() => {
      useVoiceRecordingStore.setState({ scratchRefusal: newer });
    });

    expect(useVoiceRecordingStore.getState().scratchRefusal).toBe(newer);
    expect(scratchCaption()).not.toBeNull();
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
    expect(correct).toHaveBeenCalledTimes(1);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);
    expect(caption()).toBeNull();

    await act(async () => {
      cleanup.resolve({ action: "replace", correctedText: "Yeah." });
    });
    // A wait long enough to show its progress fades out before the note shows.
    await act(async () => {});

    expect(onSend).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("Yeah.");
    expect(caption()).toBe(SHORT_CAPTION);
    expect(spoken()).toContain("Not sent: a voice send needs three or more words");
    expect(spoken()).not.toContain("The draft is still here");
  });
});
