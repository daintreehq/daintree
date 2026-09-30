import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings } from "../../../../shared/types/ipc/api.js";

// ── Mock the `ws` package ────────────────────────────────────────────────────
//
// The service imports `WebSocket from "ws"` (the npm package, not the WHATWG
// global) because Node's global WebSocket constructor silently drops the
// custom-headers option needed for OpenAI auth. We mock the entire module so
// the constructor returns a controllable EventEmitter-style stub.

interface MockOptions {
  headers: Record<string, string>;
}

type WsListener = (...args: unknown[]) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  options: MockOptions;
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  closeCode?: number;
  terminateCalls = 0;
  pingCalls = 0;

  private listeners: Map<string, Set<WsListener>> = new Map();

  constructor(url: string, options: MockOptions) {
    this.url = url;
    this.options = options;
    instances.push(this);
  }

  on(event: string, listener: WsListener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off(event: string, listener: WsListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }

  private fire(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) listener(...args);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number): void {
    this.closeCalls++;
    this.closeCode = code;
    this.readyState = MockWebSocket.CLOSED;
  }

  // `ws.terminate()` destroys the socket without a closing handshake. The real
  // package fires a `close` event afterward; mirror that so the service's
  // close-driven reconnect path is exercised.
  terminate(): void {
    this.terminateCalls++;
    this.readyState = MockWebSocket.CLOSED;
    this.fire("close", 1006, undefined);
  }

  ping(): void {
    this.pingCalls++;
  }

  // Test helpers
  simulatePong(): void {
    this.fire("pong");
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.fire("open");
  }

  simulateMessage(type: string, payload: Record<string, unknown> = {}): void {
    this.fire("message", Buffer.from(JSON.stringify({ type, ...payload })));
  }

  simulateRawMessage(data: string | Buffer): void {
    this.fire("message", data);
  }

  simulateError(err: Error = new Error("WebSocket error")): void {
    this.fire("error", err);
  }

  simulateClose(code?: number, reason?: Buffer | string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.fire("close", code, reason);
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const instances: MockWebSocket[] = [];
let throwOnConstruct = false;
let constructError: Error | null = null;

vi.mock("ws", () => {
  const ctor = function (this: unknown, url: string, options: MockOptions) {
    if (throwOnConstruct) {
      throw constructError ?? new Error("WebSocket construction failed");
    }
    return new MockWebSocket(url, options);
  } as unknown as new (url: string, options: MockOptions) => MockWebSocket;
  return { default: ctor };
});

// ── Mock the VAD process (`electron` utilityProcess) ────────────────────────
//
// The provider forks a utility process running Silero VAD. We replace the fork
// with a controllable stub so tests can drive speech-start/speech-end events
// synchronously and assert the resulting commit/clear behavior without loading
// ONNX. The fork can be forced to throw to exercise the degraded fallback path.

type VadListener = (...args: unknown[]) => void;

let nextVadPid = 41_000;

class MockVadWorker {
  posted: Array<Record<string, unknown>> = [];
  transfers: unknown[] = [];
  killCalls = 0;
  readonly pid = nextVadPid++;
  private listeners: Map<string, Set<VadListener>> = new Map();

  constructor(_modulePath: string) {
    vadWorkers.push(this);
  }

  on(event: string, listener: VadListener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  postMessage(message: Record<string, unknown>, transfer?: unknown): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  kill(): boolean {
    this.killCalls++;
    return true;
  }

  private fire(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) listener(...args);
  }

  // Test helpers — simulate the process lifecycle and the messages
  // openaiVadWorker posts back.
  emitSpawn(): void {
    this.fire("spawn");
  }
  emitReady(): void {
    this.fire("message", { type: "ready" });
  }
  emitSpeechStart(): void {
    this.fire("message", { type: "speech-start" });
  }
  emitSpeechEnd(): void {
    this.fire("message", { type: "speech-end" });
  }
  emitWorkerError(message = "vad failed"): void {
    this.fire("message", { type: "error", message });
  }
  emitDrained(): void {
    this.fire("message", { type: "drained" });
  }
  emitExit(code: number): void {
    this.fire("exit", code);
  }
}

const vadWorkers: MockVadWorker[] = [];
let throwOnVadConstruct = false;

vi.mock("electron", () => ({
  utilityProcess: {
    fork: (modulePath: string) => {
      if (throwOnVadConstruct) throw new Error("VAD spawn failed");
      return new MockVadWorker(modulePath);
    },
  },
}));

function latestVadWorker(): MockVadWorker {
  const worker = vadWorkers.at(-1);
  if (!worker) throw new Error("No MockVadWorker instance created");
  return worker;
}

/** Produce exactly one VAD-driven commit: feed audio, then speech start→end. */
function vadCommitSegment(
  service: OpenAITranscriptionProviderInstance,
  worker: MockVadWorker
): void {
  feedCommittableAudio(service);
  worker.emitSpeechStart();
  worker.emitSpeechEnd();
}

// ── Capture logger output ────────────────────────────────────────────────────
//
// Keyterms carry the user's branch names, custom dictionary and terminal output,
// and main-process logs are readable by agents. Capturing every log argument
// lets the privacy tests assert that no keyterm content ever reaches a log,
// at the real call sites rather than only inside the summarizer.

const logCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock("../../../utils/logger.js", () => ({
  logDebug: (...args: unknown[]) => void logCalls.push(args),
  logInfo: (...args: unknown[]) => void logCalls.push(args),
  logWarn: (...args: unknown[]) => void logCalls.push(args),
  logError: (...args: unknown[]) => void logCalls.push(args),
}));

/** Everything written to the logger this test, flattened to one string. */
function loggedText(): string {
  return logCalls.map((args) => args.map((a) => JSON.stringify(a) ?? "").join(" ")).join("\n");
}

// Import the service AFTER vi.mock so the mocked `ws` is used.
const { OpenAITranscriptionProvider, summarizeEchoedSession } =
  await import("../OpenAITranscriptionProvider.js");
type OpenAITranscriptionProviderInstance = InstanceType<typeof OpenAITranscriptionProvider>;
type VoiceTranscriptionEvent = import("../TranscriptionProvider.js").VoiceTranscriptionEvent;

const BASE_SETTINGS: VoiceInputSettings = {
  enabled: true,
  openaiApiKey: "sk-test",
  deepgramApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionModel: "gpt-5.6-luna",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [],
  learnFromCorrections: true,
};

function latestInstance(): MockWebSocket {
  const instance = instances.at(-1);
  if (!instance) throw new Error("No MockWebSocket instance created");
  return instance;
}

/** Parses `session.audio.input.transcription` out of a sent session.update. */
function readTranscription(socket: MockWebSocket, index = 0): Record<string, unknown> {
  const payload = JSON.parse(socket.sent[index]) as {
    session: { audio: { input: { transcription: Record<string, unknown> } } };
  };
  return payload.session.audio.input.transcription;
}

/** Advance the service through connect → ready. Returns the active mock socket. */
async function bringSessionReady(
  service: OpenAITranscriptionProviderInstance,
  settings: VoiceInputSettings = BASE_SETTINGS
): Promise<{ socket: MockWebSocket; result: { ok: true } | { ok: false; error: string } }> {
  const startPromise = service.start(settings);
  // start() runs synchronously through to assigning pendingStart; allow the
  // microtask queue to settle so the constructor + onopen wiring is in place.
  await Promise.resolve();
  const socket = latestInstance();
  socket.simulateOpen();
  socket.simulateMessage("session.updated");
  const result = await startPromise;
  return { socket, result };
}

/**
 * Feed enough uncommitted audio that the next `input_audio_buffer.commit` clears
 * the MIN_COMMIT_BYTES floor — otherwise the service skips the commit to avoid
 * OpenAI's "undersized buffer" error.
 */
function feedCommittableAudio(service: OpenAITranscriptionProviderInstance): void {
  service.sendAudioChunk(new Uint8Array(5_000).buffer);
}

describe("OpenAITranscriptionProvider", () => {
  beforeEach(() => {
    instances.length = 0;
    throwOnConstruct = false;
    constructError = null;
    vadWorkers.length = 0;
    throwOnVadConstruct = false;
    logCalls.length = 0;
    // Retirement arms a real SIGKILL backstop; fake pids must never reach the OS.
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    // End every fake VAD process so none lingers in the module's retiring set.
    for (const worker of vadWorkers) worker.emitExit(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Startup / readiness ──────────────────────────────────────────────────

  it("fails to start when no OpenAI API key is configured", async () => {
    const service = new OpenAITranscriptionProvider();
    const result = await service.start({ ...BASE_SETTINGS, openaiApiKey: "" });
    expect(result).toEqual({ ok: false, error: "OpenAI API key not configured" });
    expect(instances).toHaveLength(0);
  });

  it("constructs the WebSocket with the realtime URL and auth headers", async () => {
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, openaiApiKey: "sk-abc" });
    await Promise.resolve();
    const socket = latestInstance();
    expect(socket.url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
    expect(socket.options.headers.Authorization).toBe("Bearer sk-abc");
    service.stop();
  });

  it("sends session.update on WebSocket open and stays not-ready until session.updated", async () => {
    const service = new OpenAITranscriptionProvider();
    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const startPromise = service.start(BASE_SETTINGS);
    expect(statuses).toEqual(["connecting"]);
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();

    expect(socket.sent).toHaveLength(1);
    const sessionUpdate = JSON.parse(socket.sent[0]) as {
      type: string;
      session: { type: string; audio: { input: Record<string, unknown> } };
    };
    expect(sessionUpdate.type).toBe("session.update");
    expect(sessionUpdate.session.type).toBe("transcription");
    expect(sessionUpdate.session.audio.input).toMatchObject({
      format: { type: "audio/pcm", rate: 24000 },
      transcription: { model: "gpt-live-transcribe", languages: ["en"] },
    });
    // `delay` must be present and a valid tier. The specific tier is tuning, so
    // asserting the literal here would just restate the provider's constant.
    expect(["minimal", "low", "medium", "high", "xhigh"]).toContain(
      (sessionUpdate.session.audio.input.transcription as { delay: string }).delay
    );
    // `languages` (array) supersedes the deprecated singular `language`, and the
    // two are mutually exclusive on the wire — sending both is invalid.
    expect(sessionUpdate.session.audio.input.transcription).not.toHaveProperty("language");
    // `turn_detection` must be EXPLICITLY null — see the session.update comment
    // in OpenAITranscriptionProvider. Omitting it makes the server silently emit
    // no transcription items.
    expect(sessionUpdate.session.audio.input.turn_detection).toBeNull();

    // Still not ready — start() must wait for session.updated
    expect(statuses).toEqual(["connecting"]);

    socket.simulateMessage("session.updated");
    await expect(startPromise).resolves.toEqual({ ok: true });
    expect(statuses).toEqual(["connecting", "recording"]);
    // Ready sessions own a VAD worker and a heartbeat — stop so neither
    // outlives the test.
    service.stop();
  });

  it("sends the configured language as a one-element languages array", async () => {
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language: "es" });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    const transcription = readTranscription(socket);
    expect(transcription.languages).toEqual(["es"]);
    expect(transcription).not.toHaveProperty("language");
    service.stop();
  });

  it("omits languages and the language directive for auto-detect", async () => {
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language: "auto", keyterms: ["Daintree"] });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    const transcription = readTranscription(socket);
    expect(transcription).not.toHaveProperty("languages");
    expect(transcription).not.toHaveProperty("language");
    expect(transcription.prompt).toBe("Keywords: Daintree");
    service.stop();
  });

  it("adds a no-translate directive to the prompt for a fixed language, even without keyterms", async () => {
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language: "es" });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    const transcription = readTranscription(socket);
    expect(transcription.prompt).toBe("Transcribe in Spanish. Do not translate.");
    expect(transcription).not.toHaveProperty("keywords");
    service.stop();
  });

  it("sends no directive for an unknown language code, keeping the prompt bounded", async () => {
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language: "x".repeat(380) });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    expect(readTranscription(socket)).not.toHaveProperty("prompt");
    service.stop();
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("falls back to en when the configured language is %s", async (_label, language) => {
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    expect(readTranscription(socket).languages).toEqual(["en"]);
    service.stop();
  });

  it.each([
    ["a number", 42],
    ["an object", { code: "en" }],
    ["an array", ["en"]],
    ["null", null],
  ])("falls back to en without throwing when language is %s", async (_label, language) => {
    // Persisted settings are cast, not validated, and setSettings takes an
    // arbitrary patch — a non-string here would otherwise throw inside the
    // WebSocket `open` handler, outside any try/catch.
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language } as unknown as VoiceInputSettings);
    await Promise.resolve();
    const socket = latestInstance();
    expect(() => socket.simulateOpen()).not.toThrow();
    expect(readTranscription(socket).languages).toEqual(["en"]);
    service.stop();
  });

  it("sends frozen keyterms as native keywords and a formatted prompt", async () => {
    // `gpt-live-transcribe` supports both, which is what retired the old
    // MODEL_SUPPORTS_PROMPT gate.
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, keyterms: ["Daintree", "xterm"] });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    const transcription = readTranscription(socket);
    expect(transcription.keywords).toEqual(["Daintree", "xterm"]);
    expect(transcription.prompt).toBe(
      "Transcribe in English. Do not translate. Keywords: Daintree, xterm"
    );
    service.stop();
  });

  it("drops keyterms containing characters the API rejects, from both fields", async () => {
    // A single forbidden character rejects the ENTIRE session.update, so an
    // unsanitized keyterm would kill the whole dictation session.
    const service = new OpenAITranscriptionProvider();
    void service.start({
      ...BASE_SETTINGS,
      keyterms: ["Daintree", "<div>", `a${String.fromCharCode(10)}b`, "xterm"],
    });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    const transcription = readTranscription(socket);
    expect(transcription.keywords).toEqual(["Daintree", "xterm"]);
    expect(transcription.prompt).toBe(
      "Transcribe in English. Do not translate. Keywords: Daintree, xterm"
    );
    expect(socket.sent[0]).not.toContain("<div>");
    service.stop();
  });

  it("omits both keywords and prompt for auto language with no frozen keyterms", async () => {
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language: "auto" });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    const transcription = readTranscription(socket);
    expect(transcription).not.toHaveProperty("prompt");
    expect(transcription).not.toHaveProperty("keywords");
    service.stop();
  });

  it("never logs keyterm content, on the outbound payload or either server echo", async () => {
    // Guards the real call sites, not just summarizeEchoedSession: reverting any
    // of them to logging the raw session object must fail this test. The echo
    // carries a DIFFERENT sentinel per field so leaking only one is still caught.
    const sentTerm = "secret-branch-name";
    const echoedKeyword = "echoed-keyword-sentinel";
    const echoedPrompt = "echoed-prompt-sentinel";

    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, keyterms: [sentTerm] });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();

    const echo = {
      session: {
        audio: {
          input: {
            transcription: {
              model: "gpt-live-transcribe",
              languages: ["en"],
              delay: "low",
              keywords: [echoedKeyword],
              prompt: `Keywords: ${echoedPrompt}`,
            },
            turn_detection: null,
          },
        },
      },
    };
    socket.simulateMessage("session.created", echo);
    socket.simulateMessage("session.updated", echo);

    // The term really was sent — otherwise this test would pass vacuously.
    expect(socket.sent[0]).toContain(sentTerm);
    const logs = loggedText();
    expect(logs).not.toContain(sentTerm);
    expect(logs).not.toContain(echoedKeyword);
    expect(logs).not.toContain(echoedPrompt);
    // The diagnostic itself must survive redaction — a key named `keywordCount`
    // is blanked by the logger's "key" substring rule.
    expect(logs).toContain("biasTermCount");
    service.stop();
  });

  it("omits both keywords and prompt when every keyterm is rejected (auto language)", async () => {
    // Never send `[]` / `""` — omit the fields entirely.
    const service = new OpenAITranscriptionProvider();
    void service.start({ ...BASE_SETTINGS, language: "auto", keyterms: ["<a>", "b>c"] });
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    const transcription = readTranscription(socket);
    expect(transcription).not.toHaveProperty("prompt");
    expect(transcription).not.toHaveProperty("keywords");
    service.stop();
  });

  it("resends the identical sanitized keywords and prompt on reconnect", async () => {
    // Keyterms are frozen on the settings snapshot at session start, so a
    // reconnect must deterministically rebuild the same transcription config.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service, {
      ...BASE_SETTINGS,
      keyterms: ["Daintree", "<div>", "xterm"],
    });

    socket.simulateClose(1006, Buffer.from("abnormal"));
    vi.advanceTimersByTime(3_000);
    const socket2 = latestInstance();
    expect(socket2).not.toBe(socket);
    socket2.simulateOpen();

    const reconnected = readTranscription(socket2);
    expect(reconnected.keywords).toEqual(["Daintree", "xterm"]);
    expect(reconnected.prompt).toBe(
      "Transcribe in English. Do not translate. Keywords: Daintree, xterm"
    );
    expect(reconnected).toEqual(readTranscription(socket));
    service.stop();
  });

  it("settles a pending start when the session is stopped before session.updated", async () => {
    const service = new OpenAITranscriptionProvider();
    const startPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    latestInstance().simulateOpen();
    // No session.updated yet — stop before ready.
    service.stop();
    await expect(startPromise).resolves.toEqual({
      ok: false,
      error: "Voice session stopped",
    });
  });

  it("does not emit idle when start() replaces a previous session", async () => {
    const service = new OpenAITranscriptionProvider();
    await bringSessionReady(service);

    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const secondPromise = service.start(BASE_SETTINGS);
    const idleBeforeConnect = events.filter((e) => e.type === "status" && e.status === "idle");
    expect(idleBeforeConnect).toHaveLength(0);

    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    socket.simulateMessage("session.updated");
    await secondPromise;
  });

  it("times out and closes the socket if session.updated does not arrive within 10s", async () => {
    const service = new OpenAITranscriptionProvider();
    const errors: string[] = [];
    service.onEvent((e) => {
      if (e.type === "error") errors.push(e.error.message);
    });

    const startPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    // Never simulate session.updated.

    vi.advanceTimersByTime(10_000);

    await expect(startPromise).resolves.toEqual({ ok: false, error: "Connection timed out" });
    expect(errors).toContain("Connection timed out");
    expect(socket.closeCalls).toBe(1);
  });

  // ── Delta / complete events ──────────────────────────────────────────────

  it("emits delta for incremental transcription deltas", async () => {
    const service = new OpenAITranscriptionProvider();
    const deltas: string[] = [];
    service.onEvent((e) => {
      if (e.type === "delta") deltas.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      delta: "Hello",
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      delta: " world",
    });

    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("ignores empty deltas", async () => {
    const service = new OpenAITranscriptionProvider();
    const deltas: string[] = [];
    service.onEvent((e) => {
      if (e.type === "delta") deltas.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", { delta: "" });
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {});

    expect(deltas).toEqual([]);
  });

  it("emits complete with stub confidence on transcription.completed", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "Hello world",
    });

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toEqual({
      type: "complete",
      text: "Hello world",
      confidence: { minConfidence: 1.0, wordCount: 0, uncertainWords: [], words: [] },
    });
  });

  it("does not emit complete when transcript is empty or whitespace-only", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "",
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "   ",
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {});

    expect(completes).toEqual([]);
  });

  it("emits complete from a conversation.item.done event (intent=transcription endpoint)", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    // The `?intent=transcription` endpoint reports each committed segment via
    // conversation.item.done; the transcript lives on the input_audio part.
    socket.simulateMessage("conversation.item.added", {
      item: { content: [{ type: "input_audio" }] },
    });
    socket.simulateMessage("conversation.item.done", {
      item: {
        content: [{ type: "input_audio", transcript: "hello from done" }],
      },
    });

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toEqual({
      type: "complete",
      text: "hello from done",
      confidence: { minConfidence: 1.0, wordCount: 0, uncertainWords: [], words: [] },
    });
  });

  it("ignores a conversation.item.done with no input_audio transcript", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.done", { item: { content: [] } });
    socket.simulateMessage("conversation.item.done", {
      item: { content: [{ type: "input_audio", transcript: "   " }] },
    });
    socket.simulateMessage("conversation.item.done", {});

    expect(completes).toEqual([]);
  });

  // ── Audio chunk handling ─────────────────────────────────────────────────

  it("sends audio chunks as base64 input_audio_buffer.append after session.updated", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    const chunk = new Uint8Array([1, 2, 3, 4]).buffer;
    const sentBeforeAudio = socket.sent.length;
    service.sendAudioChunk(chunk);
    expect(socket.sent.length).toBe(sentBeforeAudio + 1);
    const payload = JSON.parse(socket.sent.at(-1)!) as { type: string; audio: string };
    expect(payload.type).toBe("input_audio_buffer.append");
    expect(payload.audio).toBe(Buffer.from(chunk).toString("base64"));
  });

  it("buffers pre-connect audio chunks and flushes them after session.updated", async () => {
    const service = new OpenAITranscriptionProvider();
    const startPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const socket = latestInstance();

    // Queue chunks before the WS open / session.updated round-trip.
    service.sendAudioChunk(new Uint8Array([1]).buffer);
    service.sendAudioChunk(new Uint8Array([2]).buffer);

    expect(socket.sent).toHaveLength(0);

    socket.simulateOpen();
    // session.update sent on open, no audio yet
    expect(socket.sent).toHaveLength(1);

    socket.simulateMessage("session.updated");
    await startPromise;

    const audioPayloads = socket
      .sentJson()
      .filter((p) => p.type === "input_audio_buffer.append")
      .map((p) => p.audio as string);
    expect(audioPayloads).toEqual([
      Buffer.from(new Uint8Array([1])).toString("base64"),
      Buffer.from(new Uint8Array([2])).toString("base64"),
    ]);
  });

  it("caps the pre-connect buffer at 100 chunks and reports the overflow once", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));
    void service.start(BASE_SETTINGS);
    await Promise.resolve();

    // Push 105 chunks before session.updated — last 5 should be dropped.
    for (let i = 0; i < 105; i++) {
      service.sendAudioChunk(new Uint8Array([i % 256]).buffer);
    }
    const socket = latestInstance();
    socket.simulateOpen();
    socket.simulateMessage("session.updated");

    const audioCount = socket
      .sentJson()
      .filter((p) => p.type === "input_audio_buffer.append").length;
    expect(audioCount).toBe(100);
    const overflows = events.filter(
      (e) => e.type === "error" && e.error.code === "audio_buffer_overflow"
    );
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toMatchObject({ error: { severity: "transient" } });
    service.stop();
  });

  it("drops audio chunks while draining", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    // Feed enough audio that stop sends a real final commit and genuinely drains.
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();
    const sentAtStartOfDrain = socket.sent.length;
    service.sendAudioChunk(new Uint8Array([99]).buffer);
    expect(socket.sent.length).toBe(sentAtStartOfDrain);

    socket.simulateMessage("conversation.item.done", {
      item: { content: [{ type: "input_audio", transcript: "done" }] },
    });
    await drainPromise;
  });

  // ── VAD-driven commit ─────────────────────────────────────────────────────
  // The provider sends `turn_detection: null`, so a client-side VAD side-chain
  // (Silero v5, on a worker thread) drives segmentation: commit at end-of-speech
  // and clear the server buffer on speech onset. Without commits no
  // transcription events ever arrive.

  it("spawns the VAD worker once the session is ready", async () => {
    const service = new OpenAITranscriptionProvider();
    await bringSessionReady(service);
    expect(vadWorkers).toHaveLength(1);
    service.stop();
  });

  it("feeds the VAD without transferring the buffer still sent to OpenAI", async () => {
    const service = new OpenAITranscriptionProvider();
    await bringSessionReady(service);
    const worker = latestVadWorker();

    const chunk = new Uint8Array(64).fill(3).buffer;
    service.sendAudioChunk(chunk);

    const audioIndex = worker.posted.findIndex((m) => m.type === "audio");
    expect(audioIndex).toBeGreaterThanOrEqual(0);
    // UtilityProcess.postMessage structured-clones the payload and only accepts
    // MessagePorts in a transfer list, so the chunk goes over untransferred and
    // stays intact for the OpenAI send.
    expect(worker.transfers[audioIndex]).toBeUndefined();
    expect(chunk.byteLength).toBe(64);

    service.stop();
  });

  it("commits the audio buffer on VAD speech-end once enough audio has streamed", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    feedCommittableAudio(service);
    worker.emitSpeechStart();
    // Speech is ongoing — no commit yet.
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(0);

    worker.emitSpeechEnd();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(1);

    service.stop();
  });

  it("does not clear on the first speech-start of a connection", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    // The first speech-start has no preceding speech-end, so audio buffered
    // before the VAD was ready might be real speech — the buffer must be kept.
    service.sendAudioChunk(new Uint8Array(5_000).buffer);
    const sentBefore = socket.sent.length;
    worker.emitSpeechStart();

    const newPayloads = socket.sentJson().slice(sentBefore);
    expect(newPayloads.some((p) => p.type === "input_audio_buffer.clear")).toBe(false);

    service.stop();
  });

  it("clears the server buffer on a later speech-start and replays the pre-roll", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    // Complete one segment so a subsequent speech-start is allowed to clear
    // (the buffer after a speech-end commit is VAD-confirmed silence).
    feedCommittableAudio(service);
    worker.emitSpeechStart();
    worker.emitSpeechEnd();

    const chunk = new Uint8Array(5_000).fill(7).buffer;
    service.sendAudioChunk(chunk);
    const sentBefore = socket.sent.length;

    worker.emitSpeechStart();

    const newPayloads = socket.sentJson().slice(sentBefore);
    // Barge-in: a clear is sent, then the pre-roll is replayed.
    expect(newPayloads[0]).toEqual({ type: "input_audio_buffer.clear" });
    const replayed = newPayloads.filter((p) => p.type === "input_audio_buffer.append");
    expect(replayed.some((p) => p.audio === Buffer.from(chunk).toString("base64"))).toBe(true);

    service.stop();
  });

  it("does not replay the pre-roll when the speech-start clear send fails", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    feedCommittableAudio(service);
    worker.emitSpeechStart();
    worker.emitSpeechEnd();

    service.sendAudioChunk(new Uint8Array(5_000).buffer);
    const sentBefore = socket.sent.length;

    // The clear send throws — the server buffer was not emptied, so replaying
    // the pre-roll would duplicate bytes. No appends must follow.
    socket.send = () => {
      throw new Error("socket closing");
    };
    worker.emitSpeechStart();
    expect(socket.sent.length).toBe(sentBefore);

    service.stop();
  });

  it("does not commit a VAD misfire that carries too little audio", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    // A misfire surfaces as speech-start then speech-end with only a tiny blip
    // of audio — the MIN_COMMIT_BYTES guard must skip the commit.
    service.sendAudioChunk(new Uint8Array(10).buffer);
    worker.emitSpeechStart();
    worker.emitSpeechEnd();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(0);

    service.stop();
  });

  it("skips the commit when too little audio has streamed since the last commit", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    // A tiny chunk, well under MIN_COMMIT_BYTES — committing it would draw a
    // fatal "undersized buffer" error from OpenAI, so speech-end must skip it.
    service.sendAudioChunk(new Uint8Array(10).buffer);
    worker.emitSpeechStart();
    worker.emitSpeechEnd();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(0);

    service.stop();
  });

  it("ignores a VAD speech-end with no preceding speech-start", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    feedCommittableAudio(service);
    // No speech-start fired — a stray speech-end must not commit.
    worker.emitSpeechEnd();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(0);

    service.stop();
  });

  it("forces a backstop commit when speech runs past the max-segment window", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    feedCommittableAudio(service);
    worker.emitSpeechStart(); // backstop timer starts
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(0);

    // Continuous speech with no detected pause — the 8s backstop fires a commit.
    vi.advanceTimersByTime(8_000);
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(1);

    service.stop();
  });

  it("falls back to a periodic backstop commit when the VAD worker errors", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();

    worker.emitWorkerError("model load failed");
    expect(worker.posted).toContainEqual({ type: "destroy" });
    expect(worker.killCalls).toBe(0);
    // Degraded mode: no speech events, audio still streams, backstop commits.
    feedCommittableAudio(service);
    vi.advanceTimersByTime(8_000);
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(1);

    service.stop();
  });

  it("falls back to degraded mode when the VAD worker cannot be spawned", async () => {
    throwOnVadConstruct = true;
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    feedCommittableAudio(service);
    vi.advanceTimersByTime(8_000);
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(1);

    service.stop();
  });

  it("ignores VAD messages from a stale worker after the session is replaced", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket: firstSocket } = await bringSessionReady(service);
    const staleWorker = latestVadWorker();

    // Replace the session — the first worker is now stale.
    const secondPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const secondSocket = latestInstance();
    secondSocket.simulateOpen();
    secondSocket.simulateMessage("session.updated");
    await secondPromise;

    // The stale worker fires speech events — they must be ignored (the first
    // socket was torn down; no commit should land on either socket from it).
    feedCommittableAudio(service);
    staleWorker.emitSpeechStart();
    staleWorker.emitSpeechEnd();
    expect(
      firstSocket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")
    ).toHaveLength(0);
    expect(
      secondSocket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")
    ).toHaveLength(0);

    service.stop();
  });

  it("requests native VAD cleanup without killing pending work on stop", async () => {
    const kill = vi.mocked(process.kill);
    const service = new OpenAITranscriptionProvider();
    await bringSessionReady(service);
    const worker = latestVadWorker();
    service.stop();
    expect(worker.posted).toContainEqual({ type: "destroy" });
    expect(worker.killCalls).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  // ── VAD process isolation (#12577) ───────────────────────────────────────

  // 6: a native ONNX abort (Electron 42 reports the SIGABRT'd child as 6).
  // 1: the child's own fatal-error handler. 0: a child that simply went away.
  it.each([6, 1, 0])(
    "degrades instead of failing when the VAD process exits with code %i mid-session",
    async (code) => {
      const service = new OpenAITranscriptionProvider();
      const events: VoiceTranscriptionEvent[] = [];
      service.onEvent((event) => events.push(event));
      const { socket } = await bringSessionReady(service);
      const worker = latestVadWorker();
      worker.emitSpawn();
      worker.emitReady();

      worker.emitExit(code);

      // The dead process is not sent a destroy, and nothing more is fed to it.
      expect(worker.posted).not.toContainEqual({ type: "destroy" });
      const postedBefore = worker.posted.length;
      feedCommittableAudio(service);
      expect(worker.posted).toHaveLength(postedBefore);
      // Dictation carries on at the backstop cadence, with nothing surfaced to
      // the user as a failure.
      vi.advanceTimersByTime(8_000);
      expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(
        1
      );
      expect(events.some((event) => event.type === "error")).toBe(false);
      const exitLog = logCalls.find(([message]) =>
        String(message).includes("VAD process exited unexpectedly")
      );
      expect(exitLog?.at(-1)).toMatchObject({ code });

      service.stop();
    }
  );

  it("ignores the exit of a VAD process retired by an earlier session", async () => {
    const service = new OpenAITranscriptionProvider();
    await bringSessionReady(service);
    const staleWorker = latestVadWorker();

    const secondPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const secondSocket = latestInstance();
    secondSocket.simulateOpen();
    secondSocket.simulateMessage("session.updated");
    await secondPromise;
    const currentWorker = latestVadWorker();
    expect(currentWorker).not.toBe(staleWorker);

    staleWorker.emitExit(6);

    // The live session keeps its VAD: audio still reaches it and a speech-end
    // still commits.
    vadCommitSegment(service, currentWorker);
    expect(currentWorker.posted.some((m) => m.type === "audio")).toBe(true);
    expect(
      secondSocket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")
    ).toHaveLength(1);

    service.stop();
  });

  it("logs each VAD lifecycle transition with no audio or transcript content", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    worker.emitSpawn();
    worker.emitReady();
    vadCommitSegment(service, worker);
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-secret",
      transcript: "the secret transcript",
    });

    service.stop();
    worker.emitDrained();
    worker.emitExit(0);

    const lifecycle = logCalls
      .map(([message]) => String(message))
      .filter((message) => message.includes("VAD"));
    const order = [
      "VAD process spawned",
      "VAD session ready",
      "VAD destroy requested",
      "VAD drained",
      "VAD process exited",
    ].map((step) => lifecycle.findIndex((message) => message.includes(step)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Structural, not textual: an ArrayBuffer stringifies to `{}`, so a string
    // search alone would miss logged audio.
    const carriesAudio = (value: unknown, depth = 0): boolean => {
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
      if (Array.isArray(value) && value.length > 16 && value.every((v) => typeof v === "number")) {
        return true;
      }
      if (value && typeof value === "object" && depth < 4) {
        return Object.values(value).some((v) => carriesAudio(v, depth + 1));
      }
      return false;
    };
    const vadEntries = logCalls.filter(([message]) => String(message).includes("VAD"));
    expect(vadEntries.length).toBeGreaterThan(0);
    for (const args of vadEntries) {
      expect(args.some((arg) => carriesAudio(arg))).toBe(false);
      expect(JSON.stringify(args)).not.toContain("secret transcript");
    }
  });

  it("commitParagraphBoundary flushes the current segment when enough audio has streamed", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    feedCommittableAudio(service);
    service.commitParagraphBoundary();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(1);

    service.stop();
  });

  // ── Graceful stop / drain ────────────────────────────────────────────────

  it("sends input_audio_buffer.commit on stopGracefully and waits for completed", async () => {
    const service = new OpenAITranscriptionProvider();
    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const { socket } = await bringSessionReady(service);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();
    expect(statuses).toContain("finishing");

    const commitPayloads = socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit");
    expect(commitPayloads).toHaveLength(1);

    socket.simulateMessage("conversation.item.done", {
      item: { content: [{ type: "input_audio", transcript: "final" }] },
    });
    await drainPromise;
    expect(statuses.at(-1)).toBe("idle");
  });

  it("drain waits for every outstanding commit's transcript, not just the first", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    // A VAD segment commits (segment A), then more audio accumulates and stop
    // sends a final commit (segment B) — two transcripts now outstanding.
    vadCommitSegment(service, worker);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(2);

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    // Segment A completes first — drain must NOT settle, B is still in flight.
    socket.simulateMessage("conversation.item.done", {
      item: { content: [{ type: "input_audio", transcript: "first half" }] },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Segment B completes — every outstanding commit has now reported back.
    socket.simulateMessage("conversation.item.done", {
      item: { content: [{ type: "input_audio", transcript: "second half" }] },
    });
    await drainPromise;
    expect(completes).toEqual(["first half", "second half"]);
  });

  it("drain resolves after the timeout if no completion arrives", async () => {
    const service = new OpenAITranscriptionProvider();
    await bringSessionReady(service);
    feedCommittableAudio(service);

    const drainPromise = service.stopGracefully();
    vi.advanceTimersByTime(3_000);
    await expect(drainPromise).resolves.toBeUndefined();
  });

  it("stop with a sub-threshold buffer and nothing outstanding resolves immediately", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    // No audio since the last commit and no commits in flight — nothing to
    // transcribe, so stop closes without sending a commit or arming a timer.
    const drainPromise = service.stopGracefully();
    await expect(drainPromise).resolves.toBeUndefined();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(0);
  });

  it("stop with a sub-threshold buffer still drains for an in-flight VAD commit", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    // A VAD commit went out; its transcript hasn't come back yet.
    vadCommitSegment(service, worker);
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(1);

    // Stop with nothing new buffered — no final commit, but the drain must
    // still wait for the outstanding VAD commit's transcript.
    const drainPromise = service.stopGracefully();
    expect(socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit")).toHaveLength(1);

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.simulateMessage("conversation.item.done", {
      item: { content: [{ type: "input_audio", transcript: "tail" }] },
    });
    await drainPromise;
    expect(completes).toEqual(["tail"]);
  });

  it("ignores a duplicate conversation.item.done for the same item during drain", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    // Two outstanding commits: a VAD commit, then a final commit on stop.
    vadCommitSegment(service, worker);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    // Segment A completes, then a DUPLICATE of A arrives — the duplicate must
    // not be counted again (which would settle the drain while B is still in
    // flight) and must not re-emit A's transcript.
    const itemADone = {
      item: { id: "item-A", content: [{ type: "input_audio", transcript: "alpha" }] },
    };
    socket.simulateMessage("conversation.item.done", itemADone);
    socket.simulateMessage("conversation.item.done", itemADone);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(completes).toEqual(["alpha"]);

    // Segment B completes — now every outstanding commit has reported back.
    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-B", content: [{ type: "input_audio", transcript: "beta" }] },
    });
    await drainPromise;
    expect(completes).toEqual(["alpha", "beta"]);
  });

  it("does not let a conversation.item.done without an input_audio part settle the drain", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully(); // one outstanding commit

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    // A `done` with no input_audio content part — not a transcription segment,
    // so it must not be counted against the outstanding commit.
    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-noaudio", content: [{ type: "text" }] },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-real", content: [{ type: "input_audio", transcript: "real" }] },
    });
    await drainPromise;
  });

  it("keeps draining past an empty conversation.item.done and settles on the item's .completed", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    // The intent=transcription endpoint's real ordering: an empty `done` for
    // the item, then deltas, then the authoritative `.completed`.
    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-final", content: [{ type: "input_audio", transcript: "" }] },
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      item_id: "item-final",
      delta: "final words",
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(completes).toEqual([]);

    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-final",
      transcript: "final words",
    });
    await drainPromise;
    expect(completes).toEqual(["final words"]);
  });

  it("falls back to the drain timeout when a segment only ever gets an empty conversation.item.done", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-ws", content: [{ type: "input_audio", transcript: "   " }] },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(3_000);
    await expect(drainPromise).resolves.toBeUndefined();
  });

  it("an empty conversation.item.done for one item does not settle the drain for another", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    vadCommitSegment(service, worker);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully(); // two outstanding commits

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-A", content: [{ type: "input_audio", transcript: "" }] },
    });
    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-B", content: [{ type: "input_audio", transcript: "" }] },
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-A",
      transcript: "alpha",
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-B",
      transcript: "beta",
    });
    await drainPromise;
    expect(completes).toEqual(["alpha", "beta"]);
  });

  it("an empty .completed is terminal: counts its commit without emitting text and dedupes a later done", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    vadCommitSegment(service, worker);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully(); // two outstanding commits

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    // Silence: the server's authoritative verdict is an empty transcript.
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-silent",
      transcript: "",
    });
    // A contradictory later `done` for the same item must neither emit nor
    // count against the other outstanding commit.
    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-silent", content: [{ type: "input_audio", transcript: "late" }] },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    // An identified empty completion carries no text; it only retires the
    // item's preview in the renderer.
    expect(completes).toEqual([""]);

    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-B",
      transcript: "beta",
    });
    await drainPromise;
    expect(completes).toEqual(["", "beta"]);
  });

  it("a text-bearing conversation.item.done counts, and the item's later .completed is deduped", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    vadCommitSegment(service, worker);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully(); // two outstanding commits

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-A", content: [{ type: "input_audio", transcript: "alpha" }] },
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-A",
      transcript: "alpha",
    });
    await Promise.resolve();
    // The duplicate `.completed` must not count against item B's commit.
    expect(settled).toBe(false);
    expect(completes).toEqual(["alpha"]);

    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-B",
      transcript: "beta",
    });
    await drainPromise;
    expect(completes).toEqual(["alpha", "beta"]);
  });

  it("treats transcription.failed as terminal for its item without emitting text", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    vadCommitSegment(service, worker);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully(); // two outstanding commits

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });

    socket.simulateMessage("conversation.item.done", {
      item: { id: "item-A", content: [{ type: "input_audio", transcript: "" }] },
    });
    // A failure without an item id can't be matched to a commit — ignored.
    socket.simulateMessage("conversation.item.input_audio_transcription.failed", {
      error: { code: "transcription_failed" },
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.failed", {
      item_id: "item-A",
      error: { code: "transcription_failed", message: "secret dictated words" },
    });
    // A repeated failure frame must not count twice.
    socket.simulateMessage("conversation.item.input_audio_transcription.failed", {
      item_id: "item-A",
      error: { code: "transcription_failed" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-B",
      transcript: "beta",
    });
    await drainPromise;
    // The failed item retires once with an empty completion; the id-less and
    // repeated failure frames add nothing.
    expect(completes).toEqual(["", "beta"]);
    expect(loggedText()).not.toContain("secret dictated words");
  });

  it("repeated stopGracefully calls share a single in-flight drain", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    feedCommittableAudio(service);

    const first = service.stopGracefully();
    const second = service.stopGracefully();

    // Only one commit is sent, even though stop was called twice.
    const commits = socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit");
    expect(commits).toHaveLength(1);

    socket.simulateMessage("conversation.item.done", {
      item: { content: [{ type: "input_audio", transcript: "ok" }] },
    });
    await Promise.all([first, second]);
  });

  it("stopGracefully without an open connection goes straight to idle", async () => {
    const service = new OpenAITranscriptionProvider();
    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    await service.stopGracefully();
    expect(statuses).toEqual(["idle"]);
  });

  // ── Graceful stop while connecting (#13108) ──────────────────────────────

  describe("stopGracefully before the session is ready", () => {
    function appendedBytes(socket: MockWebSocket): number {
      return socket
        .sentJson()
        .filter((p) => p.type === "input_audio_buffer.append")
        .reduce((sum, p) => sum + Buffer.from(p.audio as string, "base64").byteLength, 0);
    }

    function commitCount(socket: MockWebSocket): number {
      return socket.sentJson().filter((p) => p.type === "input_audio_buffer.commit").length;
    }

    it.each([
      ["before the socket opens", false],
      ["after open but before session.updated", true],
    ])(
      "flushes, commits and transcribes buffered audio when stopped %s",
      async (_label, openFirst) => {
        const service = new OpenAITranscriptionProvider();
        const statuses: string[] = [];
        const completes: string[] = [];
        service.onEvent((e) => {
          if (e.type === "status") statuses.push(e.status);
          if (e.type === "complete") completes.push(e.text);
        });

        const startPromise = service.start(BASE_SETTINGS);
        await Promise.resolve();
        const socket = latestInstance();
        if (openFirst) socket.simulateOpen();
        service.sendAudioChunk(new Uint8Array(2_400).buffer);
        service.sendAudioChunk(new Uint8Array(2_400).buffer);

        const stopPromise = service.stopGracefully();
        expect(statuses.at(-1)).toBe("finishing");
        expect(socket.closeCalls).toBe(0);

        // Audio after the stop (mic already released) must not be kept.
        service.sendAudioChunk(new Uint8Array(2_400).buffer);

        if (!openFirst) socket.simulateOpen();
        socket.simulateMessage("session.updated");
        await expect(startPromise).resolves.toEqual({ ok: true });

        expect(appendedBytes(socket)).toBe(4_800);
        expect(socket.sentJson().map((p) => p.type)).toEqual([
          "session.update",
          "input_audio_buffer.append",
          "input_audio_buffer.append",
          "input_audio_buffer.commit",
        ]);
        expect(statuses).not.toContain("recording");
        expect(vadWorkers).toHaveLength(0);

        socket.simulateMessage("conversation.item.done", {
          item: { id: "item-1", content: [{ type: "input_audio", transcript: "yes do that" }] },
        });
        await stopPromise;

        expect(completes).toEqual(["yes do that"]);
        expect(statuses.at(-1)).toBe("idle");
        expect(socket.closeCalls).toBe(1);
      }
    );

    it("stops immediately when the buffered audio is below the commit floor", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      void service.start(BASE_SETTINGS);
      await Promise.resolve();
      const socket = latestInstance();
      service.sendAudioChunk(new Uint8Array(4_798).buffer);

      await service.stopGracefully();
      expect(statuses).toEqual(["connecting", "idle"]);
      expect(socket.closeCalls).toBe(1);
      expect(commitCount(socket)).toBe(0);
    });

    it("gives up after the connect wait if the session never becomes ready", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      const startPromise = service.start(BASE_SETTINGS);
      await Promise.resolve();
      const socket = latestInstance();
      feedCommittableAudio(service);

      const stopPromise = service.stopGracefully();
      vi.advanceTimersByTime(2_999);
      expect(socket.closeCalls).toBe(0);
      vi.advanceTimersByTime(1);
      await stopPromise;

      expect(statuses.at(-1)).toBe("idle");
      expect(socket.closeCalls).toBe(1);
      await expect(startPromise).resolves.toMatchObject({ ok: false });

      // A late session.updated on the abandoned socket does nothing.
      socket.simulateOpen();
      socket.simulateMessage("session.updated");
      expect(commitCount(socket)).toBe(0);
    });

    it("bounds the transcript wait with the drain timeout once ready", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      void service.start(BASE_SETTINGS);
      await Promise.resolve();
      const socket = latestInstance();
      feedCommittableAudio(service);

      const stopPromise = service.stopGracefully();
      vi.advanceTimersByTime(2_500);
      socket.simulateOpen();
      socket.simulateMessage("session.updated");
      expect(commitCount(socket)).toBe(1);

      // The connect-wait deadline no longer applies; the drain backstop does.
      vi.advanceTimersByTime(2_999);
      expect(statuses.at(-1)).toBe("finishing");
      vi.advanceTimersByTime(1);
      await stopPromise;
      expect(statuses.at(-1)).toBe("idle");
    });

    it("stop() while waiting discards the buffered audio", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      void service.start(BASE_SETTINGS);
      await Promise.resolve();
      const socket = latestInstance();
      feedCommittableAudio(service);

      const stopPromise = service.stopGracefully();
      service.stop();
      await stopPromise;
      expect(statuses.filter((s) => s === "idle")).toHaveLength(1);

      socket.simulateOpen();
      socket.simulateMessage("session.updated");
      expect(appendedBytes(socket)).toBe(0);
      expect(commitCount(socket)).toBe(0);
    });

    it("repeated stops while waiting join the same stop", async () => {
      const service = new OpenAITranscriptionProvider();
      void service.start(BASE_SETTINGS);
      await Promise.resolve();
      const socket = latestInstance();
      feedCommittableAudio(service);

      const first = service.stopGracefully();
      const second = service.stopGracefully();
      socket.simulateOpen();
      socket.simulateMessage("session.updated");
      expect(commitCount(socket)).toBe(1);

      socket.simulateMessage("conversation.item.done", {
        item: { id: "item-1", content: [{ type: "input_audio", transcript: "ok" }] },
      });
      await Promise.all([first, second]);
    });

    it("a transport error and trailing close while waiting settle the stop once", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      void service.start(BASE_SETTINGS);
      await Promise.resolve();
      const socket = latestInstance();
      feedCommittableAudio(service);

      const stopPromise = service.stopGracefully();
      socket.simulateError(new Error("ECONNREFUSED"));
      socket.simulateClose(1006);
      await stopPromise;
      expect(statuses.at(-1)).toBe("idle");
      expect(statuses.filter((s) => s === "idle")).toHaveLength(1);
      vi.advanceTimersByTime(10_000);
      expect(instances).toHaveLength(1);
    });

    it("a server error before session.updated settles the stop", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      void service.start(BASE_SETTINGS);
      await Promise.resolve();
      const socket = latestInstance();
      socket.simulateOpen();
      feedCommittableAudio(service);

      const stopPromise = service.stopGracefully();
      socket.simulateMessage("error", {
        error: { type: "invalid_request_error", code: "invalid_api_key", message: "bad key" },
      });
      await stopPromise;
      expect(statuses.at(-1)).toBe("idle");
      expect(commitCount(socket)).toBe(0);
    });

    it("the original connect timeout firing during the wait settles the stop", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      const startPromise = service.start(BASE_SETTINGS);
      await Promise.resolve();
      vi.advanceTimersByTime(8_000);
      feedCommittableAudio(service);

      const stopPromise = service.stopGracefully();
      vi.advanceTimersByTime(2_000);
      await stopPromise;
      expect(statuses.at(-1)).toBe("idle");
      await expect(startPromise).resolves.toMatchObject({ ok: false });
    });

    it("start() while waiting does not tear down the new session", async () => {
      const service = new OpenAITranscriptionProvider();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      void service.start(BASE_SETTINGS);
      await Promise.resolve();
      feedCommittableAudio(service);
      const stopPromise = service.stopGracefully();

      const { socket: secondSocket, result } = await bringSessionReady(service);
      await stopPromise;

      expect(result).toEqual({ ok: true });
      expect(secondSocket.closeCalls).toBe(0);
      expect(statuses.at(-1)).toBe("recording");
      service.stop();
    });

    it("flushes buffered audio from a reconnect window when stopped during backoff", async () => {
      const service = new OpenAITranscriptionProvider();
      const completes: string[] = [];
      service.onEvent((e) => {
        if (e.type === "complete") completes.push(e.text);
      });

      const { socket } = await bringSessionReady(service);
      socket.simulateClose(1006);
      // Reconnect is scheduled; audio captured in the gap is buffered.
      feedCommittableAudio(service);

      const stopPromise = service.stopGracefully();
      vi.advanceTimersByTime(1_000);
      const reconnectSocket = latestInstance();
      expect(reconnectSocket).not.toBe(socket);
      reconnectSocket.simulateOpen();
      reconnectSocket.simulateMessage("session.updated");
      expect(commitCount(reconnectSocket)).toBe(1);

      reconnectSocket.simulateMessage("conversation.item.done", {
        item: { id: "item-1", content: [{ type: "input_audio", transcript: "after drop" }] },
      });
      await stopPromise;
      expect(completes).toEqual(["after drop"]);
    });
  });

  it("start() during an in-flight drain resolves the old drain and reaches recording", async () => {
    const service = new OpenAITranscriptionProvider();
    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const { socket: firstSocket } = await bringSessionReady(service);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();
    // Don't simulate completion — drain is still in flight when start() runs.

    const secondStart = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const secondSocket = latestInstance();
    secondSocket.simulateOpen();
    secondSocket.simulateMessage("session.updated");
    await secondStart;

    // The first drain resolves once cleanupPreviousSession fires from start().
    await drainPromise;

    // Old commit was sent, new commit was NOT (new session has no drain).
    const commitsOnFirst = firstSocket
      .sentJson()
      .filter((p) => p.type === "input_audio_buffer.commit").length;
    const commitsOnSecond = secondSocket
      .sentJson()
      .filter((p) => p.type === "input_audio_buffer.commit").length;
    expect(commitsOnFirst).toBe(1);
    expect(commitsOnSecond).toBe(0);
    expect(statuses.at(-1)).toBe("recording");
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it("emits error and error status when the WebSocket reports an error", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const startPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const socket = latestInstance();
    socket.simulateOpen();
    socket.simulateError(new Error("network down"));

    await expect(startPromise).resolves.toEqual({ ok: false, error: "network down" });
    expect(events.some((e) => e.type === "error" && /network down/.test(e.error.message))).toBe(
      true
    );
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
  });

  it("propagates server-side error events", async () => {
    const service = new OpenAITranscriptionProvider();
    const errors: string[] = [];
    service.onEvent((e) => {
      if (e.type === "error") errors.push(e.error.message);
    });

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("error", {
      error: { message: "invalid_session_config", type: "invalid_request_error" },
    });

    expect(errors).toContain("invalid_session_config");
  });

  it("parses string message data as well as Buffer", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(service);
    // `ws` can deliver messages as strings when the server sends a text frame.
    socket.simulateRawMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "from string",
      })
    );
    expect(completes).toEqual(["from string"]);
  });

  it("ignores malformed JSON messages without throwing", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    expect(() => socket.simulateRawMessage("not json {")).not.toThrow();

    // Service still functional afterward
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "ok",
    });
    expect(events.some((e) => e.type === "complete")).toBe(true);
  });

  it("fails start when WebSocket construction throws", async () => {
    throwOnConstruct = true;
    constructError = new Error("ECONNREFUSED");
    const service = new OpenAITranscriptionProvider();
    const result = await service.start(BASE_SETTINGS);
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  // ── Reentrancy / stale-session guard ─────────────────────────────────────

  it("ignores transcript events from a stale session", async () => {
    const service = new OpenAITranscriptionProvider();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket: firstSocket } = await bringSessionReady(service);
    // Start a second session; the first socket is now stale.
    const secondPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const secondSocket = latestInstance();
    secondSocket.simulateOpen();
    secondSocket.simulateMessage("session.updated");
    await secondPromise;

    firstSocket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "ghost",
    });

    expect(completes).toEqual([]);
  });

  // ── commitParagraphBoundary ──────────────────────────────────────────────

  it("commitParagraphBoundary resets state and does not touch the WebSocket", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const sentBefore = socket.sent.length;

    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      delta: "Hello",
    });
    service.commitParagraphBoundary();

    expect(socket.sent.length).toBe(sentBefore);
    expect(socket.closeCalls).toBe(0);
  });

  // ── destroy ─────────────────────────────────────────────────────────────

  it("destroy closes the socket and clears listeners", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    service.destroy();
    expect(socket.closeCalls).toBe(1);

    // Listeners cleared: subsequent emits should not reach the recorded array.
    const lengthAtDestroy = events.length;
    // Spawn a brand-new session — the listener from before destroy should be gone.
    const { socket: socket2 } = await bringSessionReady(service);
    socket2.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "after destroy",
    });
    expect(events.length).toBe(lengthAtDestroy);
  });

  // ── Heartbeat (half-open detection) ──────────────────────────────────────

  it("pings on the heartbeat interval once the connection is open", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    expect(socket.pingCalls).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(socket.pingCalls).toBe(1);

    service.stop();
  });

  it("terminates the socket when a heartbeat ping goes unanswered", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    // First tick: ping sent, awaiting pong.
    vi.advanceTimersByTime(20_000);
    expect(socket.pingCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);

    // Second tick: no pong arrived → terminate (not graceful close).
    vi.advanceTimersByTime(20_000);
    expect(socket.terminateCalls).toBe(1);
    expect(socket.closeCalls).toBe(0);

    service.stop();
  });

  it("a pong keeps the connection alive across heartbeat ticks", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    vi.advanceTimersByTime(20_000);
    expect(socket.pingCalls).toBe(1);
    socket.simulatePong();

    vi.advanceTimersByTime(20_000);
    expect(socket.pingCalls).toBe(2);
    expect(socket.terminateCalls).toBe(0);

    service.stop();
  });

  it("a stale connection's heartbeat does not terminate a newer socket", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket: firstSocket } = await bringSessionReady(service);

    // Replace the session — the first socket and its heartbeat are now stale.
    const secondPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const secondSocket = latestInstance();
    secondSocket.simulateOpen();
    secondSocket.simulateMessage("session.updated");
    await secondPromise;

    // The first socket's heartbeat was torn down when the session was replaced;
    // it must never terminate (its sessionId/socket-identity guard would also
    // catch it). The second socket stays alive as long as it pongs.
    vi.advanceTimersByTime(20_000);
    secondSocket.simulatePong();
    vi.advanceTimersByTime(20_000);
    expect(firstSocket.terminateCalls).toBe(0);
    expect(secondSocket.terminateCalls).toBe(0);

    service.stop();
  });

  // ── Reconnection ─────────────────────────────────────────────────────────

  it("reconnects after an unexpected drop and returns to recording", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    socket.simulateClose(1006, Buffer.from("abnormal"));
    expect(statuses).toContain("reconnecting");

    // Backoff timer fires → a fresh socket is opened.
    vi.advanceTimersByTime(3_000);
    const socket2 = latestInstance();
    expect(socket2).not.toBe(socket);

    socket2.simulateOpen();
    socket2.simulateMessage("session.updated");
    expect(statuses.at(-1)).toBe("recording");

    service.stop();
  });

  it("buffers audio captured during the reconnect window and flushes it after reconnect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    socket.simulateClose(1006);

    // Audio keeps flowing while we're reconnecting — it must be buffered, not
    // dropped (connection is null and there's no pending start at this point).
    const chunk = new Uint8Array([7, 7, 7, 7]).buffer;
    service.sendAudioChunk(chunk);

    vi.advanceTimersByTime(3_000);
    const socket2 = latestInstance();
    socket2.simulateOpen();
    socket2.simulateMessage("session.updated");

    const audio = socket2
      .sentJson()
      .filter((p) => p.type === "input_audio_buffer.append")
      .map((p) => p.audio as string);
    expect(audio).toEqual([Buffer.from(chunk).toString("base64")]);

    service.stop();
  });

  it("gives up and emits error after exhausting reconnect attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    const statuses: string[] = [];
    const errors: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
      if (e.type === "error") errors.push(e.error.message);
    });

    // Initial drop schedules attempt 1.
    socket.simulateClose(1006);

    // Each cycle: fire the backoff timer (opens a socket), then drop it again
    // before it can reach session.updated. After RECONNECT_MAX_ATTEMPTS the
    // service gives up.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(3_000);
      latestInstance().simulateClose(1006);
    }

    expect(statuses).toContain("reconnecting");
    expect(statuses).toContain("error");
    expect(errors.some((m) => /reconnect failed/i.test(m))).toBe(true);
  });

  it("a graceful stop during the reconnect window cancels the pending retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    socket.simulateClose(1006);
    const instancesBeforeStop = instances.length;

    service.stop();

    // The backoff timer was cleared by stop() — advancing time opens no socket.
    vi.advanceTimersByTime(3_000);
    expect(instances.length).toBe(instancesBeforeStop);
  });

  it("does not reconnect after a server-side fatal error and ends in error, not idle", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });
    const instancesBefore = instances.length;

    // A server error is fatal: the socket is terminated, the trailing close must
    // not trigger a reconnect, and the final status stays "error" (not "idle").
    socket.simulateMessage("error", {
      error: { message: "invalid_session_config", type: "invalid_request_error" },
    });
    expect(socket.terminateCalls).toBe(1);

    // The terminate() above already fired a close; an extra server close is a
    // no-op for status. Simulate it to be sure idle never leaks through.
    socket.simulateClose(1011);

    vi.advanceTimersByTime(3_000);
    expect(instances.length).toBe(instancesBefore);
    expect(statuses).toContain("error");
    expect(statuses).not.toContain("idle");
  });

  it("enforces the pre-connect buffer byte cap independently of the chunk cap", async () => {
    const service = new OpenAITranscriptionProvider();
    void service.start(BASE_SETTINGS);
    await Promise.resolve();

    // Five 40KB chunks = 200KB, over the 150KB ceiling but well under the
    // 100-chunk cap — only the first chunks that fit under 150KB are kept.
    for (let i = 0; i < 5; i++) {
      service.sendAudioChunk(new Uint8Array(40_000).buffer);
    }
    const socket = latestInstance();
    socket.simulateOpen();
    socket.simulateMessage("session.updated");

    const audioCount = socket
      .sentJson()
      .filter((p) => p.type === "input_audio_buffer.append").length;
    // 3 × 40KB = 120KB fits; a 4th would push to 160KB > 150KB, so it's dropped.
    expect(audioCount).toBe(3);
    service.stop();
  });

  it("retries and gives up when the reconnect socket constructor keeps throwing", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    // Every reconnect attempt's WebSocket construction fails.
    throwOnConstruct = true;
    constructError = new Error("ECONNREFUSED");
    const instancesBefore = instances.length;

    socket.simulateClose(1006);
    // Drive all backoff cycles — each fires the timer, connect() throws, and
    // reschedules until attempts are exhausted.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(3_000);
    }

    expect(instances.length).toBe(instancesBefore);
    expect(statuses).toContain("error");
  });
});

