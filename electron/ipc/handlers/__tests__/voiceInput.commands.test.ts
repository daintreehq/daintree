import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── IPC mocks ──────────────────────────────────────────────────────────────
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "granted") },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

// ── Shared state container for mocks ───────────────────────────────────────
type MockTranscriptionEvent = {
  type: string;
  sessionId?: string;
  text?: string;
  itemId?: string;
  replace?: boolean;
  status?: string;
  message?: string;
};

const shared = vi.hoisted(() => ({
  transcriptionEventCallback: null as ((e: MockTranscriptionEvent) => void) | null,
  /** Deferred drain promise — resolve externally to control stopGracefully() timing. */
  drainResolve: null as (() => void) | null,
  /** When true, stopGracefully uses a deferred promise instead of resolving immediately. */
  useDeferredDrain: false,
  correctionCalls: [] as Array<{ request: unknown; settings: unknown }>,
  /** Settings objects passed to svc.start(), in call order. */
  startCalls: [] as unknown[],
  /** Optional override for assembleKeyterms — lets a test defer/control timing. */
  assembleKeyterms: null as null | (() => Promise<string[]>),
  /** The session the fake provider was last started for; its events carry it. */
  providerSessionId: null as string | null,
  /** Arguments of each assembleKeyterms call. */
  keytermCalls: [] as Array<{ commandTerms?: Promise<readonly string[]> }>,
  commandTarget: null as unknown,
  resolveCalls: [] as Array<{ terminalId: string | undefined; timeoutMs: number }>,
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: MockTranscriptionEvent) => void) {
      shared.transcriptionEventCallback = (e) =>
        cb({ ...e, sessionId: shared.providerSessionId ?? undefined });
      return () => {};
    };
    this.start = function (settings: unknown, sessionId: string) {
      shared.providerSessionId = sessionId;
      shared.startCalls.push(settings);
      return Promise.resolve({ ok: true });
    };
    this.stopGracefully = function () {
      if (shared.useDeferredDrain) {
        return new Promise<void>((resolve) => {
          shared.drainResolve = resolve;
        });
      }
      return Promise.resolve();
    };
    this.sendAudioChunk = function () {};
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {};
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.correct = function (request: unknown, settings: unknown) {
      shared.correctionCalls.push({ request, settings });
      return Promise.resolve({
        action: "replace",
        correctedText: "hello world",
        confidence: "high",
        confirmedText: "hello world",
      });
    };
    this.detectFileLinkTokens = function () {
      return Promise.resolve([]);
    };
    this.setSessionSignal = function () {};
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getProjectById: vi.fn(() => null),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

vi.mock("../../../services/voiceCommandTarget.js", () => ({
  resolveVoiceCommandTarget: vi.fn(
    async (_pty: unknown, terminalId: string | undefined, timeoutMs: number) => {
      shared.resolveCalls.push({ terminalId, timeoutMs });
      return terminalId ? shared.commandTarget : null;
    }
  ),
}));

vi.mock("../../../services/voiceContextKeyterms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/voiceContextKeyterms.js")>()),
  assembleKeyterms: vi.fn((opts: { commandTerms?: Promise<readonly string[]> }) => {
    shared.keytermCalls.push(opts);
    return shared.assembleKeyterms ? shared.assembleKeyterms() : Promise.resolve([]);
  }),
  formatKeytermPrompt: vi.fn(() => ""),
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => {
      if (key === "voiceInput") {
        return {
          enabled: true,
          openaiApiKey: "sk-test",
          correctionEnabled: true,
          correctionModel: "gpt-6-luna",
          dictionary: [],
          correctionCustomInstructions: "",
          language: "en",
          transcriptionModel: "gpt-live-transcribe",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
        };
      }
      return undefined;
    }),
    set: vi.fn(),
  },
}));

vi.mock("../../channels.js", () => ({
  CHANNELS: {
    VOICE_INPUT_GET_SETTINGS: "voice-input:get-settings",
    VOICE_INPUT_SET_SETTINGS: "voice-input:set-settings",
    VOICE_INPUT_START: "voice-input:start",
    VOICE_INPUT_STOP: "voice-input:stop",
    VOICE_INPUT_AUDIO_CHUNK: "voice-input:audio-chunk",
    VOICE_INPUT_TRANSCRIPTION_DELTA: "voice-input:transcription-delta",
    VOICE_INPUT_TRANSCRIPTION_COMPLETE: "voice-input:transcription-complete",
    VOICE_INPUT_ERROR: "voice-input:error",
    VOICE_INPUT_STATUS: "voice-input:status",
    VOICE_INPUT_CHECK_MIC_PERMISSION: "voice-input:check-mic-permission",
    VOICE_INPUT_REQUEST_MIC_PERMISSION: "voice-input:request-mic-permission",
    VOICE_INPUT_OPEN_MIC_SETTINGS: "voice-input:open-mic-settings",
    VOICE_INPUT_VALIDATE_API_KEY: "voice-input:validate-api-key",
    VOICE_INPUT_CORRECT: "voice-input:correct",
    VOICE_INPUT_FLUSH_PARAGRAPH: "voice-input:flush-paragraph",
    VOICE_INPUT_PARAGRAPH_BOUNDARY: "voice-input:paragraph-boundary",
    VOICE_INPUT_FILE_TOKEN_RESOLVED: "voice-input:file-token-resolved",
    VOICE_INPUT_SESSION_ENDED: "voice-input:session-ended",
  },
}));

