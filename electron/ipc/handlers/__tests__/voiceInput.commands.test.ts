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

// The live-session report goes to every app view; these tests have none.
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getAllAppWebContents: vi.fn(() => []),
}));

// ── Shared state container for mocks ───────────────────────────────────────
type MockTranscriptionEvent = {
  type: string;
  sessionId?: string;
  text?: string;
  itemId?: string;
  replace?: boolean;
  endOfSpeech?: boolean;
  endsAtPause?: boolean;
  paused?: boolean;
  incomplete?: boolean;
  status?: string;
  message?: string;
  uncertain?: Array<{ from: number; to: number }>;
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
  /** The start context (pending keyterms) passed alongside each start. */
  startContexts: [] as Array<{ keyterms?: Promise<string[]> } | undefined>,
  /** Optional override for assembleTaggedKeyterms — lets a test defer/control timing. */
  assembleKeyterms: null as null | (() => Promise<string[]>),
  /** The session the fake provider was last started for; its events carry it. */
  providerSessionId: null as string | null,
  /** Arguments of each assembleTaggedKeyterms call. */
  keytermCalls: [] as Array<{ commandTerms?: Promise<readonly string[]> }>,
  commandTarget: null as unknown,
  /** The transcription provider the stored settings name. */
  provider: "openai" as "openai" | "deepgram",
  resolveCalls: [] as Array<{ terminalId: string | undefined; timeoutMs: number }>,
  /** The stored dictionary, heard-as rules included. */
  dictionary: [] as unknown[],
  /** Settings each prompt warm-up was asked to send. */
  warmCalls: [] as unknown[],
  /** The agent the terminal runs when correction looks again. */
  liveAgent: "claude" as string | null | undefined,
  /** What the fake correction says about its request. */
  roundTrip: undefined as { sentAt: number; ms: number } | undefined,
  phases: undefined as { untilOutputMs: number; outputMs: number; effort: string } | undefined,
  preconnects: 0,
  /** Stored settings laid over the defaults below. */
  settingsOverride: {} as Record<string, unknown>,
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: MockTranscriptionEvent) => void) {
      shared.transcriptionEventCallback = (e) =>
        cb({ ...e, sessionId: shared.providerSessionId ?? undefined });
      return () => {};
    };
    this.keytermsNeededToConnect = function (settings: { transcriptionProvider?: string }) {
      return settings.transcriptionProvider === "deepgram";
    };
    this.start = function (
      settings: unknown,
      sessionId: string,
      context?: { keyterms?: Promise<string[]> }
    ) {
      shared.providerSessionId = sessionId;
      shared.startCalls.push(settings);
      shared.startContexts.push(context);
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
    this.stop = function () {};
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {};
    this.getSessionStats = () => null;
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
        ...(shared.roundTrip ? { roundTrip: shared.roundTrip } : {}),
        ...(shared.phases ? { phases: shared.phases } : {}),
      });
    };
    this.detectFileLinkTokens = function () {
      return Promise.resolve([]);
    };
    this.warm = function (settings: unknown) {
      shared.warmCalls.push(settings);
      return Promise.resolve();
    };
    this.preconnect = function () {
      shared.preconnects++;
    };
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
  readVoiceCommandAgent: vi.fn(async (_pty: unknown, terminalId: string | undefined) =>
    terminalId ? shared.liveAgent : null
  ),
}));