describe("summarizeEchoedSession", () => {
  const SECRET_TERM = "super-secret-branch-name";
  const echoed = {
    audio: {
      input: {
        transcription: {
          model: "gpt-live-transcribe",
          languages: ["en"],
          delay: "low",
          keywords: [SECRET_TERM, "xterm"],
          prompt: `Keywords: ${SECRET_TERM}, xterm`,
        },
        turn_detection: null,
      },
    },
  };

  it("keeps the diagnostic fields that explain a silent session", () => {
    expect(summarizeEchoedSession(echoed)).toEqual({
      model: "gpt-live-transcribe",
      languages: ["en"],
      delay: "low",
      biasTermCount: 2,
      hasPrompt: true,
      turnDetectionNull: true,
    });
  });

  it("reduces a non-scalar model/delay to a type marker instead of forwarding it", () => {
    // Config fields are forwarded for diagnostics, so an unexpected echo shape
    // must not become a channel for arbitrary content reaching the log.
    const hostile = {
      audio: {
        input: {
          transcription: {
            model: { leaked: SECRET_TERM },
            languages: [{ leaked: SECRET_TERM }],
            delay: ["a", "b"],
          },
          turn_detection: null,
        },
      },
    };
    expect(JSON.stringify(summarizeEchoedSession(hostile))).not.toContain(SECRET_TERM);
  });

  it("reduces an oversized model string to a length marker", () => {
    const hostile = {
      audio: {
        input: {
          transcription: { model: `${SECRET_TERM}${"x".repeat(500)}` },
          turn_detection: null,
        },
      },
    };
    expect(JSON.stringify(summarizeEchoedSession(hostile))).not.toContain(SECRET_TERM);
  });

  it("does not throw on a transcription of the wrong type", () => {
    for (const transcription of ["nope", 42, [], null]) {
      const payload = { audio: { input: { transcription, turn_detection: null } } };
      expect(() => summarizeEchoedSession(payload)).not.toThrow();
    }
  });

  it("never leaks keyword or prompt contents", () => {
    // These logs are readable by agents; keyterms carry the user's branch names,
    // project terms, custom dictionary and terminal output.
    expect(JSON.stringify(summarizeEchoedSession(echoed))).not.toContain(SECRET_TERM);
  });

  it("reports a non-null turn_detection so a server-applied VAD default is visible", () => {
    const withVad = {
      audio: { input: { transcription: { model: "m" }, turn_detection: { type: "server_vad" } } },
    };
    expect(summarizeEchoedSession(withVad).turnDetectionNull).toBe(false);
  });

  it("reports hasPrompt false for an absent or empty prompt", () => {
    const noPrompt = {
      audio: { input: { transcription: { model: "m", prompt: "" }, turn_detection: null } },
    };
    expect(summarizeEchoedSession(noPrompt)).toMatchObject({ hasPrompt: false, biasTermCount: 0 });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
  ])("degrades safely when the session is %s", (_label, session) => {
    expect(summarizeEchoedSession(session)).toEqual({ session: "(absent)" });
  });

  it("degrades safely when audio.input is missing", () => {
    expect(summarizeEchoedSession({ id: "sess_1" })).toEqual({ sessionShape: "(no audio.input)" });
  });
});

