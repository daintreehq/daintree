import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceStopReason } from "@shared/types/voiceSessionSummary";

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
      onFileTokenResolved: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      onSessionEnded: vi.fn(() => () => {}),
      onLiveSession: vi.fn(() => () => {}),
      onStopRequested: vi.fn(() => () => {}),
      onRevealRequested: vi.fn(() => () => {}),
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

  it.each(["", "fix it"])("only stops dictation when the draft is %j", async (draft) => {
    const { voiceRecordingService, stop } = await setup();
    draftState.draft = draft;
    const handler = vi.fn();
    voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

    complete("", "item-a", true);

    expect(handler).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

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

    it("ignores the send once a press has started the next dictation", async () => {
      const { voiceRecordingService, useVoiceRecordingStore, stop, finish } =
        await stopping("key_release");
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
      useVoiceRecordingStore.getState().setArming({ panelId: PANEL_ID });

      complete("fix the login bug", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      await finish();
    });

    it("ignores the send once a retry has started the next dictation", async () => {
      const { voiceRecordingService, stop, finish } = await stopping("key_release");
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);
      vi.spyOn(
        voiceRecordingService as unknown as { liveStartup: () => unknown },
        "liveStartup"
      ).mockReturnValue({});

      complete("fix the login bug", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      await finish();
    });

    it("never stops a second time for a draft too short to send", async () => {
      const { voiceRecordingService, stop, finish } = await stopping("key_release");
      draftState.draft = "fix it";
      const handler = vi.fn();
      voiceRecordingService.onSpokenSend(PANEL_ID, undefined, handler);

      complete("", "item-a", true);

      expect(handler).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      await finish();
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
