import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings } from "../../../../shared/types/ipc/api.js";

// ── Mock the `ws` package ────────────────────────────────────────────────────
//
// Like the OpenAI provider, the Deepgram provider imports `WebSocket from "ws"`
// so it can send the `Authorization` upgrade header. The mock captures both
// string control frames (KeepAlive / CloseStream / Finalize) and binary audio
// frames (raw PCM16 Buffers) so the test can assert the transport differences.

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
  sent: Array<string | Buffer> = [];
  closeCalls = 0;
  closeCode?: number;
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

  send(payload: string | Buffer): void {
    this.sent.push(payload);
  }

  close(code?: number): void {
    this.closeCalls++;
    this.closeCode = code;
    this.readyState = MockWebSocket.CLOSED;
  }

  terminate(): void {
    this.terminateCalls++;
    this.readyState = MockWebSocket.CLOSED;
    this.fire("close", 1006, undefined);
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.fire("open");
  }

  simulateMessage(payload: Record<string, unknown>): void {
    this.fire("message", Buffer.from(JSON.stringify(payload)));
  }

  simulateRawMessage(data: string | Buffer): void {
    this.fire("message", data);
  }

  simulateError(err: Error = new Error("WebSocket error")): void {
    this.fire("error", err);
  }

  // Mirrors ws's `unexpected-response` event: a non-101 HTTP upgrade response.
  // Exposes the mock req/res so tests can assert the socket was drained/destroyed.
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
    this.readyState = MockWebSocket.CLOSED;
    this.fire("close", code, reason);
  }

  /** Control (text) frames the provider sent, parsed as JSON. */
  textFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  /** Raw binary audio frames the provider sent. */
  binaryFrames(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
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

// Mock the logger so the connect-log test can assert the URL is no longer logged.
vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// Import AFTER vi.mock so the mocked `ws` is used.
const { DeepgramTranscriptionProvider } = await import("../DeepgramTranscriptionProvider.js");
const { logInfo } = await import("../../../utils/logger.js");
type DeepgramTranscriptionProviderInstance = InstanceType<typeof DeepgramTranscriptionProvider>;
type VoiceTranscriptionEvent = import("../TranscriptionProvider.js").VoiceTranscriptionEvent;

const BASE_SETTINGS: VoiceInputSettings = {
  enabled: true,
  openaiApiKey: "",
  deepgramApiKey: "dg-test",
  language: "en",
  dictionary: [],
  transcriptionProvider: "deepgram",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionModel: "gpt-6-luna",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [],
  dismissedSuggestions: [],
  learnFromCorrections: true,
};

function latestInstance(): MockWebSocket {
  const instance = instances.at(-1);
  if (!instance) throw new Error("No MockWebSocket instance created");
  return instance;
}

async function bringSessionReady(
  provider: DeepgramTranscriptionProviderInstance,
  settings: VoiceInputSettings = BASE_SETTINGS
): Promise<{ socket: MockWebSocket; result: { ok: true } | { ok: false; error: string } }> {
  const startPromise = provider.start(settings, "session-1");
  await Promise.resolve();
  const socket = latestInstance();
  socket.simulateOpen();
  const result = await startPromise;
  return { socket, result };
}

function resultsMessage(
  transcript: string,
  flags: { is_final: boolean; speech_final?: boolean; start?: number; duration?: number }
) {
  return {
    type: "Results",
    is_final: flags.is_final,
    speech_final: flags.speech_final ?? false,
    ...(flags.start !== undefined ? { start: flags.start } : {}),
    ...(flags.duration !== undefined ? { duration: flags.duration } : {}),
    channel: { alternatives: [{ transcript }] },
  };
}

function statusesOf(events: VoiceTranscriptionEvent[]): string[] {
  return events.flatMap((e) => (e.type === "status" ? [e.status] : []));
}

describe("DeepgramTranscriptionProvider", () => {
  beforeEach(() => {
    instances.length = 0;
    throwOnConstruct = false;
    constructError = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Startup ────────────────────────────────────────────────────────────

  it("fails to start when no Deepgram API key is configured", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const result = await provider.start({ ...BASE_SETTINGS, deepgramApiKey: "" }, "session-1");
    expect(result).toEqual({ ok: false, error: "Deepgram API key not configured" });
    expect(instances).toHaveLength(0);
  });

  it("constructs the WebSocket with the Deepgram streaming URL and Token auth", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(
      { ...BASE_SETTINGS, deepgramApiKey: "dg-abc", language: "en" },
      "session-1"
    );
    await Promise.resolve();
    const socket = latestInstance();

    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("24000");
    expect(url.searchParams.get("endpointing")).toBe("300");
    expect(url.searchParams.get("language")).toBe("en");
    expect(socket.options.headers.Authorization).toBe("Token dg-abc");
    provider.stop();
  });

  it("requests punctuated, formatted text and interim results", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const url = new URL(latestInstance().url);
    expect(url.searchParams.get("punctuate")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("interim_results")).toBe("true");
    provider.stop();
  });

  it("maps auto language to language=multi, never detect_language", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(
      { ...BASE_SETTINGS, deepgramApiKey: "dg-abc", language: "auto" },
      "session-1"
    );
    await Promise.resolve();
    const url = new URL(latestInstance().url);
    expect(url.searchParams.get("language")).toBe("multi");
    expect(url.searchParams.has("detect_language")).toBe(false);
    provider.stop();
  });

  it.each([
    ["a number", 42],
    ["an object", { code: "en" }],
    ["blank", "  "],
  ])("falls back to language=en when the stored language is %s", async (_label, language) => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(
      {
        ...BASE_SETTINGS,
        deepgramApiKey: "dg-abc",
        language,
      } as unknown as typeof BASE_SETTINGS,
      "session-1"
    );
    await Promise.resolve();
    expect(new URL(latestInstance().url).searchParams.get("language")).toBe("en");
    provider.stop();
  });

  // ── Keyterm URL injection ─────────────────────────────────────────────────

  it("appends one repeated keyterm= param per term (not comma-joined)", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(
      { ...BASE_SETTINGS, keyterms: ["alpha", "betaTerm", "gamma"] },
      "session-1"
    );
    await Promise.resolve();
    const url = new URL(latestInstance().url);

    expect(url.searchParams.getAll("keyterm")).toEqual(["alpha", "betaTerm", "gamma"]);
    // Nova-3 uses `keyterm`, not the legacy `keywords` parameter.
    expect(url.searchParams.has("keywords")).toBe(false);
    provider.stop();
  });

  it("omits the keyterm param when no keyterms are supplied", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start({ ...BASE_SETTINGS, keyterms: [] }, "session-1");
    await Promise.resolve();
    expect(new URL(latestInstance().url).searchParams.has("keyterm")).toBe(false);

    void provider.start({ ...BASE_SETTINGS, keyterms: undefined }, "session-1");
    await Promise.resolve();
    expect(new URL(latestInstance().url).searchParams.has("keyterm")).toBe(false);
    provider.stop();
  });

  it("caps the injected keyterms at the URL term limit", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const many = Array.from({ length: 96 }, (_, i) => `term${i}`);
    void provider.start({ ...BASE_SETTINGS, keyterms: many }, "session-1");
    await Promise.resolve();
    const injected = new URL(latestInstance().url).searchParams.getAll("keyterm");

    // Fewer than supplied, and a prefix of the priority-ordered input.
    expect(injected.length).toBeLessThan(many.length);
    expect(injected.length).toBeGreaterThan(0);
    expect(injected).toEqual(many.slice(0, injected.length));
    provider.stop();
  });

  it("drops empty/whitespace keyterms before injecting", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(
      { ...BASE_SETTINGS, keyterms: ["  ", "real", "", "  spaced  "] },
      "session-1"
    );
    await Promise.resolve();
    expect(new URL(latestInstance().url).searchParams.getAll("keyterm")).toEqual([
      "real",
      "spaced",
    ]);
    provider.stop();
  });

  it("enforces the aggregate-char budget on long keyterms", async () => {
    const provider = new DeepgramTranscriptionProvider();
    // Each term is 1000 chars; the ~3000-char aggregate guard admits only 3.
    const long = Array.from({ length: 10 }, (_, i) => `${"x".repeat(999)}${i}`);
    void provider.start({ ...BASE_SETTINGS, keyterms: long }, "session-1");
    await Promise.resolve();
    const injected = new URL(latestInstance().url).searchParams.getAll("keyterm");

    expect(injected.length).toBe(3);
    expect(injected.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(3_000);
    provider.stop();
  });

  it("skips an oversized keyterm but keeps smaller later terms", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const huge = "z".repeat(4_000);
    void provider.start({ ...BASE_SETTINGS, keyterms: [huge, "short1", "short2"] }, "session-1");
    await Promise.resolve();
    // The oversized leading term is skipped (continue, not break), so the small
    // terms after it still make it into the URL.
    expect(new URL(latestInstance().url).searchParams.getAll("keyterm")).toEqual([
      "short1",
      "short2",
    ]);
    provider.stop();
  });

  it("logs the keyterm count, not the URL, when opening the socket", async () => {
    const provider = new DeepgramTranscriptionProvider();
    vi.mocked(logInfo).mockClear();
    void provider.start({ ...BASE_SETTINGS, keyterms: ["alpha", "beta"] }, "session-1");
    await Promise.resolve();

    const openCall = vi
      .mocked(logInfo)
      .mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("Opening Deepgram"));
    expect(openCall).toBeDefined();
    const meta = openCall?.[1] as Record<string, unknown>;
    expect(meta.keytermCount).toBe(2);
    expect(meta).not.toHaveProperty("url");
    // Belt and braces: no logged argument should contain the streaming host.
    for (const call of vi.mocked(logInfo).mock.calls) {
      expect(JSON.stringify(call)).not.toContain("api.deepgram.com/v1/listen?");
    }
    provider.stop();
  });

  it("URL-encodes multi-word and special-char keyterms correctly", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(
      {
        ...BASE_SETTINGS,
        keyterms: ["node pty", "C++ & Rust"],
      },
      "session-1"
    );
    await Promise.resolve();
    const socket = latestInstance();

    // Raw query string keeps each term as a separate keyterm pair; URL parsing
    // round-trips the original term values intact.
    const url = new URL(socket.url);
    expect(url.searchParams.getAll("keyterm")).toEqual(["node pty", "C++ & Rust"]);
    provider.stop();
  });

  it("becomes ready and emits recording on WebSocket open", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    expect(statuses).toEqual(["connecting"]);
    await Promise.resolve();
    latestInstance().simulateOpen();

    await expect(startPromise).resolves.toEqual({ ok: true });
    expect(statuses).toEqual(["connecting", "recording"]);
    provider.stop();
  });

  it("times out and closes the socket if open does not arrive within 10s", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const errors: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "error") errors.push(e.error.message);
    });

    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();
    // Never open.
    vi.advanceTimersByTime(10_000);

    await expect(startPromise).resolves.toEqual({ ok: false, error: "Connection timed out" });
    expect(errors).toContain("Connection timed out");
    expect(socket.closeCalls).toBe(1);
  });

  it("fails start when WebSocket construction throws", async () => {
    throwOnConstruct = true;
    constructError = new Error("ECONNREFUSED");
    const provider = new DeepgramTranscriptionProvider();
    const result = await provider.start(BASE_SETTINGS, "session-1");
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  // ── Audio transport ──────────────────────────────────────────────────────

  it("sends audio chunks as raw binary frames, not base64 JSON", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    const chunk = new Uint8Array([1, 2, 3, 4]).buffer;
    provider.sendAudioChunk(chunk);

    const binary = socket.binaryFrames();
    expect(binary).toHaveLength(1);
    expect(binary[0].equals(Buffer.from(chunk))).toBe(true);
    // No JSON audio envelope like OpenAI's input_audio_buffer.append.
    expect(socket.textFrames().some((f) => f.type === "input_audio_buffer.append")).toBe(false);
    provider.stop();
  });

  it("buffers pre-connect audio and flushes it as binary after open", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();

    provider.sendAudioChunk(new Uint8Array([1]).buffer);
    provider.sendAudioChunk(new Uint8Array([2]).buffer);
    expect(socket.binaryFrames()).toHaveLength(0);

    socket.simulateOpen();
    await startPromise;

    const binary = socket.binaryFrames();
    expect(binary).toHaveLength(2);
    expect(binary[0].equals(Buffer.from(new Uint8Array([1])))).toBe(true);
    expect(binary[1].equals(Buffer.from(new Uint8Array([2])))).toBe(true);
    provider.stop();
  });

  it("enforces the pre-connect byte cap independently of chunk count", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();

    // Twenty 40KB chunks = 800KB, over the 720KB ceiling. Only the chunks that
    // fit under 720KB are retained.
    for (let i = 0; i < 20; i++) {
      provider.sendAudioChunk(new Uint8Array(40_000).buffer);
    }
    socket.simulateOpen();
    await startPromise;

    // 18 × 40KB = 720KB fits; a 19th would push to 760KB > 720KB, so it's dropped.
    expect(socket.binaryFrames()).toHaveLength(18);
    // Two chunks dropped, one transient report.
    const overflows = events.filter(
      (e) => e.type === "error" && e.error.code === "audio_buffer_overflow"
    );
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toMatchObject({ error: { severity: "transient" } });
    provider.stop();
  });

  it("drops audio chunks while draining", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    const drainPromise = provider.stopGracefully();
    const binaryAtDrain = socket.binaryFrames().length;
    provider.sendAudioChunk(new Uint8Array([9]).buffer);
    expect(socket.binaryFrames().length).toBe(binaryAtDrain);

    socket.simulateClose(1000);
    await drainPromise;
  });

  // ── Results → complete ─────────────────────────────────────────────────

  it("emits complete only for finalized (is_final) results", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage(resultsMessage("hello wor", { is_final: false }));
    expect(completes).toEqual([]);

    socket.simulateMessage(resultsMessage("Hello world.", { is_final: true }));
    expect(completes).toEqual(["Hello world."]);
    provider.stop();
  });

  it("emits each interim as a replacing preview of its span, retired by the span's final", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => {
      if (e.type === "delta" || e.type === "complete") events.push(e);
    });

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage(resultsMessage("hello", { is_final: false }));
    socket.simulateMessage(resultsMessage("Hello world", { is_final: false }));
    socket.simulateMessage(resultsMessage("Hello, world.", { is_final: true }));
    // A long utterance finalises in several spans; the next interim is a new span.
    socket.simulateMessage(resultsMessage("next", { is_final: false }));
    socket.simulateMessage(resultsMessage("Next one.", { is_final: true, speech_final: true }));

    expect(events.map((e) => ({ type: e.type, text: "text" in e ? e.text : "" }))).toEqual([
      { type: "delta", text: "hello" },
      { type: "delta", text: "Hello world" },
      { type: "complete", text: "Hello, world." },
      { type: "delta", text: "next" },
      { type: "complete", text: "Next one." },
    ]);
    for (const e of events) {
      if (e.type === "delta") expect(e.replace).toBe(true);
    }
    const ids = events.map((e) => ("itemId" in e ? e.itemId : undefined));
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    // One identity per span: a span's interims and its final share it, and the
    // next span never reuses it.
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[3]).toBe(ids[4]);
    expect(ids[3]).not.toBe(ids[0]);
    provider.stop();
  });

  it("retracts and retires a span revised to nothing, then starts fresh spans", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => {
      if (e.type === "delta" || e.type === "complete") events.push(e);
    });

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage(resultsMessage("um", { is_final: false }));
    socket.simulateMessage(resultsMessage("", { is_final: false }));
    socket.simulateMessage(resultsMessage("", { is_final: true }));
    socket.simulateMessage(resultsMessage("next", { is_final: false }));
    socket.simulateMessage(resultsMessage("Next.", { is_final: true }));
    socket.simulateMessage(resultsMessage("Again.", { is_final: true }));

    expect(events.map((e) => ({ type: e.type, text: "text" in e ? e.text : "" }))).toEqual([
      { type: "delta", text: "um" },
      { type: "delta", text: "" },
      { type: "complete", text: "" },
      { type: "delta", text: "next" },
      { type: "complete", text: "Next." },
      { type: "complete", text: "Again." },
    ]);
    expect(events[1]).toMatchObject({ replace: true });
    const ids = events.map((e) => ("itemId" in e ? e.itemId : undefined));
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[4]).toBe(ids[3]);
    expect(new Set([ids[0], ids[3], ids[5]]).size).toBe(3);
    provider.stop();
  });

  it("a malformed result leaves the live preview for its span's real final", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => {
      if (e.type === "delta" || e.type === "complete") events.push(e);
    });

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage(resultsMessage("hello", { is_final: false }));
    socket.simulateMessage({ type: "Results", is_final: true });
    socket.simulateMessage({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: 42 }] },
    });
    for (const isFinal of ["true", null, undefined]) {
      socket.simulateMessage({
        type: "Results",
        is_final: isFinal,
        channel: { alternatives: [{ transcript: "" }] },
      });
    }
    socket.simulateMessage(resultsMessage("Hello.", { is_final: true }));

    expect(events.map((e) => e.type)).toEqual(["delta", "complete"]);
    const [delta, complete] = events as Array<{ itemId?: string; text?: string }>;
    expect(complete.text).toBe("Hello.");
    expect(complete.itemId).toBe(delta.itemId);
    provider.stop();
  });

  it("gives a final that arrives without any interim its own span identity", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => {
      if (e.type === "delta" || e.type === "complete") events.push(e);
    });

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage(resultsMessage("Yes.", { is_final: true }));
    socket.simulateMessage(resultsMessage("and", { is_final: false }));

    const [complete, delta] = events as Array<{ type: string; itemId?: string }>;
    expect(complete).toMatchObject({ type: "complete", text: "Yes." });
    expect(complete.itemId).toBeTruthy();
    expect(delta.itemId).toBeTruthy();
    expect(delta.itemId).not.toBe(complete.itemId);
    provider.stop();
  });

  it("does not emit an empty interim or reuse a span identity across providers", async () => {
    const other = new DeepgramTranscriptionProvider();
    const otherIds: Array<string | undefined> = [];
    other.onEvent((e) => {
      if (e.type === "delta") otherIds.push(e.itemId);
    });
    const otherSession = await bringSessionReady(other);
    otherSession.socket.simulateMessage(resultsMessage("elsewhere", { is_final: false }));
    other.stop();

    const provider = new DeepgramTranscriptionProvider();
    const deltas: Array<{ text: string; itemId?: string }> = [];
    provider.onEvent((e) => {
      if (e.type === "delta") deltas.push({ text: e.text, itemId: e.itemId });
    });

    const first = await bringSessionReady(provider);
    first.socket.simulateMessage(resultsMessage("  ", { is_final: false }));
    expect(deltas).toEqual([]);
    first.socket.simulateMessage(resultsMessage("first", { is_final: false }));
    provider.stop();

    const second = await bringSessionReady(provider);
    second.socket.simulateMessage(resultsMessage("second", { is_final: false }));
    expect(deltas.map((d) => d.text)).toEqual(["first", "second"]);
    expect(deltas[1].itemId).not.toBe(deltas[0].itemId);
    expect(otherIds).toHaveLength(1);
    expect(deltas.map((d) => d.itemId)).not.toContain(otherIds[0]);
    provider.stop();
  });

  it("does not emit complete for an empty or whitespace-only final transcript", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage(resultsMessage("", { is_final: true }));
    socket.simulateMessage(resultsMessage("   ", { is_final: true }));
    expect(completes).toEqual([]);
    provider.stop();
  });

  it("ignores non-JSON messages without throwing", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(provider);
    expect(() => socket.simulateRawMessage("not json {")).not.toThrow();
    socket.simulateMessage(resultsMessage("still works", { is_final: true }));
    expect(completes).toEqual(["still works"]);
    provider.stop();
  });

  it("handles malformed Results payloads without throwing or emitting", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "complete" || e.type === "delta") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(provider);
    // No channel field.
    expect(() => socket.simulateMessage({ type: "Results", is_final: true })).not.toThrow();
    // Empty alternatives array.
    expect(() =>
      socket.simulateMessage({ type: "Results", is_final: true, channel: { alternatives: [] } })
    ).not.toThrow();
    // is_final as a string, not a strict boolean — ignored, not shown as a preview.
    expect(() =>
      socket.simulateMessage({
        type: "Results",
        is_final: "true",
        channel: { alternatives: [{ transcript: "stringy" }] },
      })
    ).not.toThrow();

    expect(completes).toEqual([]);
    provider.stop();
  });

  // ── No client commit timer (server VAD) ──────────────────────────────────

  it("never runs a client-side commit timer", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    provider.sendAudioChunk(new Uint8Array(5_000).buffer);
    // Advancing well past the OpenAI 2s commit cadence must not emit any commit.
    vi.advanceTimersByTime(2_500);
    expect(socket.textFrames().some((f) => f.type === "input_audio_buffer.commit")).toBe(false);
    provider.stop();
  });

  // ── KeepAlive ────────────────────────────────────────────────────────────

  it("sends a KeepAlive control frame on the keep-alive interval", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    expect(socket.textFrames().filter((f) => f.type === "KeepAlive")).toHaveLength(0);
    vi.advanceTimersByTime(5_000);
    expect(socket.textFrames().filter((f) => f.type === "KeepAlive")).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(socket.textFrames().filter((f) => f.type === "KeepAlive")).toHaveLength(2);
    provider.stop();
  });

  it("stops sending KeepAlive after stop()", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    provider.stop();
    const keepAlivesBefore = socket.textFrames().filter((f) => f.type === "KeepAlive").length;
    vi.advanceTimersByTime(15_000);
    expect(socket.textFrames().filter((f) => f.type === "KeepAlive").length).toBe(keepAlivesBefore);
  });

  // ── Paragraph boundary ─────────────────────────────────────────────────

  it("sends a Finalize control frame on commitParagraphBoundary", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    provider.commitParagraphBoundary();
    expect(socket.textFrames().filter((f) => f.type === "Finalize")).toHaveLength(1);
    provider.stop();
  });

  // ── Graceful stop / drain ────────────────────────────────────────────────

  it("sends CloseStream on stopGracefully and drains until the socket closes", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(provider);
    const drainPromise = provider.stopGracefully();
    expect(statuses).toContain("finishing");
    expect(socket.textFrames().filter((f) => f.type === "CloseStream")).toHaveLength(1);

    // The server flushes a final result, then closes.
    socket.simulateMessage(resultsMessage("flushed tail", { is_final: true }));
    socket.simulateClose(1000);
    await drainPromise;

    expect(completes).toEqual(["flushed tail"]);
    expect(statuses.at(-1)).toBe("idle");
  });

  it("drain resolves after the timeout if the socket never closes", async () => {
    const provider = new DeepgramTranscriptionProvider();
    await bringSessionReady(provider);

    const drainPromise = provider.stopGracefully();
    vi.advanceTimersByTime(3_000);
    await expect(drainPromise).resolves.toBeUndefined();
  });

  it("stopGracefully without an open connection goes straight to idle", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    await provider.stopGracefully();
    expect(statuses).toEqual(["idle"]);
  });

  it("repeated stopGracefully calls share a single in-flight drain", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    const first = provider.stopGracefully();
    const second = provider.stopGracefully();
    expect(socket.textFrames().filter((f) => f.type === "CloseStream")).toHaveLength(1);

    socket.simulateClose(1000);
    await Promise.all([first, second]);
  });

  // ── Graceful stop while connecting (#13108) ──────────────────────────────

  it("stopGracefully while connecting flushes buffered audio, then CloseStream, then drains", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
      if (e.type === "complete") completes.push(e.text);
    });

    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();
    provider.sendAudioChunk(new Uint8Array([1, 2, 3]).buffer);

    const stopPromise = provider.stopGracefully();
    expect(statuses.at(-1)).toBe("finishing");
    expect(socket.closeCalls).toBe(0);

    // Audio after the stop (mic already released) must not be kept.
    provider.sendAudioChunk(new Uint8Array([9]).buffer);

    socket.simulateOpen();
    await expect(startPromise).resolves.toEqual({ ok: true });
    expect(socket.binaryFrames()).toEqual([Buffer.from([1, 2, 3])]);
    expect(socket.textFrames().map((f) => f.type)).toEqual(["CloseStream"]);
    expect(statuses).not.toContain("recording");

    socket.simulateMessage(resultsMessage("yes do that", { is_final: true }));
    socket.simulateClose(1000);
    await stopPromise;

    expect(completes).toEqual(["yes do that"]);
    expect(statuses.at(-1)).toBe("idle");
  });

  it("a keyterm-overflow retry while waiting on a connecting stop still flushes the audio", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const firstSocket = latestInstance();
    provider.sendAudioChunk(new Uint8Array([1, 2, 3]).buffer);

    const stopPromise = provider.stopGracefully();
    firstSocket.simulateUnexpectedResponse(400);
    const retrySocket = latestInstance();
    expect(retrySocket).not.toBe(firstSocket);

    retrySocket.simulateOpen();
    expect(retrySocket.sent).toEqual([
      Buffer.from([1, 2, 3]),
      JSON.stringify({ type: "CloseStream" }),
    ]);
    retrySocket.simulateClose(1000);
    await stopPromise;
  });

  it("a failed keyterm-overflow retry settles a connecting stop without waiting out the deadline", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });
    void provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const firstSocket = latestInstance();
    provider.sendAudioChunk(new Uint8Array([1, 2, 3]).buffer);

    const stopPromise = provider.stopGracefully();
    throwOnConstruct = true;
    firstSocket.simulateUnexpectedResponse(400);
    await stopPromise;
    expect(statuses.at(-1)).toBe("idle");
  });

  it("start() while waiting on a connecting stop does not tear down the new session", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });
    void provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    provider.sendAudioChunk(new Uint8Array([1, 2, 3]).buffer);
    const stopPromise = provider.stopGracefully();

    const { socket: secondSocket, result } = await bringSessionReady(provider);
    await stopPromise;

    expect(result).toEqual({ ok: true });
    expect(secondSocket.closeCalls).toBe(0);
    expect(statuses.at(-1)).toBe("recording");
    provider.stop();
  });

  it("stopGracefully while connecting gives up after the connect wait if the socket never opens", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();
    provider.sendAudioChunk(new Uint8Array([1, 2, 3]).buffer);

    const stopPromise = provider.stopGracefully();
    vi.advanceTimersByTime(3_000);
    await stopPromise;

    expect(statuses.at(-1)).toBe("idle");
    expect(socket.closeCalls).toBe(1);
    await expect(startPromise).resolves.toMatchObject({ ok: false });
    expect(socket.binaryFrames()).toHaveLength(0);
  });

  it("stopGracefully while connecting with no buffered audio stops immediately", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    void provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();

    await provider.stopGracefully();
    expect(statuses).toEqual(["connecting", "idle"]);
    expect(socket.closeCalls).toBe(1);
  });

  it("stop() while waiting on a connecting stop discards the buffered audio", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();
    provider.sendAudioChunk(new Uint8Array([1, 2, 3]).buffer);

    const stopPromise = provider.stopGracefully();
    provider.stop();
    await stopPromise;

    // A late open on the cancelled socket sends nothing.
    socket.simulateOpen();
    expect(socket.binaryFrames()).toHaveLength(0);
    expect(socket.textFrames()).toHaveLength(0);
  });

  it("a fatal connect error while waiting on a connecting stop settles the stop", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });
    void provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    const socket = latestInstance();
    provider.sendAudioChunk(new Uint8Array([1, 2, 3]).buffer);

    const stopPromise = provider.stopGracefully();
    socket.simulateError(new Error("ECONNREFUSED"));
    await stopPromise;
    expect(statuses.at(-1)).toBe("idle");
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it("surfaces a server-side Error event as a fatal error", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage({ type: "Error", description: "invalid api key" });

    expect(events.some((e) => e.type === "error" && /invalid api key/.test(e.error.message))).toBe(
      true
    );
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
  });

  it("emits error and error status when the WebSocket reports a pre-ready error", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    latestInstance().simulateError(new Error("dns failure"));

    await expect(startPromise).resolves.toEqual({ ok: false, error: "dns failure" });
    expect(events.some((e) => e.type === "error" && /dns failure/.test(e.error.message))).toBe(
      true
    );
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
  });

  // ── Reconnect after a mid-session drop (#14641) ───────────────────────────

  it("reconnects after a drop mid-utterance and resends the unconfirmed and gap audio", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const settings = { ...BASE_SETTINGS, keyterms: ["alpha", "beta"] };

    const { socket: first } = await bringSessionReady(provider, settings);
    // Mid-utterance: audio went out but no final result covered it yet.
    provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
    first.simulateClose(1006, Buffer.from(""));

    expect(statusesOf(events)).toContain("reconnecting");
    expect(events.some((e) => e.type === "error" && e.error.severity === "fatal")).toBe(false);

    // Audio captured during the gap is held, not dropped.
    provider.sendAudioChunk(new Uint8Array([2, 2]).buffer);
    vi.advanceTimersToNextTimer();
    expect(instances).toHaveLength(2);
    const second = latestInstance();
    // Same session settings, keyterms included.
    expect(second.url).toBe(first.url);
    expect(second.options.headers.Authorization).toBe("Token dg-test");

    second.simulateOpen();
    const resent = second.binaryFrames().map((b) => [...b]);
    expect(resent).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(statusesOf(events).at(-1)).toBe("recording");

    second.simulateMessage(resultsMessage("after the drop", { is_final: true }));
    expect(events.some((e) => e.type === "complete" && e.text === "after the drop")).toBe(true);
    provider.stop();
  });

  it("ends the session with a clear error when a reconnect attempt is rejected for auth", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket: first } = await bringSessionReady(provider);
    first.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const second = latestInstance();
    second.simulateUnexpectedResponse(401);

    expect(second.unexpectedReq?.socket.destroy).toHaveBeenCalled();
    const fatal = events.filter((e) => e.type === "error" && e.error.severity === "fatal");
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ error: { message: expect.stringContaining("HTTP 401") } });
    expect(statusesOf(events).at(-1)).toBe("error");

    // No further attempts once the rejection is permanent.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(2);
  });

  it("resends only the audio past the last final result after a drop", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket: first } = await bringSessionReady(provider);

    // 24kHz PCM16: 4,800 bytes = 100ms. Three chunks span 0-300ms.
    provider.sendAudioChunk(new Uint8Array(4_800).fill(1).buffer);
    provider.sendAudioChunk(new Uint8Array(4_800).fill(2).buffer);
    provider.sendAudioChunk(new Uint8Array(4_800).fill(3).buffer);
    // A final result covering 0-150ms confirms chunk 1 and half of chunk 2.
    first.simulateMessage(resultsMessage("hello", { is_final: true, start: 0, duration: 0.15 }));
    first.simulateClose(1006);

    vi.advanceTimersToNextTimer();
    const second = latestInstance();
    second.simulateOpen();

    const resent = second.binaryFrames();
    expect(resent.map((b) => b.length)).toEqual([2_400, 4_800]);
    expect(resent[0].every((byte) => byte === 2)).toBe(true);
    expect(resent[1].every((byte) => byte === 3)).toBe(true);

    // Timing restarts on the new connection: a result covering the resent
    // audio confirms it, so a second drop resends nothing already transcribed.
    second.simulateMessage(resultsMessage("world", { is_final: true, start: 0, duration: 0.15 }));
    second.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const third = latestInstance();
    third.simulateOpen();
    expect(third.binaryFrames()).toHaveLength(0);
    provider.stop();
  });

  it("holds a gap longer than the start-up buffer while reconnecting", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1006);

    // 5s of 100ms chunks, past the ~3s cap that applies while first connecting.
    for (let i = 0; i < 50; i++) provider.sendAudioChunk(new Uint8Array(4_800).buffer);
    vi.advanceTimersToNextTimer();
    latestInstance().simulateOpen();

    expect(latestInstance().binaryFrames()).toHaveLength(50);
    expect(events.some((e) => e.type === "error")).toBe(false);
    provider.stop();
  });

  it("keeps the keyterm-free URL on reconnect after a 400 fallback", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: ["alpha"] }, "session-1");
    await Promise.resolve();
    latestInstance().simulateUnexpectedResponse(400);
    const fallback = latestInstance();
    fallback.simulateOpen();
    await startPromise;

    fallback.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const reconnect = latestInstance();
    expect(instances).toHaveLength(3);
    expect(reconnect.url).toBe(fallback.url);
    expect(new URL(reconnect.url).searchParams.has("keyterm")).toBe(false);
    provider.stop();
  });

  it("ends the session when Deepgram closes a ready session for bad audio", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1008, Buffer.from("DATA-0000"));

    expect(statusesOf(events)).not.toContain("reconnecting");
    expect(statusesOf(events).at(-1)).toBe("error");
    const fatal = events.find((e) => e.type === "error");
    expect(fatal).toMatchObject({
      error: {
        severity: "fatal",
        code: "ws_close_1008",
        message: expect.stringContaining("DATA-0000"),
      },
    });
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
  });

  it("retries a reconnect attempt that hits a server error or rate limit", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1011, Buffer.from("NET-0000"));
    vi.advanceTimersToNextTimer();
    latestInstance().simulateUnexpectedResponse(503);
    vi.advanceTimersToNextTimer();
    latestInstance().simulateUnexpectedResponse(429);
    vi.advanceTimersToNextTimer();
    expect(instances).toHaveLength(4);

    latestInstance().simulateOpen();
    expect(statusesOf(events).at(-1)).toBe("recording");
    expect(events.some((e) => e.type === "error")).toBe(false);
    provider.stop();
  });

  it("keeps reconnecting through transport errors and connect timeouts on an attempt", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1006);

    vi.advanceTimersToNextTimer();
    const refused = latestInstance();
    refused.simulateError(new Error("getaddrinfo ENOTFOUND api.deepgram.com"));
    refused.simulateClose(1006);

    vi.advanceTimersToNextTimer();
    // This attempt never opens; its connect timeout moves on to the next one.
    const silent = latestInstance();
    vi.advanceTimersByTime(10_000);
    expect(silent.terminateCalls).toBe(1);
    vi.advanceTimersToNextTimer();
    expect(instances).toHaveLength(4);

    latestInstance().simulateOpen();
    expect(statusesOf(events).at(-1)).toBe("recording");
    expect(events.some((e) => e.type === "error")).toBe(false);
    provider.stop();
  });

  it("keeps retrying fast failures through a long blip, then gives up with the last failure", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    const droppedAt = performance.now();
    socket.simulateClose(1006);
    let gaveUpAt = 0;
    for (let i = 0; i < 100 && !gaveUpAt; i++) {
      vi.advanceTimersToNextTimer();
      const attempt = latestInstance();
      // Offline at first, so every attempt fails at once; later the network
      // is back but Deepgram is down.
      if (performance.now() - droppedAt < 20_000) {
        attempt.simulateError(new Error("getaddrinfo ENOTFOUND api.deepgram.com"));
        attempt.simulateClose(1006);
      } else {
        attempt.simulateUnexpectedResponse(503);
      }
      if (events.some((e) => e.type === "error")) gaveUpAt = performance.now();
    }

    // Instant failures don't burn the budget before a wifi blip is over...
    expect(gaveUpAt - droppedAt).toBeGreaterThan(10_000);
    // ...but recovery is bounded.
    expect(gaveUpAt - droppedAt).toBeLessThan(60_000);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      error: {
        severity: "fatal",
        code: "reconnect_exhausted",
        message: expect.stringContaining("HTTP 503"),
      },
    });
    expect(statusesOf(events).at(-1)).toBe("error");

    const attempts = instances.length;
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(attempts);
  });

  it("doesn't let an attempt that hangs push recovery far past its window", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    const droppedAt = performance.now();
    socket.simulateClose(1006);
    // Offline for 25s, then the network black-holes: attempts neither open
    // nor error.
    for (let i = 0; i < 100 && !events.some((e) => e.type === "error"); i++) {
      vi.advanceTimersToNextTimer();
      if (performance.now() - droppedAt < 25_000) {
        latestInstance().simulateError(new Error("getaddrinfo ENOTFOUND api.deepgram.com"));
        latestInstance().simulateClose(1006);
      }
    }

    expect(events.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "reconnect_exhausted",
          message: expect.stringContaining("timed out"),
        }),
      }),
    ]);
    // The hanging attempt's connect timeout is cut to what's left of the
    // window; a full one would have run on well past 32s.
    expect(performance.now() - droppedAt).toBeLessThan(32_000);
  });

  it("stop() during a reconnect cancels the pending attempt", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1006);

    provider.stop();
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
  });

  it("a new start() during a reconnect supersedes the pending attempt", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1006);

    const restart = provider.start(BASE_SETTINGS, "session-2");
    await Promise.resolve();
    expect(instances).toHaveLength(2);
    vi.advanceTimersByTime(5_000);
    expect(instances).toHaveLength(2);

    latestInstance().simulateOpen();
    await expect(restart).resolves.toEqual({ ok: true });
    provider.stop();
  });

  it("stopGracefully during a reconnect waits to resend the held audio, then drains", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(provider);
    provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
    socket.simulateClose(1006);
    provider.sendAudioChunk(new Uint8Array([2, 2]).buffer);

    const stopPromise = provider.stopGracefully();
    expect(statuses.at(-1)).toBe("finishing");

    vi.advanceTimersToNextTimer();
    const reconnect = latestInstance();
    reconnect.simulateOpen();
    expect(reconnect.binaryFrames().map((b) => [...b])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(reconnect.textFrames().filter((f) => f.type === "CloseStream")).toHaveLength(1);

    let settled = false;
    void stopPromise.then(() => (settled = true));
    reconnect.simulateMessage(resultsMessage("said in the gap", { is_final: true }));
    await Promise.resolve();
    // CloseStream alone doesn't end the stop; the server's close does.
    expect(settled).toBe(false);
    reconnect.simulateClose(1000);
    await stopPromise;

    expect(completes).toEqual(["said in the gap"]);
    expect(statuses.at(-1)).toBe("idle");
    expect(statuses.slice(statuses.indexOf("finishing"))).not.toContain("recording");
  });

  it("stopGracefully while a reconnect attempt is connecting waits to resend unconfirmed audio", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const { socket } = await bringSessionReady(provider);
    provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
    socket.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const connecting = latestInstance();

    // Nothing captured in the gap: only the audio the dropped socket never
    // confirmed is held.
    const stopPromise = provider.stopGracefully();
    expect(statuses.at(-1)).toBe("finishing");
    provider.sendAudioChunk(new Uint8Array([9, 9]).buffer);

    connecting.simulateOpen();
    expect(connecting.binaryFrames().map((b) => [...b])).toEqual([[1, 1]]);
    expect(connecting.textFrames().map((f) => f.type)).toEqual(["CloseStream"]);
    connecting.simulateClose(1000);
    await stopPromise;
    expect(statuses.at(-1)).toBe("idle");
  });

  it("a failed reconnect attempt settles a waiting stop instead of retrying", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const { socket } = await bringSessionReady(provider);
    provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
    socket.simulateClose(1006);
    const stopPromise = provider.stopGracefully();

    vi.advanceTimersToNextTimer();
    // A rejected upgrade fires no close, so nothing else would settle the stop.
    latestInstance().simulateUnexpectedResponse(503);
    await stopPromise;
    expect(statuses.at(-1)).toBe("idle");

    const attempts = instances.length;
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(attempts);
    expect(statuses.filter((s) => s === "reconnecting")).toHaveLength(1);
  });

  it("keeps a trimmed keyterm list on reconnect after a 400", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const keyterms = Array.from({ length: 30 }, (_, i) => `term${i}`);
    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms }, "session-1");
    await Promise.resolve();
    latestInstance().simulateUnexpectedResponse(400);
    const trimmed = latestInstance();
    const trimmedCount = new URL(trimmed.url).searchParams.getAll("keyterm").length;
    expect(trimmedCount).toBeGreaterThan(0);
    expect(trimmedCount).toBeLessThan(keyterms.length);
    trimmed.simulateOpen();
    await startPromise;

    trimmed.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    expect(latestInstance().url).toBe(trimmed.url);
    provider.stop();
  });

  it("finishes the interim preview a drop interrupted under the same item", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const { socket } = await bringSessionReady(provider);
    provider.sendAudioChunk(new Uint8Array(4_800).buffer);
    socket.simulateMessage(resultsMessage("hel", { is_final: false, start: 0, duration: 0.1 }));
    const preview = events.find((e) => e.type === "delta");
    expect(preview).toBeDefined();
    const itemId = preview?.type === "delta" ? preview.itemId : undefined;

    socket.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const next = latestInstance();
    next.simulateOpen();
    // The interim didn't confirm anything, so the whole span is resent.
    expect(next.binaryFrames()).toHaveLength(1);
    next.simulateMessage(
      resultsMessage("hello world", { is_final: true, start: 0, duration: 0.1 })
    );

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toMatchObject({ text: "hello world", itemId });
    provider.stop();
  });

  it("drops keyterms when a reconnect attempt is the first to get a 400", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const settings = { ...BASE_SETTINGS, language: "de", keyterms: ["alpha"] };
    const { socket: first } = await bringSessionReady(provider, settings);
    provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
    first.simulateClose(1006);
    provider.sendAudioChunk(new Uint8Array([2, 2]).buffer);

    vi.advanceTimersToNextTimer();
    latestInstance().simulateUnexpectedResponse(400);
    const fallback = latestInstance();
    expect(instances).toHaveLength(3);
    const params = new URL(fallback.url).searchParams;
    expect(params.has("keyterm")).toBe(false);
    expect(params.get("language")).toBe("de");
    expect(fallback.options.headers.Authorization).toBe("Token dg-test");

    fallback.simulateOpen();
    expect(fallback.binaryFrames().map((b) => [...b])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    provider.stop();
  });

  it("resends the whole unconfirmed backlog again if the reconnected socket drops too", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket: first } = await bringSessionReady(provider);
    provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
    first.simulateClose(1006);
    provider.sendAudioChunk(new Uint8Array([2, 2]).buffer);
    vi.advanceTimersToNextTimer();
    const second = latestInstance();
    second.simulateOpen();
    provider.sendAudioChunk(new Uint8Array([3, 3]).buffer);

    // Drops again before Deepgram returned a single result.
    second.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const third = latestInstance();
    third.simulateOpen();
    expect(third.binaryFrames().map((b) => [...b])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    provider.stop();
  });

  it("caps gap audio by what the replay ledger has left across repeated drops", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const second = (fill: number) => new Uint8Array(48_000).fill(fill).buffer;

    const { socket: first } = await bringSessionReady(provider);
    // 10s before the drop, then a 30s gap, all unconfirmed.
    for (let i = 0; i < 10; i++) provider.sendAudioChunk(second(1));
    first.simulateClose(1006);
    for (let i = 0; i < 30; i++) provider.sendAudioChunk(second(2));
    vi.advanceTimersToNextTimer();
    const reconnected = latestInstance();
    reconnected.simulateOpen();
    expect(reconnected.binaryFrames()).toHaveLength(40);

    // A second drop with the ledger full: more gap audio is refused (and
    // reported) rather than pushing the first-held audio out of the ledger.
    reconnected.simulateClose(1006);
    for (let i = 0; i < 5; i++) provider.sendAudioChunk(second(3));
    expect(events.some((e) => e.type === "error" && e.error.code === "audio_buffer_overflow")).toBe(
      true
    );
    vi.advanceTimersToNextTimer();
    const last = latestInstance();
    last.simulateOpen();
    const resent = last.binaryFrames();
    expect(resent).toHaveLength(40);
    expect(resent[0][0]).toBe(1);
    provider.stop();
  });

  it("caps reconnect gap audio by chunk count as well as bytes", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1006);

    for (let i = 0; i < 401; i++) provider.sendAudioChunk(new Uint8Array(2).buffer);
    vi.advanceTimersToNextTimer();
    latestInstance().simulateOpen();

    expect(latestInstance().binaryFrames()).toHaveLength(400);
    expect(
      events.filter((e) => e.type === "error" && e.error.code === "audio_buffer_overflow")
    ).toHaveLength(1);
    provider.stop();
  });

  it("closes a superseded reconnect socket that opens late", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const { socket } = await bringSessionReady(provider);
    provider.sendAudioChunk(new Uint8Array([1, 1]).buffer);
    socket.simulateClose(1006);

    vi.advanceTimersToNextTimer();
    const timedOut = latestInstance();
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersToNextTimer();
    const current = latestInstance();
    expect(current).not.toBe(timedOut);

    const recordingBefore = statusesOf(events).filter((s) => s === "recording").length;
    timedOut.simulateOpen();
    expect(timedOut.closeCalls).toBeGreaterThan(0);
    expect(timedOut.binaryFrames()).toHaveLength(0);
    expect(statusesOf(events).filter((s) => s === "recording")).toHaveLength(recordingBefore);

    // The held audio still belongs to the live attempt.
    current.simulateOpen();
    expect(current.binaryFrames().map((b) => [...b])).toEqual([[1, 1]]);
    provider.stop();
  });

  it("confirms audio by each final's start and duration, never by interim results", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);
    for (const fill of [1, 2, 3]) provider.sendAudioChunk(new Uint8Array(4_800).fill(fill).buffer);

    socket.simulateMessage(resultsMessage("one", { is_final: true, start: 0, duration: 0.1 }));
    socket.simulateMessage(resultsMessage("two", { is_final: true, start: 0.1, duration: 0.1 }));
    socket.simulateMessage(
      resultsMessage("three?", { is_final: false, start: 0.2, duration: 0.1 })
    );
    socket.simulateClose(1006);
    vi.advanceTimersToNextTimer();
    const next = latestInstance();
    next.simulateOpen();

    const resent = next.binaryFrames();
    expect(resent).toHaveLength(1);
    expect(resent[0].every((byte) => byte === 3)).toBe(true);
    provider.stop();
  });

  it("gives a later drop its own recovery window after a successful reconnect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const failFastUntil = (ms: number, from: number) => {
      for (let i = 0; i < 100 && performance.now() - from < ms; i++) {
        if (events.some((e) => e.type === "error")) return;
        vi.advanceTimersToNextTimer();
        latestInstance().simulateError(new Error("getaddrinfo ENOTFOUND api.deepgram.com"));
        latestInstance().simulateClose(1006);
      }
    };

    const { socket } = await bringSessionReady(provider);
    const firstDrop = performance.now();
    socket.simulateClose(1006);
    failFastUntil(20_000, firstDrop);
    vi.advanceTimersToNextTimer();
    latestInstance().simulateOpen();

    const secondDrop = performance.now();
    latestInstance().simulateClose(1006);
    failFastUntil(20_000, secondDrop);
    // 40s+ since the first drop, but only 20s into this one.
    expect(performance.now() - firstDrop).toBeGreaterThan(30_000);
    expect(events.some((e) => e.type === "error")).toBe(false);
    provider.stop();
  });

  it("stopGracefully during a reconnect with nothing held stops immediately", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const { socket } = await bringSessionReady(provider);
    provider.sendAudioChunk(new Uint8Array(4_800).buffer);
    // Silence still gets a final result, which confirms the audio it covers.
    socket.simulateMessage(resultsMessage("", { is_final: true, start: 0, duration: 0.1 }));
    socket.simulateClose(1006);

    await provider.stopGracefully();
    expect(statuses.at(-1)).toBe("idle");
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
  });

  // ── Keyterm-overflow retry (HTTP 400) ─────────────────────────────────────

  it("retries once without keyterms on an HTTP 400 upgrade rejection", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const startPromise = provider.start(
      { ...BASE_SETTINGS, keyterms: ["alpha", "beta"] },
      "session-1"
    );
    await Promise.resolve();
    const first = latestInstance();
    expect(new URL(first.url).searchParams.getAll("keyterm")).toEqual(["alpha", "beta"]);

    first.simulateUnexpectedResponse(400);

    // The failed socket must be drained and destroyed (ws leaks it otherwise).
    expect(first.unexpectedRes?.resume).toHaveBeenCalled();
    expect(first.unexpectedReq?.socket.destroy).toHaveBeenCalled();

    // A second socket is opened with no keyterms; everything else is unchanged.
    expect(instances).toHaveLength(2);
    const second = latestInstance();
    expect(new URL(second.url).searchParams.has("keyterm")).toBe(false);
    expect(new URL(second.url).searchParams.get("model")).toBe("nova-3");

    second.simulateOpen();
    await expect(startPromise).resolves.toEqual({ ok: true });
    provider.stop();
  });

  it("retries a long keyterm list trimmed to the head before dropping everything", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const keyterms = Array.from({ length: 40 }, (_, i) => `term${i}`);
    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms }, "session-1");
    await Promise.resolve();
    latestInstance().simulateUnexpectedResponse(400);
    expect(instances).toHaveLength(2);
    expect(new URL(latestInstance().url).searchParams.getAll("keyterm")).toEqual(
      keyterms.slice(0, 20)
    );

    latestInstance().simulateUnexpectedResponse(400);
    expect(instances).toHaveLength(3);
    expect(new URL(latestInstance().url).searchParams.has("keyterm")).toBe(false);

    latestInstance().simulateOpen();
    await expect(startPromise).resolves.toEqual({ ok: true });
    provider.stop();
  });

  it("does not retry on a non-400 upgrade rejection (401)", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: ["alpha"] }, "session-1");
    await Promise.resolve();
    const first = latestInstance();
    first.simulateUnexpectedResponse(401);

    expect(first.unexpectedRes?.resume).toHaveBeenCalled();
    expect(first.unexpectedReq?.socket.destroy).toHaveBeenCalled();
    expect(instances).toHaveLength(1);

    const result = await startPromise;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("HTTP 401");
    expect(events.some((e) => e.type === "error" && /HTTP 401/.test(e.error.message))).toBe(true);
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
  });

  it("does not retry a second time if the keyterm-free retry also gets 400", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: ["alpha"] }, "session-1");
    await Promise.resolve();
    latestInstance().simulateUnexpectedResponse(400);
    expect(instances).toHaveLength(2);

    latestInstance().simulateUnexpectedResponse(400);
    // No third socket — the one-shot retry is exhausted.
    expect(instances).toHaveLength(2);

    const result = await startPromise;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("HTTP 400");
    expect(events.some((e) => e.type === "error" && /HTTP 400/.test(e.error.message))).toBe(true);
  });

  it("keeps the retry socket's connect timeout when the failed socket closes", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: ["alpha"] }, "session-1");
    await Promise.resolve();
    const first = latestInstance();

    first.simulateUnexpectedResponse(400);
    expect(instances).toHaveLength(2);

    // The failed first socket now fires its trailing close. It must NOT cancel
    // the retry socket's connect timeout (regression: stale close cleared it).
    first.simulateClose(1006);

    // The retry socket never opens — its connect timeout should still fire and
    // resolve the start instead of hanging forever.
    vi.advanceTimersByTime(10_000);
    await expect(startPromise).resolves.toEqual({ ok: false, error: "Connection timed out" });
  });

  it("ignores an unexpected-response for a superseded session", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: ["alpha"] }, "session-1");
    await Promise.resolve();
    const first = latestInstance();

    // Stop the session — the first socket is now stale.
    provider.stop();
    first.simulateUnexpectedResponse(400);

    // The socket is still drained/destroyed defensively...
    expect(first.unexpectedRes?.resume).toHaveBeenCalled();
    expect(first.unexpectedReq?.socket.destroy).toHaveBeenCalled();
    // ...but no retry socket is created for the dead session.
    expect(instances).toHaveLength(1);

    await expect(startPromise).resolves.toEqual({ ok: false, error: "Voice session stopped" });
  });

  // ── Stale-session guard ──────────────────────────────────────────────────

  it("ignores results from a stale session", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const completes: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket: firstSocket } = await bringSessionReady(provider);
    // Replace the session; the first socket is now stale.
    const second = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    latestInstance().simulateOpen();
    await second;

    firstSocket.simulateMessage(resultsMessage("ghost", { is_final: true }));
    expect(completes).toEqual([]);
    provider.stop();
  });

  // ── destroy ──────────────────────────────────────────────────────────────

  it("destroy closes the socket and clears listeners", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    provider.destroy();
    expect(socket.closeCalls).toBe(1);

    const lengthAtDestroy = events.length;
    const { socket: socket2 } = await bringSessionReady(provider);
    socket2.simulateMessage(resultsMessage("after destroy", { is_final: true }));
    expect(events.length).toBe(lengthAtDestroy);
  });
});