describe("OpenAITranscriptionProvider start timing diagnostics", () => {
  let now = 0;

  beforeEach(() => {
    instances.length = 0;
    throwOnConstruct = false;
    constructError = null;
    vadWorkers.length = 0;
    throwOnVadConstruct = false;
    logCalls.length = 0;
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
    now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    for (const worker of vadWorkers) worker.emitExit(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function logDetails(fragment: string): Record<string, unknown>[] {
    return logCalls
      .filter(([message]) => typeof message === "string" && message.includes(fragment))
      .map(([, details]) => details as Record<string, unknown>);
  }

  it("times socket open and session.updated from provider start", async () => {
    const service = new OpenAITranscriptionProvider();
    const startPromise = service.start(BASE_SETTINGS);
    await Promise.resolve();
    const socket = latestInstance();
    now = 1_250;
    socket.simulateOpen();
    now = 1_400;
    socket.simulateMessage("session.updated");
    await startPromise;

    expect(logDetails("WebSocket opened")).toEqual([
      expect.objectContaining({ connectMs: 250, sinceStartMs: 250 }),
    ]);
    expect(logDetails("session.updated — session ready")).toEqual([
      expect.objectContaining({ sinceStartMs: 400 }),
    ]);
    service.stop();
  });

  it("logs the first transcript once per session, by length only", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);

    now = 3_000;
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", { delta: " " });
    expect(logDetails("First transcript")).toHaveLength(0);

    now = 3_100;
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      delta: "PRIVATE_DICTATION",
    });
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      delta: " more",
    });

    expect(logDetails("First transcript")).toEqual([
      expect.objectContaining({ eventType: "delta", length: 17, sinceStartMs: 2_100 }),
    ]);
    expect(loggedText()).not.toContain("PRIVATE_DICTATION");

    const { socket: nextSocket } = await bringSessionReady(service);
    nextSocket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      delta: "again",
    });
    expect(logDetails("First transcript")).toHaveLength(2);
    service.stop();
  });

  it("keeps session timing and the first-transcript marker across a reconnect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", { delta: "one" });

    now = 10_000;
    socket.simulateClose(1006, Buffer.from("abnormal"));
    vi.advanceTimersByTime(3_000);
    const socket2 = latestInstance();
    expect(socket2).not.toBe(socket);
    now = 10_200;
    socket2.simulateOpen();
    socket2.simulateMessage("session.updated");
    socket2.simulateMessage("conversation.item.input_audio_transcription.delta", { delta: "two" });

    expect(logDetails("WebSocket opened").at(-1)).toMatchObject({
      connectMs: 200,
      sinceStartMs: 9_200,
    });
    expect(logDetails("First transcript")).toHaveLength(1);
    service.stop();
  });
});

