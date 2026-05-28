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

// Import AFTER vi.mock so the mocked `ws` is used.
const { DeepgramTranscriptionProvider } = await import("../DeepgramTranscriptionProvider.js");
type DeepgramTranscriptionProviderInstance = InstanceType<typeof DeepgramTranscriptionProvider>;
type VoiceTranscriptionEvent = import("../TranscriptionProvider.js").VoiceTranscriptionEvent;

const BASE_SETTINGS: VoiceInputSettings = {
  enabled: true,
  openaiApiKey: "",
  deepgramApiKey: "dg-test",
  language: "en",
  customDictionary: [],
  transcriptionProvider: "deepgram",
  transcriptionModel: "gpt-realtime-whisper",
  correctionEnabled: false,
  correctionModel: "gpt-5-mini",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
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
  const startPromise = provider.start(settings);
  await Promise.resolve();
  const socket = latestInstance();
  socket.simulateOpen();
  const result = await startPromise;
  return { socket, result };
}

function resultsMessage(transcript: string, flags: { is_final: boolean; speech_final?: boolean }) {
  return {
    type: "Results",
    is_final: flags.is_final,
    speech_final: flags.speech_final ?? false,
    channel: { alternatives: [{ transcript }] },
  };
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

  // ── Capability ──────────────────────────────────────────────────────────

  it("declares server-side VAD", () => {
    const provider = new DeepgramTranscriptionProvider();
    expect(provider.hasServerVAD).toBe(true);
  });

  // ── Startup ────────────────────────────────────────────────────────────

  it("fails to start when no Deepgram API key is configured", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const result = await provider.start({ ...BASE_SETTINGS, deepgramApiKey: "" });
    expect(result).toEqual({ ok: false, error: "Deepgram API key not configured" });
    expect(instances).toHaveLength(0);
  });

  it("constructs the WebSocket with the Deepgram streaming URL and Token auth", async () => {
    const provider = new DeepgramTranscriptionProvider();
    void provider.start({ ...BASE_SETTINGS, deepgramApiKey: "dg-abc", language: "en" });
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

  it("becomes ready and emits recording on WebSocket open", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const startPromise = provider.start(BASE_SETTINGS);
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
      if (e.type === "error") errors.push(e.message);
    });

    const startPromise = provider.start(BASE_SETTINGS);
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
    const result = await provider.start(BASE_SETTINGS);
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
    const startPromise = provider.start(BASE_SETTINGS);
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
    const startPromise = provider.start(BASE_SETTINGS);
    await Promise.resolve();
    const socket = latestInstance();

    // Five 40KB chunks = 200KB, over the 150KB ceiling. Only the chunks that
    // fit under 150KB are retained.
    for (let i = 0; i < 5; i++) {
      provider.sendAudioChunk(new Uint8Array(40_000).buffer);
    }
    socket.simulateOpen();
    await startPromise;

    // 3 × 40KB = 120KB fits; a 4th would push to 160KB > 150KB, so it's dropped.
    expect(socket.binaryFrames()).toHaveLength(3);
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
    // Interim hypothesis — must NOT be emitted (would corrupt the live buffer).
    socket.simulateMessage(resultsMessage("hello wor", { is_final: false }));
    expect(completes).toEqual([]);

    // Finalized segment — emitted.
    socket.simulateMessage(resultsMessage("hello world", { is_final: true }));
    expect(completes).toEqual(["hello world"]);
    provider.stop();
  });

  it("emits complete on a speech_final result", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage(resultsMessage("done speaking", { is_final: true, speech_final: true }));

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toEqual({
      type: "complete",
      text: "done speaking",
      confidence: { minConfidence: 1.0, wordCount: 0, uncertainWords: [], words: [] },
    });
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
      if (e.type === "complete") completes.push(e.text);
    });

    const { socket } = await bringSessionReady(provider);
    // No channel field.
    expect(() => socket.simulateMessage({ type: "Results", is_final: true })).not.toThrow();
    // Empty alternatives array.
    expect(() =>
      socket.simulateMessage({ type: "Results", is_final: true, channel: { alternatives: [] } })
    ).not.toThrow();
    // is_final as a string, not a strict boolean — treated as interim, not emitted.
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

  // ── Error handling ─────────────────────────────────────────────────────

  it("surfaces a server-side Error event as a fatal error", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const { socket } = await bringSessionReady(provider);
    socket.simulateMessage({ type: "Error", description: "invalid api key" });

    expect(events.some((e) => e.type === "error" && /invalid api key/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
  });

  it("emits error and error status when the WebSocket reports a pre-ready error", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const events: VoiceTranscriptionEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const startPromise = provider.start(BASE_SETTINGS);
    await Promise.resolve();
    latestInstance().simulateError(new Error("dns failure"));

    await expect(startPromise).resolves.toEqual({ ok: false, error: "dns failure" });
    expect(events.some((e) => e.type === "error" && /dns failure/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
  });

  it("surfaces an unexpected drop of a ready session as an error", async () => {
    const provider = new DeepgramTranscriptionProvider();
    const statuses: string[] = [];
    provider.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const { socket } = await bringSessionReady(provider);
    socket.simulateClose(1006, Buffer.from("abnormal"));

    expect(statuses).toContain("error");
    expect(statuses).not.toContain("idle");
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
    const second = provider.start(BASE_SETTINGS);
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