vi.mock("../../../services/voiceContextKeyterms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/voiceContextKeyterms.js")>()),
  assembleTaggedKeyterms: vi.fn(async (opts: { commandTerms?: Promise<readonly string[]> }) => {
    shared.keytermCalls.push(opts);
    return ((await shared.assembleKeyterms?.()) ?? []).map((term) => ({
      term,
      source: "commands",
    }));
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
          correctionModel: "gpt-6.1-terra",
          dictionary: shared.dictionary,
          correctionCustomInstructions: "",
          language: "en",
          transcriptionModel: "gpt-live-transcribe",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
          ...(shared.provider === "deepgram"
            ? { transcriptionProvider: "deepgram", deepgramApiKey: "dg-test" }
            : {}),
          ...shared.settingsOverride,
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
import { resolveVoiceCommandTarget } from "../../../services/voiceCommandTarget.js";

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
    .map(
      (m) =>
        m.payload as {
          text: string;
          heard?: string;
          commandText?: string;
          send?: boolean;
          uncertain?: Span[];
          heardUncertain?: Span[];
          commandUncertain?: Span[];
          itemId?: string;
          pauses?: number[];
          heardPauses?: number[];
          commandPauses?: number[];
        }
    );
}

type Span = { from: number; to: number };

/** The words each span covers, so a flag on the wrong copy of a word shows. */
function flagged(text: string | undefined, spans: Span[] | undefined): string[] {
  return (spans ?? []).map(({ from, to }) => `${from}:${(text ?? "").slice(from, to)}`);
}

/** Spans of the given words in `text`, each found after the last. */
function spansOf(text: string, ...words: string[]): Span[] {
  let at = 0;
  return words.map((word) => {
    const from = text.indexOf(word, at);
    at = from + word.length;
    return { from, to: at };
  });
}

describe("voiceInput — the target agent's commands", () => {
  let cleanup: () => void;

  async function start(terminalId: string | undefined = TERMINAL, intent?: "rewrite") {
    const handleStart = getHandler("voice-input:start") as StartHandler;
    await handleStart(
      fakeEvent,
      nextSessionId(),
      terminalId ? { terminalId, ...(intent ? { intent } : {}) } : undefined
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.correctionCalls = [];
    shared.keytermCalls = [];
    shared.resolveCalls = [];
    shared.startCalls = [];
    shared.startContexts = [];
    shared.assembleKeyterms = null;
    shared.provider = "openai";
    shared.commandTarget = claudeTarget();
    shared.dictionary = [];
    shared.warmCalls = [];
    shared.preconnects = 0;
    shared.settingsOverride = {};
    shared.liveAgent = "claude";
    shared.roundTrip = undefined;
    shared.phases = undefined;

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

  it.each(["openai", "deepgram"] as const)(
    "writes a command whose name follows a pause after 'slash' on %s",
    async (provider) => {
      shared.provider = provider;
      await start();
      emitTranscriptionEvent({ type: "complete", text: "Slash.", itemId: "A", endOfSpeech: true });
      emitTranscriptionEvent({
        type: "complete",
        text: "compact.",
        itemId: "B",
        endOfSpeech: true,
      });
      const sent = completions() as Array<{ text: string; commandText?: string; itemId?: string }>;
      expect(sent.filter((p) => p.commandText)).toEqual([
        expect.objectContaining({ commandText: "/compact" }),
      ]);
      expect(sent.map((p) => ({ itemId: p.itemId, text: p.text }))).toEqual([
        { itemId: "B", text: "" },
        { itemId: "A", text: "Slash. compact." },
      ]);
    }
  );

  // An interim the provider settled for a lost transcript is no command.
  it("writes an incomplete segment's words as said, never as a command", async () => {
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "Slash compact, send it",
      itemId: "A",
      incomplete: true,
    });
    emitTranscriptionEvent({ type: "complete", text: "", endOfSpeech: true });
    const sent = completions() as Array<{ text: string; itemId?: string }>;
    expect(sent).toEqual([
      expect.objectContaining({ text: "Slash compact, send it", itemId: "A" }),
    ]);
    expect(sent[0]).not.toHaveProperty("commandText");
    expect(sent[0]).not.toHaveProperty("send");
  });

  it("lets a pause after 'slash' go as words when no command name follows", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Slash.", itemId: "A", endOfSpeech: true });
    emitTranscriptionEvent({
      type: "complete",
      text: "the budget in half.",
      itemId: "B",
      endOfSpeech: true,
    });
    const sent = completions();
    expect(sent.map((p) => p.text).filter(Boolean)).toEqual(["Slash.", "the budget in half."]);
    expect(sent.every((p) => p.commandText === undefined)).toBe(true);
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

  // The send comes off first, so it never reads as the command's argument.
  it("still sends a dictated '/compact send it', with the command written as typed", async () => {
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "Slash compact, send it.",
      itemId: "item-A",
      endOfSpeech: true,
    });
    expect(completions()).toEqual([
      expect.objectContaining({ text: "Slash compact", commandText: "/compact", send: true }),
    ]);
  });

  // Commands are read from the words as heard, so a heard-as rule that takes
  // the command's name can't hide it.
  it("recognises a command from the words as heard, before the heard-as rules", async () => {
    shared.dictionary = [{ term: "Revue", heardAs: ["review"], source: "manual", addedAt: 1 }];
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Slash review the last commit." });
    expect(completions()).toEqual([
      expect.objectContaining({
        text: "Slash Revue the last commit.",
        heard: "Slash review the last commit.",
        commandText: "/review the last commit.",
      }),
    ]);
  });

  it("keeps a rewrite instruction's opening command as words", async () => {
    await start(TERMINAL, "rewrite");
    emitTranscriptionEvent({ type: "complete", text: "Slash compact the wording." });
    expect(completions()).toEqual([
      expect.objectContaining({ text: "Slash compact the wording." }),
    ]);
    expect(completions()[0]).not.toHaveProperty("commandText");
  });

  it("writes nothing as a command for a terminal running no agent", async () => {
    shared.commandTarget = null;
    await start();
    emitTranscriptionEvent({ type: "complete", text: "slash compact" });
    expect(completions()[0]).not.toHaveProperty("commandText");
  });

  // Assembly waits on the command terms, as the real one does.
  function assembleFromCommandTerms() {
    shared.assembleKeyterms = () =>
      (shared.keytermCalls.at(-1)?.commandTerms ?? Promise.resolve([])).then((t) => [...t]);
  }

  function holdCommandLookup(): (target: unknown) => void {
    let release!: (target: unknown) => void;
    vi.mocked(resolveVoiceCommandTarget).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve as (target: unknown) => void;
        })
    );
    return (target) => release(target);
  }

  it("connects OpenAI without waiting on the command lookup, and has the target once its keyterms land", async () => {
    assembleFromCommandTerms();
    const release = holdCommandLookup();
    await start();
    // Started with its keyterms still pending behind the lookup.
    expect(shared.startCalls).toHaveLength(1);
    expect(shared.startCalls[0]).not.toHaveProperty("keyterms");
    const pending = shared.startContexts[0]?.keyterms;
    expect(pending).toBeInstanceOf(Promise);

    release(claudeTarget());
    await expect(pending).resolves.not.toHaveLength(0);
    // OpenAI transcribes nothing before its keyterms land.
    emitTranscriptionEvent({ type: "complete", text: "Slash review the last commit." });
    expect(completions()[0]).toMatchObject({ commandText: "/review the last commit." });
  });

  it("has the target in place when Deepgram starts with its keyterms", async () => {
    shared.provider = "deepgram";
    assembleFromCommandTerms();
    await start();
    expect(shared.startCalls).toHaveLength(1);
    const { keyterms } = shared.startCalls[0] as { keyterms: string[] };
    expect(keyterms.length).toBeGreaterThan(0);
    emitTranscriptionEvent({ type: "complete", text: "Slash review the last commit." });
    expect(completions()[0]).toMatchObject({ commandText: "/review the last commit." });
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

  it("hands correction what the command the draft opens with says about itself, when the target lists it", async () => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    const compact = claudeTarget().vocabulary.entries.find((entry) => entry.token === "/compact")!;
    await handleCorrect(fakeEvent, {
      rawText: "keep the migration notes",
      terminalId: TERMINAL,
      startsPrompt: false,
      openingCommandToken: "/compact",
    });
    await handleCorrect(fakeEvent, {
      rawText: "keep the migration notes",
      terminalId: TERMINAL,
      startsPrompt: false,
      openingCommandToken: "/not-listed",
    });
    shared.commandTarget = null;
    await handleCorrect(fakeEvent, {
      rawText: "keep the migration notes",
      terminalId: TERMINAL,
      startsPrompt: false,
      openingCommandToken: "/compact",
    });

    const [listed, unlisted, noTarget] = shared.correctionCalls.map(
      (call) => call.request as Record<string, unknown>
    );
    expect(listed!.openingCommand).toEqual({
      token: "/compact",
      description: compact.description,
    });
    // The token only names what to look up; the request carries no path or token of its own.
    expect(listed).not.toHaveProperty("openingCommandToken");
    expect(unlisted).not.toHaveProperty("openingCommand");
    expect(noTarget).not.toHaveProperty("openingCommand");
  });

  it("carries the unsure words by position through a stripped send, heard-as rules and pieces", async () => {
    shared.dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }];
    await start();
    const text = "use zoo stand for the store\nthen test the test, send it.";
    emitTranscriptionEvent({
      type: "complete",
      text,
      endOfSpeech: true,
      // "stand" sits in a phrase a rule rewrites, "it" in the send, and only
      // the second "test" is unsure.
      uncertain: [
        { from: 8, to: 13 },
        { from: 22, to: 27 },
        { from: 42, to: 46 },
        { from: 53, to: 55 },
      ],
    });
    const [first, second] = completions();
    expect(first?.text).toBe("use Zustand for the store");
    expect(flagged(first?.text, first?.uncertain)).toEqual(["20:store"]);
    expect(flagged(first?.heard, first?.heardUncertain)).toEqual(["8:stand", "22:store"]);
    expect(second).toMatchObject({ text: "then test the test", send: true });
    expect(flagged(second?.text, second?.uncertain)).toEqual(["14:test"]);
    expect(second).not.toHaveProperty("heardUncertain");
  });

  it("moves an opening command's unsure arguments into the command as typed, and drops its name's", async () => {
    await start();
    const text = "Slash review the last commit.";
    emitTranscriptionEvent({
      type: "complete",
      text,
      uncertain: spansOf(text, "review", "the", "last"),
    });
    const [sent] = completions();
    expect(sent?.commandText).toBe("/review the last commit.");
    expect(flagged(sent?.text, sent?.uncertain)).toEqual(["6:review", "13:the", "17:last"]);
    expect(flagged(sent?.commandText, sent?.commandUncertain)).toEqual(["8:the", "12:last"]);
  });

  it("restores the flags a held send stripped when the speaker goes on", async () => {
    shared.provider = "deepgram";
    await start();
    const text = "fix the test send it";
    emitTranscriptionEvent({
      type: "complete",
      text,
      endOfSpeech: true,
      itemId: "item-A",
      uncertain: spansOf(text, "test", "it"),
    });
    expect(completions()).toEqual([]);
    emitTranscriptionEvent({ type: "delta", text: "and", itemId: "item-B" });
    const [sent] = completions();
    expect(sent?.text).toBe(text);
    expect(flagged(sent?.text, sent?.uncertain)).toEqual(["8:test", "18:it"]);
  });

  it("sends no unsure words for an utterance with none", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Slash review the last commit." });
    const [sent] = completions();
    expect(sent).not.toHaveProperty("uncertain");
    expect(sent).not.toHaveProperty("commandUncertain");
  });

  it("hands correction the unsure words the renderer sent", async () => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    await handleCorrect(fakeEvent, {
      rawText: "racked native",
      terminalId: TERMINAL,
      uncertain: [{ from: 0, to: 6 }],
    });
    await handleCorrect(fakeEvent, { rawText: "react native", terminalId: TERMINAL });
    expect(shared.correctionCalls[0]?.request).toMatchObject({ uncertain: [{ from: 0, to: 6 }] });
    expect(shared.correctionCalls[1]?.request).not.toHaveProperty("uncertain");
  });

  // A passage past cleanup's length cap is left raw by the service; its
  // spans must not turn that into a failed request.
  it.each([
    [
      "more spans than any passage cleanup takes",
      "a ".repeat(12_001).trim(),
      Array.from({ length: 12_001 }, (_, i) => ({ from: 2 * i, to: 2 * i + 1 })),
    ],
    ["a span that doesn't validate", "racked native", [{ from: -1, to: 6 }]],
  ])("still runs correction, without the spans, for %s", async (_name, rawText, uncertain) => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    await handleCorrect(fakeEvent, { rawText, terminalId: TERMINAL, uncertain });
    expect(shared.correctionCalls).toHaveLength(1);
    expect(shared.correctionCalls[0]?.request).toMatchObject({ rawText });
    expect(shared.correctionCalls[0]?.request).not.toHaveProperty("uncertain");
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

  // Where the speaker paused (#14897), by position in each string sent.
  it("carries the pauses through heard-as rules, a stripped break and a stripped send", async () => {
    shared.dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }];
    await start();
    // A short pause inside speech: no command boundary, but a pause all the same.
    emitTranscriptionEvent({ type: "complete", text: "use zoo stand", itemId: "A", paused: true });
    emitTranscriptionEvent({
      type: "complete",
      text: "for the store new line.",
      itemId: "B",
      endsAtPause: true,
      paused: true,
    });
    emitTranscriptionEvent({ type: "complete", text: "then test it", itemId: "C" });
    emitTranscriptionEvent({
      type: "complete",
      text: "send it.",
      itemId: "D",
      endOfSpeech: true,
      paused: true,
    });
    const sent = completions().map(({ text, heard, pauses, heardPauses, send }) => ({
      text,
      ...(heard !== undefined ? { heard, heardPauses } : {}),
      pauses: pauses ?? [],
      ...(send ? { send } : {}),
    }));
    expect(sent).toEqual([
      { text: "use Zustand", heard: "use zoo stand", heardPauses: [13], pauses: [11] },
      { text: "for the store", pauses: [13] },
      { text: "then test it", pauses: [] },
      // The send's own item is left with no words; the pause after it ends the words before.
      { text: "", pauses: [0], send: true },
    ]);
  });

  it("sends a pause with no words of its own as a marker after the words already sent", async () => {
    shared.provider = "deepgram";
    await start();
    emitTranscriptionEvent({ type: "complete", text: "fix the bug", itemId: "A" });
    emitTranscriptionEvent({ type: "complete", text: "", endOfSpeech: true, paused: true });
    emitTranscriptionEvent({ type: "complete", text: "", endOfSpeech: true, paused: true });
    expect(completions()).toEqual([
      expect.objectContaining({ text: "fix the bug", itemId: "A" }),
      { sessionId: currentSessionId, text: "", willCorrect: false, pauses: [0] },
    ]);
  });

  it("rides a pause after words already sent on the completion that retires a break's item", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "fix the bug", itemId: "A" });
    emitTranscriptionEvent({
      type: "complete",
      text: "new line.",
      itemId: "B",
      endsAtPause: true,
      paused: true,
    });
    expect(completions()).toEqual([
      expect.objectContaining({ text: "fix the bug", itemId: "A" }),
      { sessionId: currentSessionId, text: "", willCorrect: false, itemId: "B", pauses: [0] },
    ]);
    expect(completions()[0]).not.toHaveProperty("pauses");
  });

  it("puts a pause in an opening command's name at the end of the command as typed", async () => {
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "Slash.",
      itemId: "A",
      endOfSpeech: true,
      paused: true,
    });
    emitTranscriptionEvent({
      type: "complete",
      text: "review the parser.",
      itemId: "B",
      endOfSpeech: true,
      paused: true,
    });
    const command = completions().find((p) => p.commandText);
    expect(command).toMatchObject({
      text: "Slash. review the parser.",
      pauses: [6, 25],
      commandText: "/review the parser.",
      commandPauses: [7, 19],
    });
  });

  it("marks no pause on an incomplete segment's words", async () => {
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "fix the bug",
      itemId: "A",
      incomplete: true,
      paused: true,
    });
    expect(completions()[0]).not.toHaveProperty("pauses");
  });

  it("hands correction the pauses the renderer sent, and drops ones that don't validate", async () => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    await handleCorrect(fakeEvent, {
      rawText: "fix it then ship",
      terminalId: TERMINAL,
      pauses: [6],
    });
    await handleCorrect(fakeEvent, {
      rawText: "fix it then ship",
      terminalId: TERMINAL,
      pauses: [-1, 6],
    });
    expect(shared.correctionCalls[0]?.request).toMatchObject({ pauses: [6] });
    expect(shared.correctionCalls).toHaveLength(2);
    expect(shared.correctionCalls[1]?.request).not.toHaveProperty("pauses");
  });
});