describe("OpenAITranscriptionProvider — item identity and ordering (#13109)", () => {
  beforeEach(() => {
    instances.length = 0;
    throwOnConstruct = false;
    constructError = null;
    vadWorkers.length = 0;
    throwOnVadConstruct = false;
    logCalls.length = 0;
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const worker of vadWorkers) worker.emitExit(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function done(itemId: string, transcript: string): Record<string, unknown> {
    return { item: { id: itemId, content: [{ type: "input_audio", transcript }] } };
  }

  function completions(events: VoiceTranscriptionEvent[]) {
    return events.flatMap((e) =>
      e.type === "complete" ? [{ text: e.text, itemId: e.itemId }] : []
    );
  }

  it("forwards the item id on deltas", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      item_id: "item-A",
      delta: "hello",
    });

    expect(events.find((e) => e.type === "delta")).toEqual({
      type: "delta",
      text: "hello",
      itemId: "item-A",
    });
  });

  it("releases completions in commit order when a later item finishes first", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", {
      item_id: "item-B",
      previous_item_id: "item-A",
    });

    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    expect(completions(events)).toEqual([]);

    socket.simulateMessage("conversation.item.done", done("item-A", "first"));
    expect(completions(events)).toEqual([
      { text: "first", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("emits an in-order completion immediately", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-A", "first"));

    expect(completions(events)).toEqual([{ text: "first", itemId: "item-A" }]);
  });

  it("emits a completion for an unacknowledged item without waiting", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("conversation.item.done", done("item-X", "orphan"));

    expect(completions(events)).toEqual([{ text: "orphan", itemId: "item-X" }]);
  });

  it("retires an identified empty completion and unblocks later items", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-A",
      transcript: "   ",
    });

    expect(completions(events)).toEqual([
      { text: "", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("an empty conversation.item.done neither completes nor unblocks its item", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    // The transcription endpoint's placeholder `done` precedes the real result.
    socket.simulateMessage("conversation.item.done", done("item-A", ""));
    expect(completions(events)).toEqual([]);

    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      item_id: "item-A",
      transcript: "first",
    });
    expect(completions(events)).toEqual([
      { text: "first", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("releases held completions when the drain times out on a missing predecessor", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    vadCommitSegment(service, worker);
    feedCommittableAudio(service);
    const drainPromise = service.stopGracefully();

    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    expect(completions(events)).toEqual([]);

    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      item_id: "item-A",
      delta: "partial first",
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await drainPromise;
    // A never reported back: it is settled with its interim text in its own
    // slot, so the draft still reads A before B.
    expect(completions(events)).toEqual([
      { text: "partial first", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("settles a stuck predecessor after the hold timeout while recording", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-C" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(completions(events)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    // Only the stuck head is settled; C is still genuinely in flight.
    expect(completions(events)).toEqual([
      { text: "", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);

    // A's real completion arriving late is a duplicate and is ignored.
    socket.simulateMessage("conversation.item.done", done("item-A", "late"));
    socket.simulateMessage("conversation.item.done", done("item-C", "third"));
    expect(completions(events)).toEqual([
      { text: "", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
      { text: "third", itemId: "item-C" },
    ]);
  });

  it("does not let later completions postpone the hold deadline", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-C" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    await vi.advanceTimersByTimeAsync(4_000);
    socket.simulateMessage("conversation.item.done", done("item-C", "third"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(completions(events)).toEqual([
      { text: "", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
      { text: "third", itemId: "item-C" },
    ]);
  });

  it("settles the drain when a failed predecessor releases the last outstanding commit", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    const worker = latestVadWorker();
    vadCommitSegment(service, worker);
    vadCommitSegment(service, worker);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));

    const drainPromise = service.stopGracefully();
    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.simulateMessage("conversation.item.input_audio_transcription.failed", {
      item_id: "item-A",
    });
    await drainPromise;
    expect(completions(events)).toEqual([
      { text: "", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("treats a failed transcription as an empty completion that unblocks later items", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    socket.simulateMessage("conversation.item.input_audio_transcription.failed", {
      item_id: "item-A",
      error: { code: "transcription_failed", message: "boom" },
    });

    expect(completions(events)).toEqual([
      { text: "", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
    expect(loggedText()).not.toContain("boom");
  });

  it("ignores an id-less transcription.failed on the ordered path", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    socket.simulateMessage("conversation.item.input_audio_transcription.failed", {
      error: { code: "transcription_failed" },
    });
    expect(completions(events)).toEqual([]);

    socket.simulateMessage("conversation.item.done", done("item-A", "first"));
    expect(completions(events)).toEqual([
      { text: "first", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("drops a delta for an item that already completed", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("conversation.item.done", done("item-A", "first"));
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      item_id: "item-A",
      delta: "late",
    });

    expect(events.filter((e) => e.type === "delta")).toEqual([]);
  });

  it("releases held completions when stopping with nothing left to drain", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));

    await service.stopGracefully();
    expect(completions(events)).toEqual([
      { text: "", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("releases held completions in order when the connection drops", async () => {
    const service = new OpenAITranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      item_id: "item-A",
      delta: "partial",
    });
    socket.simulateMessage("conversation.item.done", done("item-B", "second"));
    socket.simulateClose(1006);

    expect(completions(events)).toEqual([
      { text: "partial", itemId: "item-A" },
      { text: "second", itemId: "item-B" },
    ]);
  });

  it("keeps dictated text out of logs on the ordered path", async () => {
    const service = new OpenAITranscriptionProvider();
    const { socket } = await bringSessionReady(service);
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-A" });
    socket.simulateMessage("input_audio_buffer.committed", { item_id: "item-B" });
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", {
      item_id: "item-B",
      delta: "SECRET-DELTA",
    });
    socket.simulateMessage("conversation.item.done", done("item-B", "SECRET-B"));
    socket.simulateMessage("conversation.item.done", done("item-A", "SECRET-A"));

    expect(loggedText()).not.toContain("SECRET");
  });
});