// ── Module import (once) ───────────────────────────────────────────────────
import { registerVoiceInputHandlers } from "../voiceInput.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";
import { getBuiltinSlashCommands } from "../../../../shared/types/slashCommands.js";
import { buildVoiceCommandVocabulary } from "../../../../shared/utils/voiceAgentCommands.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type SentMessage = { channel: string; payload: unknown };

// Events go to the view that started the session, so the fake view records into
// whichever window's log the test is currently reading.
let activeSent: SentMessage[] = [];

function buildMainWindow(): {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: ReturnType<typeof vi.fn>;
  __sent: SentMessage[];
} {
  const sentMessages: SentMessage[] = [];
  activeSent = sentMessages;
  return {
    webContents: {
      send: vi.fn((channel: string, payload: unknown) => {
        sentMessages.push({ channel, payload });
      }),
    },
    isDestroyed: vi.fn(() => false),
    __sent: sentMessages,
  };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => unknown;
}

const fakeEvent = {
  sender: {
    id: 1,
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: unknown) => {
      activeSent.push({ channel, payload });
    }),
  },
} as unknown as Electron.IpcMainInvokeEvent;

// Each start mints a fresh session id, as the renderer does; stops and the
// payload expectations use the latest one.
let nextSessionNumber = 1;
let currentSessionId = "";
function nextSessionId(): string {
  currentSessionId = `session-${nextSessionNumber++}`;
  return currentSessionId;
}

function emitTranscriptionEvent(event: MockTranscriptionEvent) {
  if (!shared.transcriptionEventCallback) {
    throw new Error("No transcription event callback registered — was handleStart called?");
  }
  shared.transcriptionEventCallback(event);
}

// ── Tests ──────────────────────────────────────────────────────────────────

const TERMINAL = "terminal-1";

function claudeTarget() {
  return {
    agentId: "claude",
    agentName: "Claude",
    isAssistant: false,
    vocabulary: buildVoiceCommandVocabulary(
      getBuiltinSlashCommands("claude"),
      getAgentConfig("claude")!.completionSources!
    ),
  };
}

type StartHandler = (e: unknown, sessionId: string, options?: unknown) => Promise<unknown>;

function completions() {
  return activeSent
    .filter((m) => m.channel === "voice-input:transcription-complete")
    .map((m) => m.payload as { text: string; commandText?: string });
}

describe("voiceInput — the target agent's commands", () => {
  let cleanup: () => void;

  async function start(terminalId: string | undefined = TERMINAL) {
    const handleStart = getHandler("voice-input:start") as StartHandler;
    await handleStart(fakeEvent, nextSessionId(), terminalId ? { terminalId } : undefined);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.correctionCalls = [];
    shared.keytermCalls = [];
    shared.resolveCalls = [];
    shared.commandTarget = claudeTarget();

    const win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
      ptyClient: {
        hasTerminal: (id: string) => id === TERMINAL,
        getTerminalProjectId: () => null,
      },
    } as unknown as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("writes a spoken opening command as typed, for the renderer to use at the prompt's start", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Slash review the last commit." });
    expect(completions()).toEqual([
      expect.objectContaining({
        text: "Slash review the last commit.",
        commandText: "/review the last commit.",
      }),
    ]);
  });

  it("leaves 'slash' and anything the agent hasn't got as words", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Slash the budget in half." });
    expect(completions()[0]).not.toHaveProperty("commandText");
  });

  it("never opens a command in a later piece of the utterance", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "hello\n\nslash compact" });
    const sent = completions();
    expect(sent.map((p) => p.text)).toEqual(["hello", "slash compact"]);
    expect(sent.every((p) => p.commandText === undefined)).toBe(true);
  });

  it("writes nothing as a command for a terminal running no agent", async () => {
    shared.commandTarget = null;
    await start();
    emitTranscriptionEvent({ type: "complete", text: "slash compact" });
    expect(completions()[0]).not.toHaveProperty("commandText");
  });

  it("biases recognition toward the agent's command names", async () => {
    await start();
    const terms = (await shared.keytermCalls[0]!.commandTerms) ?? [];
    const names = new Set(claudeTarget().vocabulary.entries.map((entry) => entry.spokenName));
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.length).toBeLessThan(names.size);
    expect(terms.every((term) => names.has(term))).toBe(true);
  });

  it("hands correction the target and where the passage sits", async () => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    await handleCorrect(fakeEvent, {
      rawText: "compact the conversation",
      terminalId: TERMINAL,
      startsPrompt: true,
    });
    expect(shared.correctionCalls[0]?.request).toMatchObject({ startsPrompt: true });
    expect(shared.correctionCalls[0]?.settings).toMatchObject({
      commandTarget: { agentId: "claude", isAssistant: false },
    });
  });

  it("corrects as prose when the passage names no terminal", async () => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    await handleCorrect(fakeEvent, { rawText: "compact the conversation" });
    expect(shared.correctionCalls[0]?.request).toMatchObject({ startsPrompt: false });
    expect(shared.correctionCalls[0]?.settings).not.toHaveProperty("commandTarget");
  });
});
