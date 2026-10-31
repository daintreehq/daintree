import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceStopReason } from "@shared/types/voiceSessionSummary";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";

// Drives the real voice store through the IPC callbacks to prove a spoken
// "send it" reaches the panel's composer only when it can send a real prompt.

const draftState = vi.hoisted(() => ({ draft: "" }));

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn(() => draftState.draft),
    setDraftInput: vi.fn((_panelId: string, value: string) => {
      draftState.draft = value;
    }),
    bumpExternalDraftRevision: vi.fn(),
  };
  const getState = () => fns;
  const subscribe = vi.fn(() => () => {});
  return { useTerminalInputStore: Object.assign(getState, { getState, subscribe }) };
});

vi.mock("@/store/panelStore", () => {
  const state = { panelsById: {}, panelIds: [], focusedId: null };
  const getState = () => state;
  return { usePanelStore: Object.assign(getState, { getState, subscribe: vi.fn(() => () => {}) }) };
});

vi.mock("@/store/projectStore", () => {
  const getState = () => ({ currentProject: null, isSwitching: false, switchProject: vi.fn() });
  return { useProjectStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

vi.mock("@/store/worktreeStore", () => {
  const getState = () => ({ activeWorktreeId: null, selectWorktree: vi.fn() });
  return { useWorktreeSelectionStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/helpPanelStore", () => {
  const state = { isOpen: false, terminalId: null };
  const getState = () => ({ ...state, setOpen: vi.fn(), requestFocus: vi.fn() });
  return {
    useHelpPanelStore: Object.assign(getState, { getState }),
    selectActiveSlot: (s: typeof state) => s,
  };
});

vi.mock("@/store/macroFocusStore", () => ({ isAssistantFocused: vi.fn(() => false) }));

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(),
    getEffectiveCombos: vi.fn(() => []),
    matchesEvent: vi.fn(),
  },
}));

type DeltaPayload = { sessionId: string; text: string; itemId?: string; replace?: boolean };
type CompletePayload = {
  sessionId: string;
  text: string;
  willCorrect: boolean;
  itemId?: string;
  send?: boolean;
  commandText?: string;
};

const SESSION_ID = "session-1";

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: { sessionId: string; rawText: string | null }) => void) | null;
} = { delta: null, complete: null, boundary: null };

// Main's drain, held open until the test lets the stop go on.
const remoteStop = vi.hoisted(() => ({ release: null as (() => void) | null }));