describe("DeepgramTranscriptionProvider start timing diagnostics", () => {
  let now = 0;

  beforeEach(() => {
    instances.length = 0;
    throwOnConstruct = false;
    constructError = null;
    vi.useFakeTimers();
    vi.mocked(logInfo).mockClear();
    now = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function logDetails(fragment: string): Record<string, unknown>[] {
    return vi
      .mocked(logInfo)
      .mock.calls.filter(([message]) => message.includes(fragment))
      .map(([, details]) => details as Record<string, unknown>);
  }

  it("times socket open from provider start and reports buffered chunks", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const startPromise = provider.start(BASE_SETTINGS, "session-1");
    await Promise.resolve();
    provider.sendAudioChunk(new Int16Array(2400).buffer);
    const socket = latestInstance();
    now = 5_320;
    socket.simulateOpen();
    await startPromise;

    expect(logDetails("WebSocket opened — session ready")).toEqual([
      expect.objectContaining({ connectMs: 320, sinceStartMs: 320, bufferedChunks: 1 }),
    ]);
    provider.stop();
  });

  it("times a keyterm-free retry from its own socket while keeping the session origin", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const startPromise = provider.start({ ...BASE_SETTINGS, keyterms: ["alpha"] }, "session-1");
    await Promise.resolve();
    now = 5_300;
    latestInstance().simulateUnexpectedResponse(400);
    now = 5_450;
    latestInstance().simulateOpen();
    await startPromise;

    expect(logDetails("WebSocket opened — session ready")).toEqual([
      expect.objectContaining({ connectMs: 150, sinceStartMs: 450 }),
    ]);
    provider.stop();
  });

  it("logs the first transcript once, by length only", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const { socket } = await bringSessionReady(provider);

    now = 6_000;
    socket.simulateMessage(resultsMessage("   ", { is_final: false }));
    expect(logDetails("First transcript")).toHaveLength(0);

    // The first interim is the first text the user sees, so it is what's timed.
    socket.simulateMessage(resultsMessage("PRIVATE_DICTATION", { is_final: false }));
    now = 6_500;
    socket.simulateMessage(resultsMessage("PRIVATE_DICTATION done", { is_final: true }));
    socket.simulateMessage(resultsMessage("second", { is_final: true }));

    const first = logDetails("First transcript");
    expect(first).toEqual([
      expect.objectContaining({ eventType: "delta", length: 17, sinceStartMs: 1_000 }),
    ]);
    expect(JSON.stringify(vi.mocked(logInfo).mock.calls)).not.toContain("PRIVATE_DICTATION");
    provider.stop();
  });
});