describe("voiceInput — cleanup context read while the dictation runs (#14771)", () => {
  let cleanup: () => void;

  type CorrectHandler = (e: unknown, request: unknown) => Promise<unknown>;

  async function start(intent?: "rewrite") {
    const handleStart = getHandler("voice-input:start") as StartHandler;
    await handleStart(fakeEvent, nextSessionId(), {
      terminalId: TERMINAL,
      ...(intent ? { intent } : {}),
    });
  }

  function stop() {
    return (getHandler("voice-input:stop") as (e: unknown, id: string) => Promise<unknown>)(
      fakeEvent,
      currentSessionId
    );
  }

  const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.correctionCalls = [];
    shared.keytermCalls = [];
    shared.resolveCalls = [];
    shared.startCalls = [];
    shared.startContexts = [];
    shared.assembleKeyterms = null;
    shared.provider = "openai";
    shared.commandTarget = claudeTarget();
    shared.dictionary = [];
    shared.warmCalls = [];
    shared.preconnects = 0;
    shared.settingsOverride = {};
    shared.liveAgent = "claude";
    shared.roundTrip = undefined;
    shared.phases = undefined;
    shared.useDeferredDrain = false;
    shared.drainResolve = null;

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
    vi.useRealTimers();
  });

  it("finds the commands for cleanup at the start, so a stopped passage goes straight out", async () => {
    await start();
    const atStart = shared.resolveCalls.length;
    // One lookup for the keyterms, one with the correction's budget.
    expect(new Set(shared.resolveCalls.map((call) => call.timeoutMs)).size).toBe(2);
    await stop();

    const handleCorrect = getHandler("voice-input:correct") as CorrectHandler;
    await handleCorrect(fakeEvent, {
      rawText: "compact the conversation",
      terminalId: TERMINAL,
      sessionId: currentSessionId,
    });
    expect(shared.resolveCalls).toHaveLength(atStart);
    expect(shared.correctionCalls[0]?.settings).toMatchObject({
      commandTarget: { agentId: "claude" },
    });
  });

  it("looks for the commands again when the agent has left the terminal since the start", async () => {
    await start();
    await stop();
    const before = shared.resolveCalls.length;
    // Claude exited mid-dictation, leaving a shell.
    shared.liveAgent = null;
    shared.commandTarget = null;

    const handleCorrect = getHandler("voice-input:correct") as CorrectHandler;
    await handleCorrect(fakeEvent, {
      rawText: "please run the review skill",
      terminalId: TERMINAL,
      sessionId: currentSessionId,
    });
    expect(shared.resolveCalls).toHaveLength(before + 1);
    expect(shared.correctionCalls[0]?.settings).not.toHaveProperty("commandTarget");
  });

  it("keeps the start's commands when the terminal can't say which agent it runs", async () => {
    await start();
    await stop();
    const before = shared.resolveCalls.length;
    shared.liveAgent = undefined;

    const handleCorrect = getHandler("voice-input:correct") as CorrectHandler;
    await handleCorrect(fakeEvent, {
      rawText: "compact it",
      terminalId: TERMINAL,
      sessionId: currentSessionId,
    });
    expect(shared.resolveCalls).toHaveLength(before);
    expect(shared.correctionCalls[0]?.settings).toMatchObject({
      commandTarget: { agentId: "claude" },
    });
  });

  it("reports main's share of the wait: up to the request, and its round trip", async () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    shared.roundTrip = { sentAt: 1_200, ms: 700 };
    const handleCorrect = getHandler("voice-input:correct") as CorrectHandler;
    const reply = handleCorrect(fakeEvent, { rawText: "compact it", terminalId: TERMINAL });
    clock = 1_950;
    expect(await reply).toMatchObject({ timing: { prepMs: 200, requestMs: 700 } });

    // With nothing sent, all of main's time was preparation.
    clock = 5_000;
    shared.roundTrip = undefined;
    shared.phases = undefined;
    const unsent = handleCorrect(fakeEvent, { rawText: "compact it", terminalId: TERMINAL });
    clock = 5_030;
    expect(await unsent).toMatchObject({ timing: { prepMs: 30, requestMs: null } });
  });

  it("reports the reply's pace: the reads and the wait for its first text, then its text", async () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    shared.settingsOverride = {
      correctionProvider: "anthropic",
      correctionModel: "claude-haiku-5-5",
      anthropicApiKey: "sk-ant-test",
    };
    shared.phases = { untilOutputMs: 900, outputMs: 120, effort: "medium" };
    const handleCorrect = getHandler("voice-input:correct") as CorrectHandler;
    const reply = handleCorrect(fakeEvent, { rawText: "compact it", terminalId: TERMINAL });
    clock = 1_250;
    expect(await reply).toMatchObject({
      pace: { model: "claude-haiku-5-5", effort: "medium", firstTextMs: 1_150, outputMs: 120 },
    });

    // A reply without its parts, failed or unstreamed, teaches no pace.
    shared.phases = undefined;
    const unparted = await handleCorrect(fakeEvent, {
      rawText: "compact it",
      terminalId: TERMINAL,
    });
    expect(unparted).not.toHaveProperty("pace");
  });

  it("reads the context at the passage for one that names no session, or another's", async () => {
    await start();
    await stop();
    const handleCorrect = getHandler("voice-input:correct") as CorrectHandler;

    const before = shared.resolveCalls.length;
    await handleCorrect(fakeEvent, { rawText: "compact it", terminalId: TERMINAL });
    expect(shared.resolveCalls).toHaveLength(before + 1);

    await handleCorrect(fakeEvent, {
      rawText: "compact it",
      terminalId: TERMINAL,
      sessionId: "someone-elses",
    });
    expect(shared.resolveCalls).toHaveLength(before + 2);

    // Another view naming this session gets none of it.
    await handleCorrect(
      { ...fakeEvent, sender: { ...fakeEvent.sender, id: 2 } },
      { rawText: "compact it", terminalId: TERMINAL, sessionId: currentSessionId }
    );
    expect(shared.resolveCalls).toHaveLength(before + 3);
  });

  it("warms the very prompt the passage then sends", async () => {
    await start();
    await flushPromises();
    expect(shared.warmCalls).toHaveLength(1);
    await stop();

    const handleCorrect = getHandler("voice-input:correct") as CorrectHandler;
    await handleCorrect(fakeEvent, {
      rawText: "compact the conversation",
      terminalId: TERMINAL,
      sessionId: currentSessionId,
    });
    expect(shared.warmCalls[0]).toEqual(shared.correctionCalls[0]?.settings);
  });

  it("keeps the prompt warm while the dictation runs, and stops with it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await start();
    await flushPromises();
    expect(shared.warmCalls).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60_000);
    await flushPromises();
    const whileRunning = shared.warmCalls.length;
    expect(whileRunning).toBeGreaterThan(1);

    await stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30 * 60_000);
    await flushPromises();
    expect(shared.warmCalls).toHaveLength(whileRunning);
  });

  it("clears the check when a dictation is cancelled or the handlers go away", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await start();
    expect(vi.getTimerCount()).toBe(1);
    await (getHandler("voice-input:cancel") as (e: unknown, id: string) => Promise<unknown>)(
      fakeEvent,
      currentSessionId
    );
    expect(vi.getTimerCount()).toBe(0);

    await start();
    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops warming once cleanup is turned off mid-dictation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await start();
    await flushPromises();
    expect(shared.warmCalls).toHaveLength(1);

    shared.settingsOverride = { correctionEnabled: false };
    vi.advanceTimersByTime(30 * 60_000);
    await flushPromises();
    expect(shared.warmCalls).toHaveLength(1);
  });

  it("opens a socket while the stop drains, and asks again as the drain ends", async () => {
    shared.useDeferredDrain = true;
    await start();
    expect(shared.preconnects).toBe(0);
    const stopping = stop();
    await flushPromises();
    expect(shared.preconnects).toBe(1);
    // The service skips the second ask while the first socket is fresh.
    shared.drainResolve?.();
    await stopping;
    expect(shared.preconnects).toBe(2);
  });

  it.each([
    ["cleanup off", { correctionEnabled: false }],
    ["no OpenAI key", { openaiApiKey: "" }],
  ])("does nothing extra with %s", async (_case, override) => {
    shared.settingsOverride = override;
    await start();
    await flushPromises();
    await stop();
    expect(shared.warmCalls).toHaveLength(0);
    expect(shared.preconnects).toBe(0);
    expect(shared.resolveCalls).toHaveLength(1);
  });

  it("does nothing extra for a rewrite, which is never cleaned up", async () => {
    await start("rewrite");
    await flushPromises();
    await stop();
    expect(shared.warmCalls).toHaveLength(0);
    expect(shared.preconnects).toBe(0);
    expect(shared.resolveCalls).toHaveLength(1);
  });
});