function stubElectron() {
  const electron = {
    voiceInput: {
      stop: vi.fn(
        () =>
          new Promise<null>((resolve) => {
            remoteStop.release = () => resolve(null);
          })
      ),
      onTranscriptionDelta: vi.fn((cb: (payload: DeltaPayload) => void) => {
        callbacks.delta = cb;
        return () => {};
      }),
      onTranscriptionComplete: vi.fn((cb: (payload: CompletePayload) => void) => {
        callbacks.complete = cb;
        return () => {};
      }),
      onParagraphBoundary: vi.fn(
        (cb: (payload: { sessionId: string; rawText: string | null }) => void) => {
          callbacks.boundary = cb;
          return () => {};
        }
      ),
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
      getSettings: vi.fn().mockResolvedValue({ enabled: false }),
    },
    systemSleep: {
      onSuspend: vi.fn(() => () => {}),
      onWake: vi.fn(() => () => {}),
    },
  };
  vi.stubGlobal("window", {
    electron,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

const PANEL_ID = "panel-1";

async function setup() {
  stubElectron();
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  voiceRecordingService.initialize();
  useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID });
  useVoiceRecordingStore.getState().setStatus("recording");
  const stop = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue(undefined);
  const liveText = () => useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText;
  return { voiceRecordingService, useVoiceRecordingStore, stop, liveText };
}

const delta = (text: string, itemId: string) =>
  callbacks.delta!({ sessionId: SESSION_ID, text, itemId });
const complete = (text: string, itemId: string, send?: boolean) =>
  callbacks.complete!({
    sessionId: SESSION_ID,
    text,
    willCorrect: false,
    itemId,
    ...(send ? { send } : {}),
  });

// The mocked logger outlives `vi.resetModules()`, so earlier tests' lines would
// otherwise count in the refusals of later ones.
beforeEach(() => {
  vi.clearAllMocks();
});

// The lines a refused send request leaves (#15704), in the order they were logged.
async function refusals() {
  const { logInfo } = await import("@/utils/logger");
  const { VOICE_SEND_REFUSED_MESSAGE } = await import("../voiceSendDiagnostics");
  return vi
    .mocked(logInfo)
    .mock.calls.filter(([message]) => message === VOICE_SEND_REFUSED_MESSAGE)
    .map(([, context]) => context);
}

describe("VoiceRecordingService — spoken send (#14633)", () => {
  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    remoteStop.release = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the composer the send once the utterance's text is in and its preview gone", async () => {
    const { voiceRecordingService, stop, liveText } = await setup();
    draftState.draft = "Fix the";
    const seen: Array<{ draft: string; liveText: string | undefined }> = [];
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, () =>
      seen.push({ draft: draftState.draft, liveText: liveText() })
    );

    delta("login bug send it", "item-a");
    complete("login bug", "item-a", true);

    expect(seen).toEqual([{ draft: "Fix the login bug", liveText: "" }]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("sends a spoken opening command, however short, once it is written as typed", async () => {
    const { voiceRecordingService, stop } = await setup();
    const seen: string[] = [];
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, () => seen.push(draftState.draft));

    callbacks.complete!({
      sessionId: SESSION_ID,
      text: "Slash compact",
      willCorrect: false,
      itemId: "item-a",
      commandText: "/compact",
      send: true,
    });

    expect(seen).toEqual(["/compact"]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does nothing for a completion without the send", async () => {
    const { voiceRecordingService, stop } = await setup();
    const handler = vi.fn();
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

    complete("fix the login bug", "item-a");

    expect(handler).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("only stops dictation when the draft is %j", async (empty) => {
    const { voiceRecordingService, stop } = await setup();
    draftState.draft = empty;
    const handler = vi.fn();
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

    complete("", "item-a", true);

    expect(handler).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith("Dictation stopped.", { reason: "send" });
  });

  // #14944: a stop alone looks like any other, so the composer says it wasn't sent.
  it.each(["yes", "go ahead", "  ok , ! "])(
    "stops quietly and has the composer say %j was kept, not sent",
    async (reply) => {
      const { voiceRecordingService, useVoiceRecordingStore, stop } = await setup();
      draftState.draft = reply;
      // The composer hears of it once the stop is under way, never ahead of it.
      const stopsBeforeHandler: number[] = [];
      const handler = vi.fn(() => stopsBeforeHandler.push(stop.mock.calls.length));
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

      complete("", "item-a", true);

      expect(stopsBeforeHandler).toEqual([1]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ tooShort: true });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ reason: "send", announce: false })
      );
      expect(draftState.draft).toBe(reply);
      expect(useVoiceRecordingStore.getState().announcement).toBeNull();
    }
  );

  it("only stops dictation when no composer shows the panel", async () => {
    const { stop } = await setup();

    complete("fix the login bug", "item-a", true);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  describe("landed by a stop's drain (#14803)", () => {
    // A real stop, held in main's drain, as the release of the key leaves it.
    async function stopping(reason: VoiceStopReason) {
      const harness = await setup();
      harness.stop.mockRestore();
      (harness.voiceRecordingService as unknown as { sessionId: string }).sessionId = SESSION_ID;
      const stopped = harness.voiceRecordingService.stop("Dictation stopped.", {
        preserveLiveText: true,
        reason,
      });
      await vi.waitFor(() => expect(window.electron.voiceInput.stop).toHaveBeenCalled());
      expect(harness.useVoiceRecordingStore.getState().status).toBe("finishing");
      const stop = vi.spyOn(harness.voiceRecordingService, "stop");
      const finish = async () => {
        remoteStop.release?.();
        await stopped;
      };
      return { ...harness, stop, finish };
    }

    it.each(["key_release", "user"] as const)(
      "hands the composer a send its own %s stop lands, and stops nothing more",
      async (reason) => {
        const { voiceRecordingService, stop, finish } = await stopping(reason);
        draftState.draft = "Fix the";
        const seen: string[] = [];
        voiceRecordingService.onSpokenSend(PANEL_ID, undefined, () => seen.push(draftState.draft));

        complete("login bug", "item-a", true);

        expect(seen).toEqual(["Fix the login bug"]);
        expect(stop).not.toHaveBeenCalled();
        await finish();
      }
    );

    it.each(["escape", "window_blur", "send", "retarget", "superseded", "idle_timeout"] as const)(
      "ignores a send landed by a %s stop",
      async (reason) => {
        const { voiceRecordingService, stop, finish } = await stopping(reason);
        const handler = vi.fn();
        voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

        complete("fix the login bug", "item-a", true);

        expect(handler).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        await finish();
      }
    );

    it.each(["escape", "retarget"] as const)(
      "logs a send landed by a %s stop as refused, with that stop's session",
      async (reason) => {
        const { voiceRecordingService, finish } = await stopping(reason);
        voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());

        complete("fix the login bug", "item-a", true);

        expect(await refusals()).toEqual([
          {
            asker: "spoken_send",
            reason: "stop_not_users",
            panelId: PANEL_ID,
            sessionId: SESSION_ID,
          },
        ]);
        await finish();
      }
    );

    it("ignores the send once something else joins the stop", async () => {
      const { voiceRecordingService, stop, finish } = await stopping("key_release");
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
      const joined = voiceRecordingService.stop("Dictation stopped because its panel was closed.", {
        reason: "panel_closed",
      });

      complete("fix the login bug", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
      await finish();
      await joined;
    });

    it.each([PANEL_ID, "panel-2"])(
      "ignores the send once the next dictation has started, on %s",
      async (panelId) => {
        const { voiceRecordingService, stop, finish } = await stopping("key_release");
        const handler = vi.fn();
        voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
        // Not awaited: the start waits on the stop, and this one can't finish.
        void voiceRecordingService.start({ panelId }).catch(() => {});

        complete("fix the login bug", "item-a", true);

        expect(handler).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        await finish();
      }
    );

    it("takes no send the stop's drain lands when no composer shows the panel", async () => {
      const { stop, finish } = await stopping("key_release");

      complete("fix the login bug", "item-a", true);

      expect(stop).not.toHaveBeenCalled();
      await finish();
    });

    it.each(["key_release", "user"] as const)(
      "never stops a second time for a draft too short to send, and leaves the %s stop's word to the composer",
      async (reason) => {
        const { voiceRecordingService, useVoiceRecordingStore, stop, finish } =
          await stopping(reason);
        draftState.draft = "fix it";
        const handler = vi.fn();
        voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

        complete("", "item-a", true);

        expect(handler).toHaveBeenCalledWith({ tooShort: true });
        expect(stop).not.toHaveBeenCalled();
        await finish();
        expect(useVoiceRecordingStore.getState().announcement).toBeNull();
      }
    );

    it("lets the next stop say it stopped again", async () => {
      const { voiceRecordingService, useVoiceRecordingStore, finish } =
        await stopping("key_release");
      draftState.draft = "fix it";
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());
      complete("", "item-a", true);
      await finish();
      expect(useVoiceRecordingStore.getState().announcement).toBeNull();

      useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID });
      useVoiceRecordingStore.getState().setStatus("recording");
      await voiceRecordingService.stop("Dictation stopped.", { reason: "user" });

      expect(useVoiceRecordingStore.getState().announcement?.text).toBe("Dictation stopped.");
    });

    it("says it stopped as before when the stop's drain lands a send on an empty draft", async () => {
      const { voiceRecordingService, useVoiceRecordingStore, finish } =
        await stopping("key_release");
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

      complete("", "item-a", true);
      await finish();

      expect(handler).not.toHaveBeenCalled();
      expect(useVoiceRecordingStore.getState().announcement?.text).toBe("Dictation stopped.");
    });

    it("ignores a send that lands after the stop is over", async () => {
      const { voiceRecordingService, stop, finish } = await stopping("key_release");
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
      await finish();

      complete("fix the login bug", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    });

    it("leaves the next session's finishing without the last stop's say", async () => {
      const { voiceRecordingService, useVoiceRecordingStore, stop, finish } =
        await stopping("key_release");
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
      await finish();
      useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID });
      useVoiceRecordingStore.getState().setStatus("finishing");

      complete("fix the login bug", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    });
  });

  it("leaves the send to the composer showing the dictated draft's scope", async () => {
    const { voiceRecordingService, stop } = await setup();
    const isolated = vi.fn();
    voiceRecordingService.onSpokenSend(PANEL_ID, "isolated-composer", isolated);

    complete("fix the login bug", "item-a", true);

    expect(isolated).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer composer's registration when an older one unregisters", async () => {
    const { voiceRecordingService } = await setup();
    const older = vi.fn();
    const newer = vi.fn();
    const unregisterOlder = voiceRecordingService.onSpokenSend(PANEL_ID, undefined, older);
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, newer);
    unregisterOlder();

    complete("fix the login bug", "item-a", true);

    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceRecordingService — spoken send to a Canopy reply off screen (#14778)", () => {
  const REPLY = {
    panelId: "isolated-composer:run-1",
    panelTitle: "Reply to Claude",
    surface: "canopy-reply" as const,
    canopyRow: { runId: "run-1", hostScope: null },
  };

  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setupReply(canopyOpen: boolean) {
    stubElectron();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    const { useCanopyStore } = await import("@/store/canopyStore");
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();
    useCanopyStore.setState({ isOpen: canopyOpen });
    useVoiceRecordingStore.getState().beginSession(REPLY);
    useVoiceRecordingStore.getState().setStatus("recording");
    const stop = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue(undefined);
    return { voiceRecordingService, useVoiceRecordingStore, useCanopyStore, stop };
  }

  it("keeps recording into the reply's draft when Canopy is closed, and sends nothing", async () => {
    const { useVoiceRecordingStore, stop } = await setupReply(false);
    draftState.draft = "Fix the";

    delta("login bug send it", "item-a");
    complete("login bug", "item-a", true);

    expect(draftState.draft).toBe("Fix the login bug");
    expect(stop).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().status).toBe("recording");
    expect(useVoiceRecordingStore.getState().activeTarget?.panelId).toBe(REPLY.panelId);
  });

  it("sends nothing while Canopy shows another row's reply instead", async () => {
    const { voiceRecordingService, useVoiceRecordingStore, stop } = await setupReply(true);
    const otherRow = vi.fn();
    voiceRecordingService.onSpokenSend("isolated-composer:run-2", undefined, otherRow);
    draftState.draft = "Fix the";

    complete("login bug", "item-a", true);

    expect(otherRow).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(draftState.draft).toBe("Fix the login bug");
    expect(useVoiceRecordingStore.getState().status).toBe("recording");
  });

  it("sends from the reply while it is on screen", async () => {
    const { voiceRecordingService, stop } = await setupReply(true);
    const handler = vi.fn();
    voiceRecordingService.onSpokenSend(REPLY.panelId, undefined, handler);

    complete("fix the login bug", "item-a", true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(await refusals()).toEqual([]);
  });

  it.each([
    ["closed", false, true],
    ["off screen", true, false],
  ])("logs a send to a reply that is %s as refused", async (_name, canopyOpen, hasHandler) => {
    const { voiceRecordingService } = await setupReply(canopyOpen);
    if (hasHandler) voiceRecordingService.onSpokenSend(REPLY.panelId, undefined, vi.fn());

    complete("fix the login bug", "item-a", true);

    expect(await refusals()).toEqual([
      {
        asker: "spoken_send",
        reason: "composer_unavailable",
        panelId: REPLY.panelId,
        sessionId: SESSION_ID,
      },
    ]);
  });

  it("doesn't send from a reply still fading out as Canopy closes", async () => {
    const { voiceRecordingService, stop } = await setupReply(false);
    const handler = vi.fn();
    voiceRecordingService.onSpokenSend(REPLY.panelId, undefined, handler);

    complete("fix the login bug", "item-a", true);

    expect(handler).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("VoiceRecordingService — the session panel's Send (#14920)", () => {
  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
    notify.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends from the composer as Enter would, with no stop of its own", async () => {
    const { voiceRecordingService, stop } = await setup();
    const handler = vi.fn();
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

    expect(voiceRecordingService.canSendActiveSession()).toBe(true);
    await voiceRecordingService.stopAndSend();

    // Not a spoken "send it": a short draft goes, as it would on Enter.
    expect(handler).toHaveBeenCalledWith({ spoken: false, asker: "stop_and_send_key" });
    expect(stop).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("still stops, and says the prompt wasn't sent, with no composer to send from", async () => {
    const { voiceRecordingService, stop } = await setup();

    expect(voiceRecordingService.canSendActiveSession()).toBe(false);
    await voiceRecordingService.stopAndSend();

    expect(stop).toHaveBeenCalledWith("Dictation stopped.", {
      preserveLiveText: true,
      reason: "user",
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Dictation stopped" }));
  });

  it("has nothing to send once the session is finishing", async () => {
    const { voiceRecordingService, useVoiceRecordingStore } = await setup();
    const handler = vi.fn();
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
    useVoiceRecordingStore.getState().setStatus("finishing");

    expect(voiceRecordingService.canSendActiveSession()).toBe(false);
    expect(voiceRecordingService.sendActiveSession()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores another project's composer for the same pane id", async () => {
    const { voiceRecordingService } = await setup();
    voiceRecordingService.onSpokenSend(PANEL_ID, "other-project", vi.fn());

    expect(voiceRecordingService.canSendActiveSession()).toBe(false);
  });
});

describe("VoiceRecordingService — a send request that goes nowhere leaves a line (#15704)", () => {
  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    remoteStop.release = null;
    notify.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const spoken = (reason: string, panelId: string | null = PANEL_ID) => ({
    asker: "spoken_send",
    reason,
    panelId,
    sessionId: SESSION_ID,
  });

  describe("a spoken send", () => {
    it("says nothing when the composer takes it", async () => {
      const { voiceRecordingService } = await setup();
      draftState.draft = "Fix the login bug in the settings panel";
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());

      complete("", "item-a", true);
      complete("fix it", "item-b");

      expect(await refusals()).toEqual([]);
    });

    it("says no composer shows the panel, though the dictation stops", async () => {
      const { stop } = await setup();
      draftState.draft = "Fix the login bug in the settings panel";

      complete("", "item-a", true);

      expect(stop).toHaveBeenCalledTimes(1);
      expect(await refusals()).toEqual([spoken("composer_unavailable")]);
    });

    it("says the draft is empty", async () => {
      const { voiceRecordingService } = await setup();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());

      complete("", "item-a", true);

      expect(await refusals()).toEqual([spoken("draft_empty")]);
    });

    it("says the draft is too short to send by voice, once", async () => {
      const { voiceRecordingService } = await setup();
      draftState.draft = "yes";
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());

      complete("", "item-a", true);

      expect(await refusals()).toEqual([spoken("draft_too_short")]);
    });

    it("says the session isn't recording", async () => {
      const { voiceRecordingService, useVoiceRecordingStore } = await setup();
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
      useVoiceRecordingStore.getState().setStatus("paused");

      complete("fix the login bug", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(await refusals()).toEqual([spoken("not_recording")]);
    });

    it("says the dictation had moved to another panel", async () => {
      const { voiceRecordingService } = await setup();
      (
        voiceRecordingService as unknown as {
          handleSpokenSend: (panelId: string, projectId: undefined, sessionId: string) => void;
        }
      ).handleSpokenSend("panel-2", undefined, SESSION_ID);

      expect(await refusals()).toEqual([spoken("target_changed", "panel-2")]);
    });

    it("says its session was already discarded, only when it carried a send", async () => {
      const { voiceRecordingService } = await setup();
      const discarded = (voiceRecordingService as unknown as { discardedSessionIds: Set<string> })
        .discardedSessionIds;
      discarded.add(SESSION_ID);
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());

      complete("fix the login bug", "item-a");
      expect(await refusals()).toEqual([]);

      complete("fix the login bug", "item-b", true);
      expect(await refusals()).toEqual([spoken("session_discarded")]);
    });

    it("says a scratch kept the send from going", async () => {
      const { voiceRecordingService } = await setup();
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
      draftState.draft = "Fix the login bug in the settings panel";

      complete("scratch that", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(await refusals()).toEqual([spoken("scratch_precedence")]);
    });

    it("carries no words from the draft or the utterance", async () => {
      const { voiceRecordingService } = await setup();
      draftState.draft = "rotate the staging credentials";
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());

      complete("deploy to production", "item-a", true);
      draftState.draft = "";
      complete("deploy to production", "item-b", true);

      const lines = JSON.stringify(await refusals());
      expect(lines).not.toMatch(/credentials|production|staging/);
    });
  });

  describe("stopAndSend", () => {
    const sessionIn = (
      store: Awaited<ReturnType<typeof setup>>["useVoiceRecordingStore"]
    ): string | null => store.getState().panelBuffers[PANEL_ID]?.dictationSessionId ?? null;

    it.each([
      ["the stop-and-send key", undefined, "stop_and_send_key"],
      ["the session panel's Send", { asker: "session_panel_send" } as const, "session_panel_send"],
    ])("says who asked when %s finds no composer to send from", async (_name, options, asker) => {
      const { voiceRecordingService, useVoiceRecordingStore } = await setup();
      const sessionId = sessionIn(useVoiceRecordingStore);

      await voiceRecordingService.stopAndSend(options);

      expect(sessionId).toEqual(expect.any(String));
      expect(await refusals()).toEqual([
        { asker, reason: "composer_unavailable", panelId: PANEL_ID, sessionId },
      ]);
    });

    it("says nothing when the composer is asked, whatever it does with the request", async () => {
      const { voiceRecordingService } = await setup();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());

      await voiceRecordingService.stopAndSend();
      await voiceRecordingService.stopAndSend({ asker: "session_panel_send" });

      expect(await refusals()).toEqual([]);
    });

    it("says the session is already finishing, which it never stops a second time", async () => {
      const { voiceRecordingService, useVoiceRecordingStore } = await setup();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, vi.fn());
      useVoiceRecordingStore.getState().setStatus("finishing");
      const sessionId = sessionIn(useVoiceRecordingStore);

      await voiceRecordingService.stopAndSend();

      expect(await refusals()).toEqual([
        { asker: "stop_and_send_key", reason: "session_finishing", panelId: PANEL_ID, sessionId },
      ]);
    });

    it("says there is no dictation to send", async () => {
      const { voiceRecordingService, useVoiceRecordingStore } = await setup();
      useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });

      await voiceRecordingService.stopAndSend();

      expect(await refusals()).toEqual([
        { asker: "stop_and_send_key", reason: "no_session", panelId: null, sessionId: null },
      ]);
    });

    it("says another view's dictation was only stopped there, with that session", async () => {
      const { voiceRecordingService, useVoiceRecordingStore } = await setup();
      useVoiceRecordingStore.setState({
        status: "idle",
        activeTarget: null,
        sessionElsewhere: {
          sessionId: "remote-session",
          hostId: LOCAL_HOST_ID,
          projectId: null,
          projectName: null,
          details: null,
        },
      });

      await voiceRecordingService.stopAndSend({ asker: "session_panel_send" });

      expect(await refusals()).toEqual([
        {
          asker: "session_panel_send",
          reason: "session_elsewhere",
          panelId: null,
          sessionId: "remote-session",
        },
      ]);
    });
  });
});
