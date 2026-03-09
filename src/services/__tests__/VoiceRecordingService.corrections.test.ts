/**
 * Tests for the correction matching pipeline in VoiceRecordingService.
 * Focuses on ID-based lookup, skip policy for edited text, and offset rebasing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Store mock ─────────────────────────────────────────────────────────────
// Track calls to store actions so we can assert behavior without running Zustand.

const mockVoiceState = vi.hoisted(() => ({
  activeTarget: null as { panelId: string; projectId?: string } | null,
  panelBuffers: {} as Record<
    string,
    {
      projectId?: string;
      pendingCorrections: Array<{ id: string; segmentStart: number; rawText: string }>;
      activeParagraphStart: number;
    }
  >,
  correctionEnabled: true,
}));

const mockVoiceFns = vi.hoisted(() => ({
  addPendingCorrection: vi.fn(),
  resolvePendingCorrection: vi.fn(),
  rebasePendingCorrections: vi.fn(),
  setError: vi.fn(),
  announce: vi.fn(),
  setStatus: vi.fn(),
  setConfigured: vi.fn(),
  setCorrectionEnabled: vi.fn(),
  beginSession: vi.fn(),
  finishSession: vi.fn(),
  setAudioLevel: vi.fn(),
  setElapsedSeconds: vi.fn(),
  appendDelta: vi.fn(),
  completeSegment: vi.fn(),
  setDraftLengthAtSegmentStart: vi.fn(),
  setActiveParagraphStart: vi.fn(),
  resetParagraphState: vi.fn(),
}));

vi.mock("@/store/voiceRecordingStore", () => {
  const getState = () => ({ ...mockVoiceState, ...mockVoiceFns });
  const subscribe = vi.fn(() => () => {});
  return {
    useVoiceRecordingStore: Object.assign(getState, { getState, subscribe }),
  };
});

// ── Terminal input store mock ──────────────────────────────────────────────
const mockDraftStore = vi.hoisted(() => ({
  drafts: {} as Record<string, string>,
}));

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn((panelId: string) => mockDraftStore.drafts[panelId] ?? ""),
    setDraftInput: vi.fn((panelId: string, value: string) => {
      mockDraftStore.drafts[panelId] = value;
    }),
    appendVoiceText: vi.fn(),
    bumpVoiceDraftRevision: vi.fn(),
  };
  const getState = () => fns;
  return { useTerminalInputStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/terminalStore", () => {
  const state = { terminals: [] as unknown[], focusedId: null };
  const getState = () => state;
  const subscribe = vi.fn(() => () => {});
  return { useTerminalStore: Object.assign(getState, { getState, subscribe }) };
});

vi.mock("@/store/projectStore", () => {
  const state = { currentProject: null, isSwitching: false };
  const getState = () => ({ ...state, switchProject: vi.fn() });
  return { useProjectStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/worktreeDataStore", () => {
  const getState = () => ({ worktrees: new Map() });
  return { useWorktreeDataStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/worktreeStore", () => {
  const getState = () => ({ activeWorktreeId: null, selectWorktree: vi.fn() });
  return { useWorktreeSelectionStore: Object.assign(getState, { getState }) };
});

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  VOICE_INPUT_SETTINGS_CHANGED_EVENT: "voice-input-settings-changed",
}));

// ── Helpers ────────────────────────────────────────────────────────────────

type CorrectionReplaceCallback = (payload: { correctionId: string; correctedText: string }) => void;

type ParagraphBoundaryCallback = (payload: {
  rawText: string | null;
  correctionId: string | null;
}) => void;

function buildElectronStub() {
  let correctionReplaceCallback: CorrectionReplaceCallback | null = null;
  let paragraphBoundaryCallback: ParagraphBoundaryCallback | null = null;

  const voiceInput = {
    onTranscriptionDelta: vi.fn(() => () => {}),
    onTranscriptionComplete: vi.fn(() => () => {}),
    onCorrectionReplace: vi.fn((cb: CorrectionReplaceCallback) => {
      correctionReplaceCallback = cb;
      return () => {};
    }),
    onParagraphBoundary: vi.fn((cb: ParagraphBoundaryCallback) => {
      paragraphBoundaryCallback = cb;
      return () => {};
    }),
    onError: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    getSettings: vi.fn().mockResolvedValue({
      enabled: true,
      deepgramApiKey: "dg-key",
      correctionApiKey: "sk-key",
      correctionEnabled: true,
    }),
    checkMicPermission: vi.fn().mockResolvedValue("granted"),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    openMicSettings: vi.fn(),
    sendAudioChunk: vi.fn(),
    start: vi.fn().mockResolvedValue({ ok: true }),
    stop: vi.fn().mockResolvedValue({ rawText: null, correctionId: null }),
  };

  return {
    voiceInput,
    emit: {
      correctionReplace: (payload: { correctionId: string; correctedText: string }) => {
        correctionReplaceCallback!(payload);
      },
      paragraphBoundary: (payload: { rawText: string | null; correctionId: string | null }) => {
        paragraphBoundaryCallback!(payload);
      },
    },
  };
}

function setupGlobals(electronStub: ReturnType<typeof buildElectronStub>) {
  vi.stubGlobal("window", {
    electron: electronStub.voiceInput
      ? {
          voiceInput: electronStub.voiceInput,
          systemSleep: { onSuspend: vi.fn(() => () => {}), onWake: vi.fn(() => () => {}) },
        }
      : undefined,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });

  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }], getAudioTracks: () => [{}] }),
    },
  });

  vi.stubGlobal("AudioContext", function () {
    return {
      state: "running",
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      })),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    };
  });

  vi.stubGlobal("AudioWorkletNode", function () {
    return { port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("VoiceRecordingService — correction matching (stable ID)", () => {
  let electron: ReturnType<typeof buildElectronStub>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset shared state
    mockVoiceState.activeTarget = null;
    mockVoiceState.panelBuffers = {};
    mockVoiceState.correctionEnabled = true;
    mockDraftStore.drafts = {};

    electron = buildElectronStub();
    setupGlobals(electron);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("onCorrectionReplace looks up pending entry by correctionId, not rawText", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.activeTarget = { panelId: PANEL };
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [{ id: "uuid-abc", segmentStart: 0, rawText: "hello world" }],
      activeParagraphStart: 0,
    };
    mockDraftStore.drafts[PANEL] = "hello world";

    voiceRecordingService.initialize();

    electron.emit.correctionReplace({ correctionId: "uuid-abc", correctedText: "Hello, world!" });

    const inputStore = (
      await import("@/store/terminalInputStore")
    ).useTerminalInputStore.getState();
    expect(inputStore.setDraftInput).toHaveBeenCalledWith(PANEL, "Hello, world!", undefined);
    expect(mockVoiceFns.resolvePendingCorrection).toHaveBeenCalledWith(PANEL, "uuid-abc");
  });

  it("onCorrectionReplace with unknown correctionId does nothing", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    mockVoiceState.panelBuffers["panel-1"] = {
      pendingCorrections: [{ id: "uuid-known", segmentStart: 0, rawText: "some text" }],
      activeParagraphStart: 0,
    };

    voiceRecordingService.initialize();

    electron.emit.correctionReplace({ correctionId: "uuid-unknown", correctedText: "corrected" });

    expect(mockVoiceFns.resolvePendingCorrection).not.toHaveBeenCalled();
  });

  it("duplicate rawText is resolved independently by correctionId", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [
        { id: "uuid-first", segmentStart: 0, rawText: "start the server" },
        { id: "uuid-second", segmentStart: 20, rawText: "start the server" },
      ],
      activeParagraphStart: 0,
    };
    // Draft has duplicate text: "start the server\nstart the server"
    mockDraftStore.drafts[PANEL] = "start the server\nstart the server";

    voiceRecordingService.initialize();

    // First correction arrives for "uuid-first" at position 0
    electron.emit.correctionReplace({
      correctionId: "uuid-first",
      correctedText: "Start the server",
    });

    expect(mockVoiceFns.resolvePendingCorrection).toHaveBeenCalledWith(PANEL, "uuid-first");
    expect(mockVoiceFns.resolvePendingCorrection).not.toHaveBeenCalledWith(PANEL, "uuid-second");
  });

  it("skips applying correction when text at segmentStart has been edited", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [{ id: "uuid-abc", segmentStart: 0, rawText: "original text" }],
      activeParagraphStart: 0,
    };
    // User has edited the draft — "original text" is no longer at position 0
    mockDraftStore.drafts[PANEL] = "completely different content";

    voiceRecordingService.initialize();

    electron.emit.correctionReplace({ correctionId: "uuid-abc", correctedText: "Original Text" });

    const inputStore = (
      await import("@/store/terminalInputStore")
    ).useTerminalInputStore.getState();
    // setDraftInput should NOT be called because the text at segmentStart doesn't match
    expect(inputStore.setDraftInput).not.toHaveBeenCalled();
    // But the pending entry is still resolved so UI resets
    expect(mockVoiceFns.resolvePendingCorrection).toHaveBeenCalledWith(PANEL, "uuid-abc");
  });

  it("skips draft update when correctedText equals rawText (no change)", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [{ id: "uuid-abc", segmentStart: 0, rawText: "unchanged text" }],
      activeParagraphStart: 0,
    };
    mockDraftStore.drafts[PANEL] = "unchanged text";

    voiceRecordingService.initialize();

    electron.emit.correctionReplace({ correctionId: "uuid-abc", correctedText: "unchanged text" });

    const inputStore = (
      await import("@/store/terminalInputStore")
    ).useTerminalInputStore.getState();
    expect(inputStore.setDraftInput).not.toHaveBeenCalled();
    expect(mockVoiceFns.resolvePendingCorrection).toHaveBeenCalledWith(PANEL, "uuid-abc");
  });

  it("rebases later pending corrections when length changes after applying a correction", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [
        { id: "uuid-first", segmentStart: 0, rawText: "hello" },
        { id: "uuid-second", segmentStart: 10, rawText: "world" },
      ],
      activeParagraphStart: 0,
    };
    mockDraftStore.drafts[PANEL] = "hello\nworld";

    voiceRecordingService.initialize();

    // "hello" (5 chars) → "Hello there" (11 chars) → delta = +6
    electron.emit.correctionReplace({ correctionId: "uuid-first", correctedText: "Hello there" });

    const inputStore = (
      await import("@/store/terminalInputStore")
    ).useTerminalInputStore.getState();
    expect(inputStore.setDraftInput).toHaveBeenCalledWith(PANEL, "Hello there\nworld", undefined);
    expect(mockVoiceFns.rebasePendingCorrections).toHaveBeenCalledWith(PANEL, 0, 6);
    expect(mockVoiceFns.resolvePendingCorrection).toHaveBeenCalledWith(PANEL, "uuid-first");
  });

  it("does not call rebasePendingCorrections when length delta is zero", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [{ id: "uuid-abc", segmentStart: 0, rawText: "hello" }],
      activeParagraphStart: 0,
    };
    mockDraftStore.drafts[PANEL] = "hello";

    voiceRecordingService.initialize();

    // "hello" → "Hello" — same length, delta = 0
    electron.emit.correctionReplace({ correctionId: "uuid-abc", correctedText: "Hello" });

    expect(mockVoiceFns.rebasePendingCorrections).not.toHaveBeenCalled();
  });

  it("onParagraphBoundary registers pending correction using correctionId from main process", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.activeTarget = { panelId: PANEL };
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [],
      activeParagraphStart: 5,
    };

    voiceRecordingService.initialize();

    electron.emit.paragraphBoundary({
      rawText: "dictated text",
      correctionId: "uuid-para-1",
    });

    expect(mockVoiceFns.addPendingCorrection).toHaveBeenCalledWith(
      PANEL,
      "uuid-para-1",
      5,
      "dictated text"
    );
  });

  it("onParagraphBoundary does not register pending correction when correctionId is null", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    mockVoiceState.activeTarget = { panelId: PANEL };
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [],
      activeParagraphStart: 5,
    };

    voiceRecordingService.initialize();

    // correctionId null → correction was not queued (e.g., correction disabled)
    electron.emit.paragraphBoundary({ rawText: "some text", correctionId: null });

    expect(mockVoiceFns.addPendingCorrection).not.toHaveBeenCalled();
  });

  it("correction resolves correctly on a non-active panel (post-session scan)", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    // activeTarget is null — session has ended, but the panel buffer still exists
    // with a pending correction that was registered before the session finished.
    mockVoiceState.activeTarget = null;
    mockVoiceState.panelBuffers[PANEL] = {
      projectId: "proj-1",
      pendingCorrections: [{ id: "uuid-late", segmentStart: 0, rawText: "late text" }],
      activeParagraphStart: -1,
    };
    mockDraftStore.drafts[PANEL] = "late text";

    voiceRecordingService.initialize();

    electron.emit.correctionReplace({ correctionId: "uuid-late", correctedText: "Late Text" });

    const inputStore = (
      await import("@/store/terminalInputStore")
    ).useTerminalInputStore.getState();
    expect(inputStore.setDraftInput).toHaveBeenCalledWith(PANEL, "Late Text", "proj-1");
    expect(mockVoiceFns.resolvePendingCorrection).toHaveBeenCalledWith(PANEL, "uuid-late");
  });

  it("applies correction when rawText ends exactly at the end of the draft", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    const PANEL = "panel-1";
    // segmentStart=6, rawText="world" — ends at draft.length (11)
    mockVoiceState.panelBuffers[PANEL] = {
      pendingCorrections: [{ id: "uuid-abc", segmentStart: 6, rawText: "world" }],
      activeParagraphStart: 0,
    };
    mockDraftStore.drafts[PANEL] = "hello world";

    voiceRecordingService.initialize();

    electron.emit.correctionReplace({ correctionId: "uuid-abc", correctedText: "World" });

    const inputStore = (
      await import("@/store/terminalInputStore")
    ).useTerminalInputStore.getState();
    expect(inputStore.setDraftInput).toHaveBeenCalledWith(PANEL, "hello World", undefined);
    expect(mockVoiceFns.resolvePendingCorrection).toHaveBeenCalledWith(PANEL, "uuid-abc");
  });
});
