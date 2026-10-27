import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings } from "../../../../shared/types/ipc/api.js";

// The provider imports `WebSocket from "ws"` for the Authorization header. The
// mock records text control frames (Finalize / audio.done) and binary audio
// frames, and lets a test play the server's side of the protocol.

interface MockOptions {
  headers: Record<string, string>;
}

type WsListener = (...args: unknown[]) => void;

class MockWebSocket {
  url: string;
  options: MockOptions;
  sent: Array<string | Buffer> = [];
  closeCalls = 0;
  terminateCalls = 0;

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

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  send(payload: string | Buffer): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCalls++;
  }

  terminate(): void {
    this.terminateCalls++;
    this.fire("close", 1006, undefined);
  }

  simulateOpen(): void {
    this.fire("open");
  }

  simulateMessage(payload: Record<string, unknown>): void {
    this.fire("message", Buffer.from(JSON.stringify(payload)));
  }

  simulateRawMessage(data: string | Buffer): void {
    this.fire("message", data);
  }

  /** Opens the socket and has the server say the session is ready. */
  simulateReady(): void {
    this.simulateOpen();
    this.simulateMessage({ type: "transcript.created" });
  }

  simulateError(err: Error = new Error("WebSocket error")): void {
    this.fire("error", err);
  }

  unexpectedReq?: { socket: { destroy: ReturnType<typeof vi.fn> } };
  unexpectedRes?: { statusCode: number; resume: ReturnType<typeof vi.fn> };

  simulateUnexpectedResponse(statusCode: number): void {
    const req = { socket: { destroy: vi.fn() } };
    const res = { statusCode, resume: vi.fn() };
    this.unexpectedReq = req;
    this.unexpectedRes = res;
    this.fire("unexpected-response", req, res);
  }

  simulateClose(code?: number, reason?: Buffer | string): void {
    this.fire("close", code, reason);
  }

  textFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  binaryFrames(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
  }

  keyterms(): string[] {
    return new URL(this.url).searchParams.getAll("keyterm");
  }
}

const instances: MockWebSocket[] = [];
let throwOnConstruct = false;

vi.mock("ws", () => {
  const ctor = function (this: unknown, url: string, options: MockOptions) {
    if (throwOnConstruct) throw new Error("WebSocket construction failed");
    return new MockWebSocket(url, options);
  } as unknown as new (url: string, options: MockOptions) => MockWebSocket;
  return { default: ctor };
});

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const { GrokTranscriptionProvider, sanitizeGrokKeyterms } =
  await import("../GrokTranscriptionProvider.js");
const { AUDIO_BUFFER_MAX_CHUNKS } = await import("../TranscriptionProvider.js");
const { VOICE_STOP_AUDIO_LOST_CODE } = await import("../../../../shared/types/voice.js");
const logger = await import("../../../utils/logger.js");
type GrokProvider = InstanceType<typeof GrokTranscriptionProvider>;
type VoiceTranscriptionEvent = import("../TranscriptionProvider.js").VoiceTranscriptionEvent;

const BASE_SETTINGS: VoiceInputSettings = {
  enabled: true,
  openaiApiKey: "",
  deepgramApiKey: "",
  xaiApiKey: "xai-test",
  language: "en",
  dictionary: [],
  transcriptionProvider: "grok",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionModel: "gpt-6-luna",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  deviceLabel: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [],
  dismissedSuggestions: [],
  learnFromCorrections: true,
};

// 24kHz PCM16 mono: 4,800 bytes is 100ms.
const CHUNK_BYTES = 4_800;

function latestInstance(): MockWebSocket {
  const instance = instances.at(-1);
  if (!instance) throw new Error("No MockWebSocket instance created");
  return instance;
}

function setup(): { provider: GrokProvider; events: VoiceTranscriptionEvent[] } {
  const provider = new GrokTranscriptionProvider();
  const events: VoiceTranscriptionEvent[] = [];
  provider.onEvent((e) => events.push(e));
  return { provider, events };
}

async function bringSessionReady(
  provider: GrokProvider,
  settings: VoiceInputSettings = BASE_SETTINGS
): Promise<MockWebSocket> {
  const startPromise = provider.start(settings, "session-1");
  const socket = latestInstance();
  socket.simulateReady();
  await expect(startPromise).resolves.toEqual({ ok: true });
  return socket;
}

function partial(
  text: string,
  flags: {
    is_final?: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
    words?: unknown;
  } = {}
) {
  return {
    type: "transcript.partial",
    text,
    is_final: flags.is_final ?? false,
    speech_final: flags.speech_final ?? false,
    ...(flags.start !== undefined ? { start: flags.start } : {}),
    ...(flags.duration !== undefined ? { duration: flags.duration } : {}),
    words: flags.words ?? [],
  };
}

function chunkFinal(text: string, start: number, duration: number, words?: unknown) {
  return partial(text, { is_final: true, start, duration, words });
}

function utteranceFinal(text: string, start: number, duration: number, words?: unknown) {
  return partial(text, { is_final: true, speech_final: true, start, duration, words });
}

/**
 * Words as xAI sends them: `text` scored `confidence`, timed one after another
 * from `start`. A confidence of 0 is left out, as xAI leaves it out.
 */
function scoredWords(start: number, ...scored: Array<[text: string, confidence: number]>) {
  return scored.map(([text, confidence], i) => ({
    text,
    start: start + i * 0.3,
    end: start + (i + 1) * 0.3,
    ...(confidence !== 0 ? { confidence } : {}),
  }));
}

function unsureWords(complete: { text: string; uncertain?: Array<{ from: number; to: number }> }) {
  return (complete.uncertain ?? []).map(({ from, to }) => complete.text.slice(from, to));
}

/** 100ms of PCM at a constant level: 0 is silence, 3,000 is well above speech level. */
function pcm(amplitude: number): ArrayBuffer {
  return new Int16Array(CHUNK_BYTES / 2).fill(amplitude).buffer;
}

function statusesOf(events: VoiceTranscriptionEvent[]): string[] {
  return events.flatMap((e) => (e.type === "status" ? [e.status] : []));
}

function completesOf(events: VoiceTranscriptionEvent[]) {
  return events.filter(
    (e): e is Extract<VoiceTranscriptionEvent, { type: "complete" }> => e.type === "complete"
  );
}

function deltasOf(events: VoiceTranscriptionEvent[]) {
  return events.filter(
    (e): e is Extract<VoiceTranscriptionEvent, { type: "delta" }> => e.type === "delta"
  );
}

function fatalErrorsOf(events: VoiceTranscriptionEvent[]) {
  return events.flatMap((e) => (e.type === "error" && e.error.severity === "fatal" ? [e] : []));
}

function speechStartsOf(events: VoiceTranscriptionEvent[]): number {
  return events.filter((e) => e.type === "speech_started").length;
}