describe("voiceInput — hesitations", () => {
  let cleanup: () => void;

  async function start(intent?: "rewrite") {
    const handleStart = getHandler("voice-input:start") as StartHandler;
    await handleStart(
      fakeEvent,
      nextSessionId(),
      intent ? { terminalId: TERMINAL, intent } : undefined
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.correctionCalls = [];
    shared.startCalls = [];
    shared.startContexts = [];
    shared.assembleKeyterms = null;
    shared.provider = "openai";
    shared.commandTarget = claudeTarget();
    shared.dictionary = [];
    shared.settingsOverride = {};
    shared.roundTrip = undefined;
    shared.phases = undefined;

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

  it.each([
    [
      "openai",
      "Um, so the build failed. Uh, we should revert.",
      "So the build failed. We should revert.",
    ],
    [
      "deepgram",
      "um so the build failed uhm we should revert",
      "so the build failed we should revert",
    ],
  ] as const)(
    "lands %s's transcript without them when cleanup is off",
    async (provider, text, expected) => {
      shared.provider = provider;
      shared.settingsOverride = { correctionEnabled: false };
      await start();
      emitTranscriptionEvent({ type: "complete", text, itemId: "item-A" });
      expect(completions()).toEqual([expect.objectContaining({ text: expected })]);
    }
  );

  it("retires an item that was only a hesitation with an empty completion", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Um.", itemId: "item-A" });
    expect(completions()).toEqual([expect.objectContaining({ text: "", itemId: "item-A" })]);
  });

  it("leaves the live preview as it was said", async () => {
    await start();
    emitTranscriptionEvent({ type: "delta", text: "Um, so the", itemId: "item-A" });
    const deltas = activeSent.filter((m) => m.channel === "voice-input:transcription-delta");
    expect(deltas.map((m) => m.payload)).toEqual([expect.objectContaining({ text: "Um, so the" })]);
  });

  it("reads a send after a hesitation as the send it is, and keeps the heard text clean", async () => {
    shared.dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }];
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "Um, use zoo stand uh for the store, send it.",
      itemId: "item-A",
      endOfSpeech: true,
    });
    expect(completions()).toEqual([
      expect.objectContaining({
        text: "Use Zustand for the store",
        heard: "Use zoo stand for the store",
        send: true,
      }),
    ]);
  });

  it("sends on a hesitation right before 'send it'", async () => {
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "Fix the build, um, send it.",
      itemId: "item-A",
      endOfSpeech: true,
    });
    expect(completions()).toEqual([expect.objectContaining({ text: "Fix the build", send: true })]);
  });

  it("reads a break command a hesitation fell inside of", async () => {
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "Fix the build new um line",
      itemId: "item-A",
      endOfSpeech: true,
    });
    expect(completions().map((p) => p.text)).toEqual(["Fix the build"]);
    expect(activeSent.filter((m) => m.channel === "voice-input:paragraph-boundary")).toHaveLength(
      1
    );
  });

  it("reads a command split across segments with a hesitation between", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Fix it, new", itemId: "A" });
    expect(completions()).toEqual([]);
    emitTranscriptionEvent({ type: "complete", text: "um, line.", itemId: "B", endOfSpeech: true });
    expect(
      (completions() as Array<{ text: string; itemId?: string }>).map((p) => ({
        itemId: p.itemId,
        text: p.text,
      }))
    ).toEqual([
      { itemId: "B", text: "" },
      { itemId: "A", text: "Fix it," },
    ]);
    expect(activeSent.filter((m) => m.channel === "voice-input:paragraph-boundary")).toHaveLength(
      1
    );
  });

  it("lands a segment held for a command as clean words when none follows", async () => {
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Um, add the new", itemId: "A" });
    expect(completions()).toEqual([]);
    emitTranscriptionEvent({
      type: "complete",
      text: "uh, settings page.",
      itemId: "B",
      endOfSpeech: true,
    });
    expect(
      (completions() as Array<{ text: string; itemId?: string }>).map((p) => ({
        itemId: p.itemId,
        text: p.text,
      }))
    ).toEqual([
      { itemId: "A", text: "Add the new" },
      { itemId: "B", text: "settings page." },
    ]);
    expect(completions().some((p) => p.send)).toBe(false);
  });

  it("keeps the unsure words with the words they were flagged on", async () => {
    await start();
    const text = "Um, check the build now";
    const from = text.indexOf("build");
    emitTranscriptionEvent({
      type: "complete",
      text,
      itemId: "item-A",
      uncertain: [{ from, to: from + 5 }],
    });
    const [sent] = completions();
    expect(sent?.text).toBe("Check the build now");
    expect(flagged(sent?.text, sent?.uncertain)).toEqual(["10:build"]);
  });

  it("leaves words and identifiers that only contain one alone", async () => {
    await start();
    emitTranscriptionEvent({
      type: "complete",
      text: "Open umbrella.ts and the um_helper summary",
      itemId: "item-A",
    });
    expect(completions()).toEqual([
      expect.objectContaining({ text: "Open umbrella.ts and the um_helper summary" }),
    ]);
  });

  it("leaves another language's words to cleanup", async () => {
    shared.settingsOverride = { language: "pt" };
    await start();
    emitTranscriptionEvent({ type: "complete", text: "Um carro, uh", itemId: "item-A" });
    expect(completions()).toEqual([expect.objectContaining({ text: "Um carro, uh" })]);
  });

  it("keeps a rewrite instruction as it was said", async () => {
    await start("rewrite");
    emitTranscriptionEvent({ type: "complete", text: "Um, make it shorter", itemId: "item-A" });
    expect(completions()).toEqual([expect.objectContaining({ text: "Um, make it shorter" })]);
  });
});