describe("GrokTranscriptionProvider", () => {
  beforeEach(() => {
    instances.length = 0;
    throwOnConstruct = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("connecting", () => {
    it("fails to start when no xAI API key is configured", async () => {
      const { provider } = setup();
      const result = await provider.start({ ...BASE_SETTINGS, xaiApiKey: "" }, "session-1");
      expect(result).toEqual({ ok: false, error: "xAI API key not configured" });
      expect(instances).toHaveLength(0);
    });

    it("opens the dedicated STT endpoint with Bearer auth and 24kHz PCM", async () => {
      const { provider } = setup();
      void provider.start(BASE_SETTINGS, "session-1");
      const socket = latestInstance();
      const url = new URL(socket.url);
      expect(`${url.origin}${url.pathname}`).toBe("wss://api.x.ai/v1/stt");
      expect(socket.options.headers.Authorization).toBe("Bearer xai-test");
      const params = url.searchParams;
      expect(params.get("model")).toBe("grok-voice-transcribe-2.0");
      expect(params.get("encoding")).toBe("pcm");
      expect(params.get("sample_rate")).toBe("24000");
      expect(params.get("interim_results")).toBe("true");
      expect(params.get("endpointing")).toBe("300");
      provider.stop();
    });

    it("formats text only for a language xAI formats, and detects the language on auto", async () => {
      const cases: Array<[string, string | null, string | null]> = [
        ["en", "en", "true"],
        ["ko", "ko", null],
        ["auto", null, null],
      ];
      for (const [language, expectedLanguage, expectedFormat] of cases) {
        const { provider } = setup();
        void provider.start({ ...BASE_SETTINGS, language }, "session-1");
        const params = new URL(latestInstance().url).searchParams;
        expect(params.get("language")).toBe(expectedLanguage);
        expect(params.get("format")).toBe(expectedFormat);
        provider.stop();
      }
    });

    it("holds audio after the socket opens until the server says the session is ready", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start(BASE_SETTINGS, "session-1");
      const socket = latestInstance();
      provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
      socket.simulateOpen();
      provider.sendAudioChunk(new Uint8Array([2, 2]).buffer);
      expect(socket.binaryFrames()).toHaveLength(0);
      expect(statusesOf(events)).not.toContain("recording");

      socket.simulateMessage({ type: "transcript.created" });
      await expect(startPromise).resolves.toEqual({ ok: true });
      expect(socket.binaryFrames().map((b) => [...b])).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(statusesOf(events).at(-1)).toBe("recording");

      provider.sendAudioChunk(new Uint8Array([3, 3]).buffer);
      expect(
        socket
          .binaryFrames()
          .map((b) => [...b])
          .at(-1)
      ).toEqual([3, 3]);
      provider.stop();
    });

    it("ignores a repeated transcript.created", async () => {
      const { provider } = setup();
      const socket = await bringSessionReady(provider);
      provider.sendAudioChunk(new Uint8Array([1]).buffer);
      socket.simulateMessage({ type: "transcript.created" });
      expect(socket.binaryFrames()).toHaveLength(1);
      provider.stop();
    });

    it("times out a socket that opens but never becomes ready", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start(BASE_SETTINGS, "session-1");
      latestInstance().simulateOpen();
      vi.advanceTimersByTime(10_000);
      await expect(startPromise).resolves.toEqual({ ok: false, error: "Connection timed out" });
      expect(fatalErrorsOf(events)[0]?.error.code).toBe("connection_timeout");
      expect(statusesOf(events).at(-1)).toBe("error");
    });

    it("fails start when the socket can't be constructed", async () => {
      throwOnConstruct = true;
      const { provider, events } = setup();
      const result = await provider.start(BASE_SETTINGS, "session-1");
      expect(result.ok).toBe(false);
      expect(fatalErrorsOf(events)[0]?.error.code).toBe("ws_construct_failed");
    });

    it("ends the session on a bad key", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start(BASE_SETTINGS, "session-1");
      const socket = latestInstance();
      socket.simulateUnexpectedResponse(401);
      await expect(startPromise).resolves.toMatchObject({ ok: false });
      expect(socket.unexpectedRes?.resume).toHaveBeenCalled();
      expect(socket.unexpectedReq?.socket.destroy).toHaveBeenCalled();
      expect(fatalErrorsOf(events)[0]?.error.message).toBe(
        "Grok rejected the connection (HTTP 401)"
      );
      expect(instances).toHaveLength(1);
    });

    it("ends the session on a transport error before the first ready", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start(BASE_SETTINGS, "session-1");
      latestInstance().simulateError(new Error("getaddrinfo ENOTFOUND api.x.ai"));
      await expect(startPromise).resolves.toMatchObject({ ok: false });
      expect(fatalErrorsOf(events)[0]?.error.code).toBe("ws_transport_error");
    });

    it("caps the audio held while connecting and counts what it refuses", async () => {
      const { provider, events } = setup();
      void provider.start(BASE_SETTINGS, "session-1");
      for (let i = 0; i < AUDIO_BUFFER_MAX_CHUNKS + 5; i++) {
        provider.sendAudioChunk(new ArrayBuffer(10));
      }
      expect(provider.getSessionStats()).toMatchObject({ droppedConnect: 5, delayTier: "none" });
      expect(events.filter((e) => e.type === "error")).toHaveLength(1);
      latestInstance().simulateReady();
      expect(latestInstance().binaryFrames()).toHaveLength(AUDIO_BUFFER_MAX_CHUNKS);
      provider.stop();
    });

    it("logs the keyterm count, never the URL", async () => {
      const { provider } = setup();
      vi.mocked(logger.logInfo).mockClear();
      void provider.start({ ...BASE_SETTINGS, keyterms: ["alpha", "beta"] }, "session-1");
      const openCall = vi
        .mocked(logger.logInfo)
        .mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("Opening Grok"));
      expect((openCall?.[1] as Record<string, unknown>).keytermCount).toBe(2);
      for (const call of vi.mocked(logger.logInfo).mock.calls) {
        expect(JSON.stringify(call)).not.toContain("api.x.ai/v1/stt?");
        expect(JSON.stringify(call)).not.toContain("alpha");
      }
      provider.stop();
    });
  });

  describe("keyterms", () => {
    it("sends one repeated keyterm param per term, in priority order", async () => {
      const { provider } = setup();
      void provider.start({ ...BASE_SETTINGS, keyterms: ["Zustand", "new line", "a&b"] }, "s");
      expect(latestInstance().keyterms()).toEqual(["Zustand", "new line", "a&b"]);
      provider.stop();
    });

    it("omits the param when there are no keyterms", async () => {
      const { provider } = setup();
      void provider.start(BASE_SETTINGS, "s");
      expect(new URL(latestInstance().url).searchParams.has("keyterm")).toBe(false);
      provider.stop();
    });

    it("skips blank terms and terms over xAI's 50 characters, keeping later ones", () => {
      const long = "x".repeat(51);
      expect(sanitizeGrokKeyterms(["  ", long, " fits ", "y".repeat(50)])).toEqual([
        "fits",
        "y".repeat(50),
      ]);
    });

    it("stays within xAI's 100 terms and a bounded query string", () => {
      const many = Array.from({ length: 150 }, (_, i) => `term${i}`);
      expect(sanitizeGrokKeyterms(many)).toEqual(many.slice(0, 100));
      // Nine encoded bytes per CJK character: a full list of these can't fit.
      const wide = Array.from({ length: 100 }, (_, i) => `${"漢".repeat(20)}${i}`);
      const kept = sanitizeGrokKeyterms(wide);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(100);
      expect(kept).toEqual(wide.slice(0, kept.length));
      const query = new URLSearchParams(kept.map((term) => ["keyterm", term])).toString();
      expect(query.length).toBeLessThanOrEqual(6_000);
    });

    it("reports the terms the ready session carried", async () => {
      const { provider, events } = setup();
      await bringSessionReady(provider, { ...BASE_SETTINGS, keyterms: ["alpha", "x".repeat(60)] });
      expect(events.find((e) => e.type === "terms_sent")).toEqual({
        type: "terms_sent",
        terms: ["alpha"],
        keytermAttempt: "full",
      });
      provider.stop();
    });

    it("retries an HTTP 400 with the head of the list, then with none", async () => {
      const terms = Array.from({ length: 30 }, (_, i) => `term${i}`);
      const { provider, events } = setup();
      const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: terms }, "s");
      latestInstance().simulateUnexpectedResponse(400);
      expect(latestInstance().keyterms()).toEqual(terms.slice(0, 20));
      latestInstance().simulateUnexpectedResponse(400);
      expect(latestInstance().keyterms()).toEqual([]);
      latestInstance().simulateReady();
      await expect(startPromise).resolves.toEqual({ ok: true });
      expect(instances).toHaveLength(3);
      expect(events.find((e) => e.type === "terms_sent")).toMatchObject({
        terms: [],
        keytermAttempt: "none",
      });
      expect(fatalErrorsOf(events)).toHaveLength(0);
      provider.stop();
    });

    it("skips the trimmed retry when the list is already short", async () => {
      const { provider } = setup();
      void provider.start({ ...BASE_SETTINGS, keyterms: ["alpha", "beta"] }, "s");
      latestInstance().simulateUnexpectedResponse(400);
      expect(instances).toHaveLength(2);
      expect(latestInstance().keyterms()).toEqual([]);
      provider.stop();
    });

    it("retries when the server rejects the terms with an error before the session is ready", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: ["alpha"] }, "s");
      const first = latestInstance();
      first.simulateOpen();
      first.simulateMessage({ type: "error", message: "invalid keyterm" });
      expect(first.terminateCalls).toBe(1);
      expect(latestInstance().keyterms()).toEqual([]);
      latestInstance().simulateReady();
      await expect(startPromise).resolves.toEqual({ ok: true });
      expect(fatalErrorsOf(events)).toHaveLength(0);
      provider.stop();
    });

    it("ends the session on an HTTP 400 that no keyterm can explain", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start(BASE_SETTINGS, "s");
      latestInstance().simulateUnexpectedResponse(400);
      await expect(startPromise).resolves.toMatchObject({ ok: false });
      expect(instances).toHaveLength(1);
      expect(fatalErrorsOf(events)[0]?.error.code).toBe("ws_http_error");
    });

    it("ends the session on an error before ready once the terms are gone", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start(BASE_SETTINGS, "s");
      latestInstance().simulateOpen();
      latestInstance().simulateMessage({ type: "error", message: "model unavailable" });
      await expect(startPromise).resolves.toEqual({ ok: false, error: "model unavailable" });
      expect(fatalErrorsOf(events)[0]?.error).toMatchObject({
        code: "grok_server_error",
        message: "model unavailable",
      });
    });

    it("keeps a reduced list on reconnect, and doesn't blame accepted terms for a later rejection", async () => {
      const terms = Array.from({ length: 30 }, (_, i) => `term${i}`);
      const { provider, events } = setup();
      const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: terms }, "s");
      latestInstance().simulateUnexpectedResponse(400);
      latestInstance().simulateReady();
      await startPromise;
      latestInstance().simulateClose(1006);
      vi.advanceTimersToNextTimer();
      expect(latestInstance().keyterms()).toEqual(terms.slice(0, 20));
      // These terms already opened a session, so a 400 now isn't about them.
      latestInstance().simulateUnexpectedResponse(400);
      expect(fatalErrorsOf(events)[0]?.error.code).toBe("ws_http_error");
    });
  });

  describe("utterances", () => {
    it("shows chunk-relative interims and chunk finals as one preview, completed once by the stitched final", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("the quick", { start: 0, duration: 1 }));
      socket.simulateMessage(chunkFinal("The quick brown fox", 0, 3));
      socket.simulateMessage(partial("jumps over", { start: 3, duration: 1 }));
      socket.simulateMessage(chunkFinal("jumps over the lazy dog.", 3, 2.8));
      socket.simulateMessage(
        utteranceFinal("The quick brown fox jumps over the lazy dog.", 0, 5.8)
      );

      const deltas = deltasOf(events);
      expect(deltas.map((d) => d.text)).toEqual([
        "the quick",
        "The quick brown fox",
        "The quick brown fox jumps over",
        "The quick brown fox jumps over the lazy dog.",
      ]);
      expect(new Set(deltas.map((d) => d.itemId)).size).toBe(1);
      expect(deltas.every((d) => d.replace === true)).toBe(true);
      expect(completesOf(events)).toEqual([
        {
          type: "complete",
          text: "The quick brown fox jumps over the lazy dog.",
          itemId: deltas[0].itemId,
          endOfSpeech: true,
        },
      ]);
      provider.stop();
    });

    it("handles interims that restate the utterance so far without repeating text", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(chunkFinal("one two three", 0, 3));
      socket.simulateMessage(partial("one two three four", { start: 0, duration: 3.5 }));
      expect(deltasOf(events).at(-1)?.text).toBe("one two three four");
      socket.simulateMessage(chunkFinal("one two three four five six", 0, 6));
      expect(deltasOf(events).at(-1)?.text).toBe("one two three four five six");
      socket.simulateMessage(utteranceFinal("One two three four five six.", 0, 6.4));
      expect(completesOf(events).map((c) => c.text)).toEqual(["One two three four five six."]);
      provider.stop();
    });

    it("still loses nothing if an utterance final covers only its last span", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(chunkFinal("first part", 0, 3));
      socket.simulateMessage(utteranceFinal("second part", 3, 1.2));
      expect(completesOf(events).map((c) => c.text)).toEqual(["first part second part"]);
      provider.stop();
    });

    it("keeps a repeated word the speaker said", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(chunkFinal("that that", 0, 3));
      socket.simulateMessage(utteranceFinal("that that is", 0, 4));
      socket.simulateMessage(utteranceFinal("is it", 4.5, 1));
      expect(completesOf(events).map((c) => c.text)).toEqual(["that that is", "is it"]);
      provider.stop();
    });

    it("gives each utterance its own item", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("hello", { start: 0, duration: 0.5 }));
      socket.simulateMessage(utteranceFinal("Hello.", 0, 0.6));
      socket.simulateMessage(partial("again", { start: 1.2, duration: 0.4 }));
      socket.simulateMessage(utteranceFinal("Again.", 1.2, 0.5));
      const [first, second] = completesOf(events);
      expect(first.itemId).toBe(deltasOf(events)[0].itemId);
      expect(second.itemId).toBe(deltasOf(events)[1].itemId);
      expect(first.itemId).not.toBe(second.itemId);
      provider.stop();
    });

    it("completes an utterance final that arrives without any preview", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(utteranceFinal("Quick one.", 0, 0.5));
      const [complete] = completesOf(events);
      expect(complete).toMatchObject({ text: "Quick one.", endOfSpeech: true });
      expect(complete.itemId).toMatch(/^grok-/);
      provider.stop();
    });

    it("reports an empty utterance final as a bare end of speech", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(utteranceFinal("", 0, 0.5));
      expect(completesOf(events)).toEqual([{ type: "complete", text: "", endOfSpeech: true }]);
      provider.stop();
    });

    it("retracts a preview revised to nothing, and retires it when its final is empty", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("um", { start: 0, duration: 0.3 }));
      socket.simulateMessage(partial("", { start: 0, duration: 0.4 }));
      expect(deltasOf(events).at(-1)?.text).toBe("");
      socket.simulateMessage(utteranceFinal("", 0, 0.5));
      expect(completesOf(events)).toEqual([
        { type: "complete", text: "", itemId: deltasOf(events)[0].itemId, endOfSpeech: true },
      ]);
      provider.stop();
    });

    it("doesn't show an empty interim before any text", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("", { start: 0, duration: 0.3 }));
      expect(deltasOf(events)).toHaveLength(0);
      provider.stop();
    });

    it("never reuses an item id across providers", async () => {
      const a = setup();
      const b = setup();
      const first = await bringSessionReady(a.provider);
      first.simulateMessage(utteranceFinal("one", 0, 0.5));
      const second = await bringSessionReady(b.provider);
      second.simulateMessage(utteranceFinal("two", 0, 0.5));
      expect(completesOf(a.events)[0].itemId).not.toBe(completesOf(b.events)[0].itemId);
      a.provider.stop();
      b.provider.stop();
    });

    it("ignores malformed results and non-JSON messages without touching the preview", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("kept", { start: 0, duration: 0.5 }));
      socket.simulateMessage({ type: "transcript.partial", is_final: true });
      socket.simulateMessage({ type: "transcript.partial", text: "x" });
      socket.simulateMessage({ type: "transcript.partial", text: 5, is_final: true });
      socket.simulateRawMessage("not json");
      socket.simulateMessage({ type: "something.new", text: "secret" });
      expect(deltasOf(events).map((d) => d.text)).toEqual(["kept"]);
      expect(completesOf(events)).toHaveLength(0);
      socket.simulateMessage(utteranceFinal("Kept.", 0, 0.6));
      expect(completesOf(events)[0]).toMatchObject({
        text: "Kept.",
        itemId: deltasOf(events)[0].itemId,
      });
      provider.stop();
    });

    it("sends Finalize for an Enter mid-utterance, and doesn't treat its final as a pause", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      for (let i = 0; i < 10; i++) provider.sendAudioChunk(pcm(0));
      socket.simulateMessage(partial("write the tests", { start: 0, duration: 1 }));
      provider.commitParagraphBoundary();
      expect(socket.textFrames()).toEqual([{ type: "Finalize" }]);
      socket.simulateMessage(utteranceFinal("Write the tests.", 0, 1));
      expect(completesOf(events)).toEqual([
        { type: "complete", text: "Write the tests.", itemId: deltasOf(events)[0].itemId },
      ]);
      // The next utterance ends at a pause again.
      socket.simulateMessage(utteranceFinal("Then send it.", 2, 1));
      expect(completesOf(events).at(-1)).toMatchObject({ endOfSpeech: true });
      provider.stop();
    });

    it("treats a final forced before any preview as Enter's, however late it lands", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      provider.sendAudioChunk(pcm(3_000));
      provider.commitParagraphBoundary();
      vi.advanceTimersByTime(5_000);
      socket.simulateMessage(utteranceFinal("Fix it, send it.", 0, 0.1));
      expect(completesOf(events)[0]).toEqual({
        type: "complete",
        text: "Fix it, send it.",
        itemId: expect.stringMatching(/^grok-/),
      });
      provider.stop();
    });

    it("takes two Enters on one utterance as one forced final", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      for (let i = 0; i < 5; i++) provider.sendAudioChunk(pcm(0));
      socket.simulateMessage(partial("one", { start: 0, duration: 0.3 }));
      provider.commitParagraphBoundary();
      provider.commitParagraphBoundary();
      socket.simulateMessage(utteranceFinal("One.", 0, 0.4));
      socket.simulateMessage(utteranceFinal("Two.", 0.6, 0.4));
      expect(completesOf(events).map((c) => c.endOfSpeech === true)).toEqual([false, true]);
      provider.stop();
    });

    it("an Enter with nothing open leaves the next utterance's pause intact", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      for (let i = 0; i < 5; i++) provider.sendAudioChunk(pcm(0));
      provider.commitParagraphBoundary();
      provider.sendAudioChunk(pcm(3_000));
      socket.simulateMessage(utteranceFinal("Send it.", 0.5, 0.1));
      expect(completesOf(events)[0]).toMatchObject({ text: "Send it.", endOfSpeech: true });
      provider.stop();
    });

    it("an Enter the server never answered doesn't take a later utterance's pause", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      // Noise the onset guard took for speech, then Enter: nothing to finalise.
      provider.sendAudioChunk(pcm(3_000));
      provider.commitParagraphBoundary();
      for (let i = 0; i < 10; i++) provider.sendAudioChunk(pcm(0));
      socket.simulateMessage(utteranceFinal("Send it.", 0.4, 0.6));
      expect(completesOf(events)[0]).toMatchObject({ text: "Send it.", endOfSpeech: true });
      provider.stop();
    });

    it("doesn't send Finalize before the session is ready", async () => {
      const { provider } = setup();
      void provider.start(BASE_SETTINGS, "s");
      latestInstance().simulateOpen();
      provider.commitParagraphBoundary();
      expect(latestInstance().textFrames()).toEqual([]);
      provider.stop();
    });

    it("runs no client-side commit timer", async () => {
      const { provider } = setup();
      expect(provider.hasServerVAD).toBe(true);
      const socket = await bringSessionReady(provider);
      provider.sendAudioChunk(pcm(0));
      vi.advanceTimersByTime(2_000);
      expect(socket.textFrames()).toEqual([]);
      provider.stop();
    });
  });

  describe("unsure words", () => {
    it("flags the final's low-confidence words by position, punctuation left outside", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      const words = scoredWords(0, ["Test", 0.97], ["foo", 0.93], ["test", 0.31], ["bar.", 0.2]);
      socket.simulateMessage(
        partial("Test foo test", { start: 0, duration: 0.9, words: words.slice(0, 3) })
      );
      socket.simulateMessage(utteranceFinal(" Test foo test bar. ", 0, 1.2, words));

      const deltas = deltasOf(events);
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).not.toHaveProperty("uncertain");
      const [complete] = completesOf(events);
      expect(complete.text).toBe("Test foo test bar.");
      expect(unsureWords(complete)).toEqual(["test", "bar"]);
      expect(complete.uncertain?.[0]).toEqual({ from: 9, to: 13 });
      provider.stop();
    });

    it.each([
      ["every word was heard confidently", scoredWords(0, ["Ship", 0.99], ["it.", 0.98])],
      ["the result has no words", undefined],
      ["the words aren't a list", { text: "Ship", confidence: 0.1 }],
      ["no word carries a confidence", [{ text: "Ship" }, { text: "it." }]],
      ["the words don't spell out the transcript", scoredWords(0, ["Shipping", 0.1])],
      [
        "a confidence isn't a number",
        [
          { text: "Ship", confidence: "0.1" },
          { text: "it.", confidence: 0.9 },
        ],
      ],
      ["the only confidence is below 0", [{ text: "Ship", confidence: -0.2 }, { text: "it." }]],
      ["the only confidence is above 1", [{ text: "Ship", confidence: 1.4 }, { text: "it." }]],
    ])("sends a final with no unsure words when %s", async (_name, words) => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage({ ...utteranceFinal("Ship it.", 0, 0.6), words });

      const completes = completesOf(events);
      expect(completes).toHaveLength(1);
      expect(completes[0]).not.toHaveProperty("uncertain");
      provider.stop();
    });

    it("flags a word scored 0, whether xAI sent the score or left it out", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      const words = [
        { text: "Deploy", start: 0, end: 0.3, confidence: 0.95 },
        { text: "kubectl", start: 0.3, end: 0.6 },
        { text: "to", start: 0.6, end: 0.7, confidence: 0 },
        { text: "prod.", start: 0.7, end: 1, confidence: 0.9 },
      ];
      socket.simulateMessage(utteranceFinal("Deploy kubectl to prod.", 0, 1, words));
      expect(unsureWords(completesOf(events)[0])).toEqual(["kubectl", "to"]);
      provider.stop();
    });

    it("tags a repeated word only where it was flagged", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      const words = scoredWords(0, ["that", 0.9], ["that", 0.2], ["is", 0.95]);
      socket.simulateMessage(utteranceFinal("that that is", 0, 0.9, words));
      expect(completesOf(events)[0].uncertain).toEqual([{ from: 5, to: 9 }]);
      provider.stop();
    });

    it("keeps an early chunk's flags on its own words when the final covers only its last span", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(
        chunkFinal("first part", 0, 3, scoredWords(0, ["first", 0.4], ["part", 0.9]))
      );
      socket.simulateMessage(
        chunkFinal("middle part", 3, 3, scoredWords(3, ["middle", 0.9], ["part", 0.92]))
      );
      socket.simulateMessage(
        utteranceFinal("last part", 6, 1, scoredWords(6, ["last", 0.95], ["part", 0.3]))
      );

      const [complete] = completesOf(events);
      expect(complete.text).toBe("first part middle part last part");
      expect(complete.uncertain).toEqual([
        { from: 0, to: 5 },
        { from: 28, to: 32 },
      ]);
      provider.stop();
    });

    it("scores restated chunks by the final that restates them", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(
        chunkFinal("one two", 0, 2, scoredWords(0, ["one", 0.95], ["two", 0.3]))
      );
      socket.simulateMessage(
        utteranceFinal(
          "One, two, three.",
          0,
          3,
          scoredWords(0, ["One,", 0.96], ["two,", 0.9], ["three.", 0.4])
        )
      );
      const [complete] = completesOf(events);
      expect(complete.text).toBe("One, two, three.");
      expect(unsureWords(complete)).toEqual(["three"]);
      provider.stop();
    });

    it("scores a chunk final that restates an earlier one by its own words", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(
        chunkFinal("one two", 0, 2, scoredWords(0, ["one", 0.95], ["two", 0.3]))
      );
      socket.simulateMessage(
        chunkFinal(
          "one two three",
          0,
          3,
          scoredWords(0, ["one", 0.95], ["two", 0.9], ["three", 0.4])
        )
      );
      socket.simulateClose(1008);

      const [complete] = completesOf(events);
      expect(complete).toMatchObject({ text: "one two three", incomplete: true });
      expect(complete.uncertain).toEqual([{ from: 8, to: 13 }]);
    });

    it("keeps a carried chunk's flags across a drop", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      for (let i = 0; i < 40; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      first.simulateMessage(
        chunkFinal(
          "before the drop",
          0,
          3,
          scoredWords(0, ["before", 0.2], ["the", 0.99], ["drop", 0.9])
        )
      );
      first.simulateClose(1006);

      vi.advanceTimersToNextTimer();
      const second = latestInstance();
      second.simulateReady();
      second.simulateMessage(
        utteranceFinal(
          "the drop and after.",
          0,
          1.5,
          scoredWords(0, ["the", 0.97], ["drop", 0.5], ["and", 0.9], ["after.", 0.9])
        )
      );

      const [complete] = completesOf(events);
      expect(complete.text).toBe("before the drop the drop and after.");
      expect(complete.uncertain).toEqual([
        { from: 0, to: 6 },
        { from: 20, to: 24 },
      ]);
      provider.stop();
    });

    it("flags only transcript.done's tail words, where a word the finals already landed repeats", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(
        utteranceFinal("Said once.", 0, 0.6, scoredWords(0, ["Said", 0.9], ["once.", 0.2]))
      );
      socket.simulateMessage(partial("said twice", { start: 1, duration: 0.6 }));
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({
        type: "transcript.done",
        text: "Said once. Said twice.",
        words: [
          ...scoredWords(0, ["Said", 0.95], ["once.", 0.2]),
          ...scoredWords(1, ["Said", 0.25], ["twice.", 0.9]),
        ],
      });
      await stopPromise;

      const [first, tail] = completesOf(events);
      expect(unsureWords(first)).toEqual(["once"]);
      expect(tail).toMatchObject({ text: "Said twice.", endOfSpeech: true });
      expect(tail.uncertain).toEqual([{ from: 0, to: 4 }]);
    });

    it("reads a tail word's missing score as 0 when only words the finals landed carry one", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(utteranceFinal("Okay.", 0, 0.3, scoredWords(0, ["Okay.", 0.9])));
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({
        type: "transcript.done",
        words: [
          { text: "Okay.", start: 0, end: 0.3, confidence: 0.9 },
          { text: "then", start: 0.3, end: 0.6 },
        ],
      });
      await stopPromise;

      const [, tail] = completesOf(events);
      expect(tail).toMatchObject({ text: "then", endOfSpeech: true });
      expect(tail.uncertain).toEqual([{ from: 0, to: 4 }]);
    });

    it("lands transcript.done's tail flags after the flags of text carried across a drop", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      for (let i = 0; i < 40; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      first.simulateMessage(
        chunkFinal("carried over", 0, 3, scoredWords(0, ["carried", 0.3], ["over", 0.9]))
      );
      first.simulateClose(1006);

      vi.advanceTimersToNextTimer();
      const second = latestInstance();
      second.simulateReady();
      second.simulateMessage(partial("and the", { start: 0, duration: 0.6 }));
      const stopPromise = provider.stopGracefully();
      second.simulateMessage({
        type: "transcript.done",
        text: "and the tail",
        words: scoredWords(0, ["and", 0.9], ["the", 0.9], ["tail", 0]),
      });
      await stopPromise;

      const [complete] = completesOf(events);
      expect(complete).toMatchObject({ text: "carried over and the tail", endOfSpeech: true });
      expect(unsureWords(complete)).toEqual(["carried", "tail"]);
      expect(complete.uncertain?.[1]).toEqual({ from: 21, to: 25 });
    });

    it("keeps the locked chunks' flags on a preview that lands incomplete", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(
        chunkFinal(
          "use the new line",
          0,
          3,
          scoredWords(0, ["use", 0.9], ["the", 0.9], ["new", 0.3], ["line", 0.9])
        )
      );
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({ type: "transcript.done", text: "use the new line helper" });
      await stopPromise;

      const [complete] = completesOf(events);
      expect(complete).toMatchObject({ text: "use the new line", incomplete: true });
      expect(unsureWords(complete)).toEqual(["new"]);
    });

    it("keeps only the latest interim's flags on a preview a failure settles", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(
        chunkFinal("deploy kubectl", 0, 2, scoredWords(0, ["deploy", 0.9], ["kubectl", 0.3]))
      );
      socket.simulateMessage(
        partial("to stagin", {
          start: 2,
          duration: 0.6,
          words: scoredWords(2, ["to", 0.9], ["stagin", 0.2]),
        })
      );
      socket.simulateMessage(
        partial("to staging now", {
          start: 2,
          duration: 0.9,
          words: scoredWords(2, ["to", 0.9], ["staging", 0.95], ["now", 0.4]),
        })
      );
      socket.simulateClose(1008);

      const [complete] = completesOf(events);
      expect(complete).toMatchObject({ text: "deploy kubectl to staging now", incomplete: true });
      expect(complete.uncertain).toEqual([
        { from: 7, to: 14 },
        { from: 26, to: 29 },
      ]);
      expect(fatalErrorsOf(events)).toHaveLength(1);
    });

    it("keeps carried and interim flags on a preview a failure after a drop settles", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      for (let i = 0; i < 40; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      first.simulateMessage(
        chunkFinal("carried over", 0, 3, scoredWords(0, ["carried", 0.3], ["over", 0.9]))
      );
      first.simulateClose(1006);

      vi.advanceTimersToNextTimer();
      const second = latestInstance();
      second.simulateReady();
      second.simulateMessage(
        partial("then this", {
          start: 0,
          duration: 0.6,
          words: scoredWords(0, ["then", 0.9], ["this", 0.2]),
        })
      );
      second.simulateClose(1008);

      const [complete] = completesOf(events);
      expect(complete).toMatchObject({ text: "carried over then this", incomplete: true });
      expect(complete.uncertain).toEqual([
        { from: 0, to: 7 },
        { from: 18, to: 22 },
      ]);
    });

    it("never logs a flagged word", async () => {
      const { provider, events } = setup();
      const loggers = [logger.logDebug, logger.logInfo, logger.logWarn, logger.logError];
      for (const log of loggers) vi.mocked(log).mockClear();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(
        chunkFinal("Zanzibar first", 0, 2, scoredWords(0, ["Zanzibar", 0.1], ["first", 0.9]))
      );
      socket.simulateMessage(
        utteranceFinal("then Quixotic.", 2, 1, scoredWords(2, ["then", 0.9], ["Quixotic.", 0.1]))
      );
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({
        type: "transcript.done",
        words: scoredWords(3, ["Xylophone", 0.1]),
      });
      await stopPromise;

      expect(completesOf(events).flatMap(unsureWords)).toEqual([
        "Zanzibar",
        "Quixotic",
        "Xylophone",
      ]);
      const logged = JSON.stringify(loggers.flatMap((log) => vi.mocked(log).mock.calls));
      for (const word of ["Zanzibar", "Quixotic", "Xylophone"]) {
        expect(logged).not.toContain(word);
      }
    });
  });

  describe("stopping", () => {
    it("sends audio.done and drains until transcript.done, keeping the last utterance", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("last words", { start: 0, duration: 1 }));
      const stopPromise = provider.stopGracefully();
      expect(socket.textFrames()).toEqual([{ type: "audio.done" }]);
      expect(statusesOf(events).at(-1)).toBe("finishing");
      provider.sendAudioChunk(pcm(3_000));
      expect(socket.binaryFrames()).toHaveLength(0);

      socket.simulateMessage(utteranceFinal("Last words.", 0, 1.2));
      socket.simulateMessage({ type: "transcript.done", text: "Last words.", duration: 1.2 });
      await stopPromise;
      expect(completesOf(events).map((c) => c.text)).toEqual(["Last words."]);
      expect(statusesOf(events).at(-1)).toBe("idle");
    });

    it("finishes an utterance the server never finalised with transcript.done's own words for it", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(utteranceFinal("First thought.", 0, 1));
      socket.simulateMessage(chunkFinal("second", 1.5, 3));
      socket.simulateMessage(partial("thou", { start: 4.5, duration: 0.3 }));
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({
        type: "transcript.done",
        text: "First thought. Second thought.",
        words: [
          { text: "First", start: 0.1, end: 0.4 },
          { text: "thought.", start: 0.4, end: 0.9 },
          { text: "Second", start: 1.6, end: 2 },
          { text: "thought.", start: 4.5, end: 4.9 },
        ],
      });
      await stopPromise;
      expect(completesOf(events)).toEqual([
        expect.objectContaining({ text: "First thought.", endOfSpeech: true }),
        {
          type: "complete",
          text: "Second thought.",
          itemId: deltasOf(events).at(-1)?.itemId,
          endOfSpeech: true,
        },
      ]);
    });

    it("keeps a tail word that starts exactly where the last final ended", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      // 0.1 + 0.2 is 0.30000000000000004 in float seconds.
      socket.simulateMessage(utteranceFinal("Okay.", 0.1, 0.2));
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({
        type: "transcript.done",
        words: [
          { text: "Okay.", start: 0.1, end: 0.3 },
          { text: "Then", start: 0.3, end: 0.5 },
          { text: "this.", start: 0.5, end: 0.8 },
        ],
      });
      await stopPromise;
      expect(completesOf(events).map((c) => c.text)).toEqual(["Okay.", "Then this."]);
    });

    it("lands transcript.done's tail even when no preview ever showed it", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({
        type: "transcript.done",
        text: "Hello world",
        words: [
          { text: "Hello", start: 0, end: 0.3 },
          { text: "world", start: 0.3, end: 0.6 },
        ],
      });
      await stopPromise;
      expect(completesOf(events)).toEqual([
        {
          type: "complete",
          text: "Hello world",
          itemId: expect.stringMatching(/^grok-/),
          endOfSpeech: true,
        },
      ]);
    });

    it("keeps the preview, incomplete, when transcript.done names no words", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(chunkFinal("use the new line", 0, 3));
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({ type: "transcript.done", text: "use the new line helper" });
      await stopPromise;
      expect(completesOf(events)).toEqual([
        {
          type: "complete",
          text: "use the new line",
          itemId: deltasOf(events)[0].itemId,
          incomplete: true,
        },
      ]);
    });

    it("lands what the preview showed, incomplete, when the stream closes before the final", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(chunkFinal("locked", 0, 3));
      socket.simulateMessage(partial("maybe this", { start: 3, duration: 0.6 }));
      const stopPromise = provider.stopGracefully();
      socket.simulateClose(1000);
      await stopPromise;
      expect(completesOf(events)).toEqual([
        {
          type: "complete",
          text: "locked maybe this",
          itemId: deltasOf(events)[0].itemId,
          incomplete: true,
        },
      ]);
    });

    it("resolves the drain after its backstop if the server never answers", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("hanging", { start: 0, duration: 1 }));
      const stopPromise = provider.stopGracefully();
      vi.advanceTimersByTime(3_000);
      await stopPromise;
      expect(completesOf(events)[0]).toMatchObject({ text: "hanging", incomplete: true });
      expect(statusesOf(events).at(-1)).toBe("idle");
      expect(socket.closeCalls).toBe(1);
    });

    it("settles the drain when the server errors during it", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      const stopPromise = provider.stopGracefully();
      socket.simulateMessage({ type: "error", message: "stream ended" });
      await stopPromise;
      expect(statusesOf(events).at(-1)).toBe("idle");
      expect(instances).toHaveLength(1);
      expect(fatalErrorsOf(events)).toHaveLength(0);
    });

    it("joins a second graceful stop to the drain already running", async () => {
      const { provider } = setup();
      const socket = await bringSessionReady(provider);
      const first = provider.stopGracefully();
      const second = provider.stopGracefully();
      socket.simulateMessage({ type: "transcript.done" });
      await Promise.all([first, second]);
      expect(socket.textFrames()).toEqual([{ type: "audio.done" }]);
    });

    it("goes straight to idle with no connection", async () => {
      const { provider, events } = setup();
      await provider.stopGracefully();
      expect(statusesOf(events)).toEqual(["idle"]);
    });

    it("waits for a session still connecting, flushes what it held, then drains", async () => {
      const { provider, events } = setup();
      const startPromise = provider.start(BASE_SETTINGS, "s");
      const socket = latestInstance();
      provider.sendAudioChunk(new Uint8Array([7, 7]).buffer);
      const stopPromise = provider.stopGracefully();
      socket.simulateReady();
      await expect(startPromise).resolves.toEqual({ ok: true });
      expect(socket.binaryFrames().map((b) => [...b])).toEqual([[7, 7]]);
      expect(socket.textFrames()).toEqual([{ type: "audio.done" }]);
      expect(statusesOf(events)).not.toContain("recording");
      socket.simulateMessage(utteranceFinal("Seven.", 0, 0.1));
      socket.simulateMessage({ type: "transcript.done" });
      await stopPromise;
      expect(completesOf(events).map((c) => c.text)).toEqual(["Seven."]);
      expect(events.some((e) => e.type === "error")).toBe(false);
    });

    it("tells the user when a session that never became ready took the held audio with it", async () => {
      const { provider, events } = setup();
      void provider.start(BASE_SETTINGS, "s");
      latestInstance().simulateOpen();
      for (let i = 0; i < 20; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      const stopPromise = provider.stopGracefully();
      vi.advanceTimersByTime(3_000);
      await stopPromise;
      const reports = events.flatMap((e) =>
        e.type === "error" && e.error.code === VOICE_STOP_AUDIO_LOST_CODE ? [e.error.message] : []
      );
      expect(reports).toEqual([
        "Grok wasn't connected when dictation stopped, so up to 2 seconds at the end may be missing.",
      ]);
      expect(statusesOf(events).at(-1)).toBe("idle");
    });

    it("doesn't tear down a session started during the drain", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      const stopPromise = provider.stopGracefully();
      void provider.start(BASE_SETTINGS, "session-2");
      const next = latestInstance();
      next.simulateReady();
      socket.simulateMessage({ type: "transcript.done" });
      await stopPromise;
      expect(statusesOf(events).at(-1)).toBe("recording");
      provider.sendAudioChunk(new Uint8Array([1]).buffer);
      expect(next.binaryFrames()).toHaveLength(1);
      provider.stop();
    });

    it("stop() discards what it held and the open utterance", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      socket.simulateMessage(partial("cancel me", { start: 0, duration: 1 }));
      provider.stop();
      expect(completesOf(events)).toHaveLength(0);
      expect(statusesOf(events).at(-1)).toBe("idle");
      expect(socket.closeCalls).toBe(1);
    });
  });

  describe("reconnecting", () => {
    it("reconnects after a drop and resends the unconfirmed and gap audio", async () => {
      const { provider, events } = setup();
      const settings = { ...BASE_SETTINGS, keyterms: ["alpha"] };
      const first = await bringSessionReady(provider, settings);
      provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
      first.simulateClose(1006);
      expect(statusesOf(events).at(-1)).toBe("reconnecting");
      provider.sendAudioChunk(new Uint8Array([2, 2]).buffer);

      vi.advanceTimersToNextTimer();
      const second = latestInstance();
      expect(second.url).toBe(first.url);
      expect(second.options.headers.Authorization).toBe("Bearer xai-test");
      second.simulateOpen();
      expect(second.binaryFrames()).toHaveLength(0);
      second.simulateMessage({ type: "transcript.created" });
      expect(second.binaryFrames().map((b) => [...b])).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(statusesOf(events).at(-1)).toBe("recording");
      expect(provider.getSessionStats().reconnects).toBe(1);
      expect(fatalErrorsOf(events)).toHaveLength(0);
      provider.stop();
    });

    it("resends only the audio past the last chunk final", async () => {
      const { provider } = setup();
      const first = await bringSessionReady(provider);
      provider.sendAudioChunk(new Uint8Array(CHUNK_BYTES).fill(1).buffer);
      provider.sendAudioChunk(new Uint8Array(CHUNK_BYTES).fill(2).buffer);
      provider.sendAudioChunk(new Uint8Array(CHUNK_BYTES).fill(3).buffer);
      first.simulateMessage(chunkFinal("hello", 0, 0.15));
      first.simulateClose(1006);

      vi.advanceTimersToNextTimer();
      latestInstance().simulateReady();
      const resent = latestInstance().binaryFrames();
      expect(resent.map((b) => b.length)).toEqual([2_400, 4_800]);
      expect(resent[0].every((byte) => byte === 2)).toBe(true);
      expect(resent[1].every((byte) => byte === 3)).toBe(true);
      provider.stop();
    });

    it("carries an utterance's locked text across a drop, with no word lost or repeated", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      for (let i = 0; i < 40; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      first.simulateMessage(chunkFinal("before the drop", 0, 3));
      first.simulateMessage(partial("in flight", { start: 3, duration: 0.8 }));
      first.simulateClose(1006);

      vi.advanceTimersToNextTimer();
      const second = latestInstance();
      second.simulateReady();
      // Only the second after the lock went again.
      expect(second.binaryFrames().reduce((sum, b) => sum + b.length, 0)).toBe(CHUNK_BYTES * 10);
      second.simulateMessage(partial("in flight", { start: 0, duration: 0.8 }));
      expect(deltasOf(events).at(-1)?.text).toBe("before the drop in flight");
      second.simulateMessage(utteranceFinal("in flight and after.", 0, 1.5));

      const itemIds = new Set(deltasOf(events).map((d) => d.itemId));
      expect(itemIds.size).toBe(1);
      expect(completesOf(events)).toEqual([
        {
          type: "complete",
          text: "before the drop in flight and after.",
          itemId: [...itemIds][0],
          endOfSpeech: true,
        },
      ]);
      provider.stop();
    });

    it("recovers from a server error on a ready session the way it recovers from a drop", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      provider.sendAudioChunk(new Uint8Array([4, 4]).buffer);
      first.simulateMessage({ type: "error", message: "stream timeout" });
      expect(first.terminateCalls).toBe(1);
      expect(statusesOf(events).at(-1)).toBe("reconnecting");
      vi.advanceTimersToNextTimer();
      latestInstance().simulateReady();
      expect(
        latestInstance()
          .binaryFrames()
          .map((b) => [...b])
      ).toEqual([[4, 4]]);
      expect(fatalErrorsOf(events)).toHaveLength(0);
      provider.stop();
    });

    it("reconnects after the server closes an idle session normally", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      first.simulateClose(1000);
      expect(statusesOf(events).at(-1)).toBe("reconnecting");
      provider.stop();
    });

    it("ends the session when the server closes it for bad audio", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      first.simulateClose(1003, Buffer.from("unsupported data"));
      expect(fatalErrorsOf(events)[0]?.error).toMatchObject({
        code: "ws_close_1003",
        message: "Grok closed the connection: unsupported data",
      });
      expect(instances).toHaveLength(1);
    });

    it("retries rate limits and server faults on a reconnect, but not a revoked key", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      first.simulateClose(1006);
      vi.advanceTimersToNextTimer();
      latestInstance().simulateUnexpectedResponse(503);
      vi.advanceTimersToNextTimer();
      latestInstance().simulateUnexpectedResponse(429);
      vi.advanceTimersToNextTimer();
      expect(instances).toHaveLength(4);
      expect(fatalErrorsOf(events)).toHaveLength(0);
      latestInstance().simulateUnexpectedResponse(401);
      expect(fatalErrorsOf(events)[0]?.error.code).toBe("ws_http_error");
    });

    it("gives up after the recovery window with the last failure", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      const droppedAt = performance.now();
      first.simulateClose(1006);
      for (let i = 0; i < 100 && fatalErrorsOf(events).length === 0; i++) {
        vi.advanceTimersToNextTimer();
        latestInstance().simulateUnexpectedResponse(503);
      }
      const [fatal] = fatalErrorsOf(events);
      expect(fatal.error).toMatchObject({
        code: "reconnect_exhausted",
        message: "Couldn't reconnect to Grok: Grok rejected the connection (HTTP 503)",
      });
      expect(performance.now() - droppedAt).toBeLessThan(35_000);
      const attempts = instances.length;
      vi.advanceTimersByTime(60_000);
      expect(instances).toHaveLength(attempts);
      void provider;
    });

    it("doesn't grant a fresh window to a session that fails as soon as it is ready", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      const droppedAt = performance.now();
      first.simulateClose(1006);
      for (let i = 0; i < 200 && fatalErrorsOf(events).length === 0; i++) {
        vi.advanceTimersToNextTimer();
        const attempt = latestInstance();
        attempt.simulateReady();
        attempt.simulateMessage({ type: "error", message: "backend failure" });
      }
      expect(fatalErrorsOf(events)[0]?.error).toMatchObject({
        code: "reconnect_exhausted",
        message: "Couldn't reconnect to Grok: backend failure",
      });
      expect(performance.now() - droppedAt).toBeLessThan(35_000);
      void provider;
    });

    it("gives a connection that stayed up a fresh recovery window", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const { provider, events } = setup();
      let socket = await bringSessionReady(provider);
      for (let round = 0; round < 3; round++) {
        socket.simulateClose(1006);
        vi.advanceTimersToNextTimer();
        socket = latestInstance();
        socket.simulateReady();
        vi.advanceTimersByTime(25_000);
      }
      socket.simulateClose(1006);
      expect(statusesOf(events).at(-1)).toBe("reconnecting");
      expect(fatalErrorsOf(events)).toHaveLength(0);
      provider.stop();
    });

    it("stop() during a reconnect cancels the pending attempt", async () => {
      const { provider } = setup();
      const first = await bringSessionReady(provider);
      first.simulateClose(1006);
      provider.stop();
      vi.advanceTimersByTime(10_000);
      expect(instances).toHaveLength(1);
    });

    it("a graceful stop during a reconnect makes the attempt now and resends before draining", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      provider.sendAudioChunk(new Uint8Array([5, 5]).buffer);
      first.simulateClose(1006);
      const stopPromise = provider.stopGracefully();
      expect(instances).toHaveLength(2);
      const second = latestInstance();
      second.simulateReady();
      expect(second.binaryFrames().map((b) => [...b])).toEqual([[5, 5]]);
      expect(second.textFrames()).toEqual([{ type: "audio.done" }]);
      second.simulateMessage({ type: "transcript.done" });
      await stopPromise;
      expect(statusesOf(events).at(-1)).toBe("idle");
    });

    it("a reconnect attempt that fails settles a waiting stop instead of retrying", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      for (let i = 0; i < 10; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      first.simulateClose(1006);
      const stopPromise = provider.stopGracefully();
      latestInstance().simulateUnexpectedResponse(503);
      await stopPromise;
      expect(
        events.some((e) => e.type === "error" && e.error.code === VOICE_STOP_AUDIO_LOST_CODE)
      ).toBe(true);
      const attempts = instances.length;
      vi.advanceTimersByTime(60_000);
      expect(instances).toHaveLength(attempts);
    });

    it("settles the open utterance ahead of a fatal error", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      first.simulateMessage(chunkFinal("said so far", 0, 3));
      first.simulateClose(1008);
      const completeAt = events.findIndex((e) => e.type === "complete");
      const errorAt = events.findIndex((e) => e.type === "error");
      // Locked words, but the utterance hadn't ended: none of them is a command.
      expect(completesOf(events)[0]).toEqual({
        type: "complete",
        text: "said so far",
        itemId: deltasOf(events)[0].itemId,
        incomplete: true,
      });
      expect(completeAt).toBeLessThan(errorAt);
    });

    it("resends nothing an utterance final already covered", async () => {
      const { provider } = setup();
      const first = await bringSessionReady(provider);
      for (let i = 0; i < 10; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      provider.sendAudioChunk(new Uint8Array(CHUNK_BYTES).fill(6).buffer);
      // The first second, as one utterance with no chunk final before it.
      first.simulateMessage(utteranceFinal("Done.", 0, 1));
      first.simulateClose(1006);
      vi.advanceTimersToNextTimer();
      latestInstance().simulateReady();
      const resent = latestInstance().binaryFrames();
      expect(resent).toHaveLength(1);
      expect(resent[0].every((byte) => byte === 6)).toBe(true);
      provider.stop();
    });

    it("holds the gap audio of a long outage, within the replay ledger's cap", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      first.simulateClose(1006);
      // 20s said during the outage: more than start-up's 15s, all of it kept.
      for (let i = 0; i < 200; i++) provider.sendAudioChunk(new ArrayBuffer(CHUNK_BYTES));
      expect(provider.getSessionStats().droppedConnect).toBe(0);
      expect(events.some((e) => e.type === "error")).toBe(false);
      vi.advanceTimersToNextTimer();
      latestInstance().simulateReady();
      expect(latestInstance().binaryFrames()).toHaveLength(200);
      provider.stop();
    });

    it("drops the oldest held audio once no final has covered 40s of it", async () => {
      const { provider } = setup();
      const first = await bringSessionReady(provider);
      for (let i = 0; i < 405; i++) {
        provider.sendAudioChunk(new Uint8Array(CHUNK_BYTES).fill(i % 200).buffer);
      }
      expect(provider.getSessionStats().droppedReplay).toBe(5);
      first.simulateClose(1006);
      vi.advanceTimersToNextTimer();
      latestInstance().simulateReady();
      const resent = latestInstance().binaryFrames();
      expect(resent).toHaveLength(400);
      expect(resent[0][0]).toBe(5);
      provider.stop();
    });

    it("gives a connection that transcribed something a fresh window, however short it lived", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const { provider, events } = setup();
      let socket = await bringSessionReady(provider);
      const droppedAt = performance.now();
      socket.simulateClose(1006);
      // Burn most of the window on failed attempts.
      while (performance.now() - droppedAt < 25_000) {
        vi.advanceTimersToNextTimer();
        latestInstance().simulateUnexpectedResponse(503);
      }
      vi.advanceTimersToNextTimer();
      socket = latestInstance();
      socket.simulateReady();
      socket.simulateMessage(partial("still here", { start: 0, duration: 0.5 }));
      vi.advanceTimersByTime(1_000);
      socket.simulateClose(1006);
      // Past the first window's deadline, still recovering.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersToNextTimer();
        latestInstance().simulateUnexpectedResponse(503);
      }
      expect(performance.now() - droppedAt).toBeGreaterThan(30_000);
      expect(fatalErrorsOf(events)).toHaveLength(0);
      provider.stop();
    });

    it("doesn't give up before the window is out", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      const droppedAt = performance.now();
      first.simulateClose(1006);
      for (let i = 0; i < 100 && fatalErrorsOf(events).length === 0; i++) {
        vi.advanceTimersToNextTimer();
        latestInstance().simulateUnexpectedResponse(503);
      }
      expect(performance.now() - droppedAt).toBeGreaterThanOrEqual(30_000);
      void provider;
    });
  });

  describe("keep-alive", () => {
    it("fills a pause in the audio with a frame of silence", async () => {
      const { provider } = setup();
      const socket = await bringSessionReady(provider);
      provider.sendAudioChunk(pcm(0));
      vi.advanceTimersByTime(2_000);
      expect(socket.binaryFrames()).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      const frames = socket.binaryFrames();
      expect(frames).toHaveLength(2);
      expect(frames[1].length).toBe(CHUNK_BYTES);
      expect(frames[1].every((byte) => byte === 0)).toBe(true);
      // Audio flowing again holds it off.
      provider.sendAudioChunk(pcm(0));
      vi.advanceTimersByTime(2_000);
      expect(socket.binaryFrames()).toHaveLength(3);
      provider.stop();
    });

    it("counts the silence in result timing, so a resend starts at the right audio", async () => {
      const { provider } = setup();
      const first = await bringSessionReady(provider);
      vi.advanceTimersByTime(3_000);
      expect(first.binaryFrames()).toHaveLength(1);
      provider.sendAudioChunk(new Uint8Array(CHUNK_BYTES).fill(9).buffer);
      // The server's clock includes the silence: 0-100ms is the keep-alive frame.
      first.simulateMessage(chunkFinal("", 0, 0.1));
      first.simulateClose(1006);
      vi.advanceTimersToNextTimer();
      latestInstance().simulateReady();
      const resent = latestInstance().binaryFrames();
      expect(resent).toHaveLength(1);
      expect(resent[0].every((byte) => byte === 9)).toBe(true);
      provider.stop();
    });

    it("stops after stop()", async () => {
      const { provider } = setup();
      const socket = await bringSessionReady(provider);
      provider.stop();
      vi.advanceTimersByTime(10_000);
      expect(socket.binaryFrames()).toHaveLength(0);
    });
  });

  describe("speech onset", () => {
    it("reports speech starting after a quiet spell, once per onset", async () => {
      const { provider, events } = setup();
      await bringSessionReady(provider);
      provider.sendAudioChunk(pcm(0));
      expect(speechStartsOf(events)).toBe(0);
      provider.sendAudioChunk(pcm(3_000));
      provider.sendAudioChunk(pcm(3_000));
      expect(speechStartsOf(events)).toBe(1);
      // 300ms of quiet re-arms it.
      for (let i = 0; i < 3; i++) provider.sendAudioChunk(pcm(0));
      provider.sendAudioChunk(pcm(3_000));
      expect(speechStartsOf(events)).toBe(2);
      provider.stop();
    });

    it("needs 40ms over speech level, and 200ms of quiet before it hears a new start", async () => {
      // 20ms frames of alternating-sign samples, the shape real speech has.
      const frame = (amplitude: number): ArrayBuffer => {
        const samples = new Int16Array(480);
        for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? amplitude : -amplitude;
        return samples.buffer;
      };
      const { provider, events } = setup();
      await bringSessionReady(provider);
      provider.sendAudioChunk(frame(3_000));
      provider.sendAudioChunk(frame(0));
      provider.sendAudioChunk(frame(3_000));
      expect(speechStartsOf(events)).toBe(0);
      provider.sendAudioChunk(frame(3_000));
      expect(speechStartsOf(events)).toBe(1);
      for (let i = 0; i < 9; i++) provider.sendAudioChunk(frame(0));
      provider.sendAudioChunk(frame(3_000));
      provider.sendAudioChunk(frame(3_000));
      expect(speechStartsOf(events)).toBe(1);
      for (let i = 0; i < 10; i++) provider.sendAudioChunk(frame(0));
      provider.sendAudioChunk(frame(3_000));
      provider.sendAudioChunk(frame(3_000));
      expect(speechStartsOf(events)).toBe(2);
      provider.stop();
    });

    it("measures a window that straddles two chunks", async () => {
      const { provider, events } = setup();
      await bringSessionReady(provider);
      // 30ms then 10ms: the second window is only whole once the next chunk lands.
      provider.sendAudioChunk(new Int16Array(720).fill(3_000).buffer);
      expect(speechStartsOf(events)).toBe(0);
      provider.sendAudioChunk(new Int16Array(240).fill(3_000).buffer);
      expect(speechStartsOf(events)).toBe(1);
      provider.stop();
    });

    it("stays quiet for audio below speech level", async () => {
      const { provider, events } = setup();
      await bringSessionReady(provider);
      for (let i = 0; i < 10; i++) provider.sendAudioChunk(pcm(100));
      expect(speechStartsOf(events)).toBe(0);
      provider.stop();
    });

    it("hears audio captured while connecting once, not again when it is resent", async () => {
      const { provider, events } = setup();
      const first = await bringSessionReady(provider);
      first.simulateClose(1006);
      provider.sendAudioChunk(pcm(3_000));
      expect(speechStartsOf(events)).toBe(1);
      vi.advanceTimersToNextTimer();
      latestInstance().simulateReady();
      expect(latestInstance().binaryFrames()).toHaveLength(1);
      expect(speechStartsOf(events)).toBe(1);
      provider.stop();
    });

    it("says the speaker went on when an utterance final lands after they resumed", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      provider.sendAudioChunk(pcm(3_000));
      for (let i = 0; i < 3; i++) provider.sendAudioChunk(pcm(0));
      provider.sendAudioChunk(pcm(3_000));
      const before = speechStartsOf(events);
      socket.simulateMessage(utteranceFinal("Send it.", 0, 0.1));
      expect(events.at(-2)).toMatchObject({ type: "complete", text: "Send it." });
      expect(events.at(-1)).toEqual({ type: "speech_started" });
      expect(speechStartsOf(events)).toBe(before + 1);
      provider.stop();
    });

    it("doesn't when the speaker is still quiet", async () => {
      const { provider, events } = setup();
      const socket = await bringSessionReady(provider);
      provider.sendAudioChunk(pcm(3_000));
      for (let i = 0; i < 3; i++) provider.sendAudioChunk(pcm(0));
      socket.simulateMessage(utteranceFinal("Send it.", 0, 0.1));
      expect(events.at(-1)).toMatchObject({ type: "complete", text: "Send it." });
      provider.stop();
    });
  });

  it("keeps its session counts through the stop until the next start", async () => {
    const { provider } = setup();
    const first = await bringSessionReady(provider);
    first.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    latestInstance().simulateReady();
    provider.stop();
    expect(provider.getSessionStats()).toEqual({
      delayTier: "none",
      droppedConnect: 0,
      droppedReplay: 0,
      reconnects: 1,
    });
    void provider.start(BASE_SETTINGS, "session-2");
    expect(provider.getSessionStats().reconnects).toBe(0);
    provider.stop();
  });

  it("ignores a superseded socket's late events", async () => {
    const { provider, events } = setup();
    const first = await bringSessionReady(provider);
    first.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const second = latestInstance();
    second.simulateReady();
    const before = events.length;
    first.simulateMessage(utteranceFinal("stale", 0, 1));
    first.simulateError();
    first.simulateClose(1006);
    expect(events).toHaveLength(before);
    provider.stop();
  });
});
