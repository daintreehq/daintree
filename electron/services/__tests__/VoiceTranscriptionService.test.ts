import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";

// ── Mock the `ws` package ────────────────────────────────────────────────────
//
// The coordinator delegates to a concrete provider (OpenAI or Deepgram), each
// of which imports `WebSocket from "ws"`. We mock the module once so both
// providers receive the same controllable stub. The stub records string control
// frames and binary audio frames so the test can tell the two transports apart.

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
    void code;
    this.readyState = MockWebSocket.CLOSED;
  }

  terminate(): void {
    this.terminateCalls++;
    this.readyState = MockWebSocket.CLOSED;
    this.fire("close", 1006, undefined);
  }

  ping(): void {}

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.fire("open");
  }

  simulateMessage(type: string, payload: Record<string, unknown> = {}): void {
    this.fire("message", Buffer.from(JSON.stringify({ type, ...payload })));
  }

  textFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  binaryFrames(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
  }
}

const instances: MockWebSocket[] = [];

vi.mock("ws", () => {
  const ctor = function (this: unknown, url: string, options: MockOptions) {
    return new MockWebSocket(url, options);
  } as unknown as new (url: string, options: MockOptions) => MockWebSocket;
  return { default: ctor };
});

// ── Mock the VAD worker (`node:worker_threads`) ──────────────────────────────
//
// The OpenAI provider spawns a Silero VAD worker. Replace it with a stub so the
// coordinator tests can drive speech-end events synchronously instead of
// loading ONNX or spawning a real thread.

type VadListener = (...args: unknown[]) => void;

class MockVadWorker {
  terminateCalls = 0;
  private listeners: Map<string, Set<VadListener>> = new Map();

  constructor(_path: string | URL) {
    vadWorkers.push(this);
  }

  on(event: string, listener: VadListener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }

  postMessage(): void {}

  terminate(): Promise<number> {
    this.terminateCalls++;
    return Promise.resolve(0);
  }

  private fire(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) listener(...args);
  }

  emitSpeechStart(): void {
    this.fire("message", { type: "speech-start" });
  }
  emitSpeechEnd(): void {
    this.fire("message", { type: "speech-end" });
  }
}

const vadWorkers: MockVadWorker[] = [];

vi.mock("node:worker_threads", () => ({
  Worker: function (this: unknown, scriptPath: string | URL) {
    return new MockVadWorker(scriptPath);
  } as unknown as new (scriptPath: string | URL) => MockVadWorker,
}));

function latestVadWorker(): MockVadWorker {
  const worker = vadWorkers.at(-1);
  if (!worker) throw new Error("No MockVadWorker instance created");
  return worker;
}

// Import AFTER vi.mock so the providers use the mocked `ws`.
const { VoiceTranscriptionService } = await import("../VoiceTranscriptionService.js");
type VoiceTranscriptionServiceInstance = InstanceType<typeof VoiceTranscriptionService>;
type VoiceTranscriptionEvent = import("../VoiceTranscriptionService.js").VoiceTranscriptionEvent;

const OPENAI_SETTINGS: VoiceInputSettings = {
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

const DEEPGRAM_SETTINGS: VoiceInputSettings = {
  ...OPENAI_SETTINGS,
  openaiApiKey: "",
  deepgramApiKey: "dg-test",
  transcriptionProvider: "deepgram",
};

function latestInstance(): MockWebSocket {
  const instance = instances.at(-1);
  if (!instance) throw new Error("No MockWebSocket instance created");
  return instance;
}

async function bringOpenAiReady(
  service: VoiceTranscriptionServiceInstance
): Promise<MockWebSocket> {
  const startPromise = service.start(OPENAI_SETTINGS);
  await Promise.resolve();
  const socket = latestInstance();
  socket.simulateOpen();
  socket.simulateMessage("session.updated");
  await startPromise;
  return socket;
}

async function bringDeepgramReady(
  service: VoiceTranscriptionServiceInstance
): Promise<MockWebSocket> {
  const startPromise = service.start(DEEPGRAM_SETTINGS);
  await Promise.resolve();
  const socket = latestInstance();
  socket.simulateOpen();
  await startPromise;
  return socket;
}

describe("VoiceTranscriptionService (coordinator)", () => {
  beforeEach(() => {
    instances.length = 0;
    vadWorkers.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Provider selection ──────────────────────────────────────────────────

  it("routes to the OpenAI provider for transcriptionProvider 'openai'", async () => {
    const service = new VoiceTranscriptionService();
    void service.start(OPENAI_SETTINGS);
    await Promise.resolve();
    const socket = latestInstance();
    expect(socket.url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
    expect(socket.options.headers.Authorization).toBe("Bearer sk-test");
    service.stop();
  });

  it("routes to the Deepgram provider for transcriptionProvider 'deepgram'", async () => {
    const service = new VoiceTranscriptionService();
    void service.start(DEEPGRAM_SETTINGS);
    await Promise.resolve();
    const socket = latestInstance();
    expect(new URL(socket.url).host).toBe("api.deepgram.com");
    expect(socket.options.headers.Authorization).toBe("Token dg-test");
    service.stop();
  });

  // ── Event forwarding ──────────────────────────────────────────────────────

  it("forwards provider status events to subscribers", async () => {
    const service = new VoiceTranscriptionService();
    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });
    await bringOpenAiReady(service);
    expect(statuses).toEqual(["connecting", "recording"]);
    service.stop();
  });

  it("forwards delta and complete events from the active provider", async () => {
    const service = new VoiceTranscriptionService();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const socket = await bringOpenAiReady(service);
    socket.simulateMessage("conversation.item.input_audio_transcription.delta", { delta: "Hi" });
    socket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "Hi there",
    });

    expect(events.some((e) => e.type === "delta" && e.text === "Hi")).toBe(true);
    expect(events.some((e) => e.type === "complete" && e.text === "Hi there")).toBe(true);
    service.stop();
  });

  // ── Server-VAD-driven segmentation difference ─────────────────────────────

  it("commits on client VAD speech-end for OpenAI but not for Deepgram", async () => {
    const openai = new VoiceTranscriptionService();
    const openaiSocket = await bringOpenAiReady(openai);
    const worker = latestVadWorker();
    openai.sendAudioChunk(new Uint8Array(5_000).buffer);
    // The client-side VAD drives the commit at end-of-speech.
    worker.emitSpeechStart();
    worker.emitSpeechEnd();
    expect(
      openaiSocket.textFrames().filter((f) => f.type === "input_audio_buffer.commit")
    ).toHaveLength(1);
    openai.stop();

    // Deepgram has server-side VAD — no client worker is spawned and no client
    // commit is ever sent.
    const deepgram = new VoiceTranscriptionService();
    const deepgramSocket = await bringDeepgramReady(deepgram);
    deepgram.sendAudioChunk(new Uint8Array(5_000).buffer);
    vi.advanceTimersByTime(2_500);
    expect(deepgramSocket.textFrames().some((f) => f.type === "input_audio_buffer.commit")).toBe(
      false
    );
    deepgram.stop();
  });

  // ── Audio transport delegation ─────────────────────────────────────────────

  it("delegates audio as base64 JSON for OpenAI and raw binary for Deepgram", async () => {
    const openai = new VoiceTranscriptionService();
    const openaiSocket = await bringOpenAiReady(openai);
    const chunk = new Uint8Array([1, 2, 3]).buffer;
    openai.sendAudioChunk(chunk);
    const append = openaiSocket.textFrames().find((f) => f.type === "input_audio_buffer.append");
    expect(append?.audio).toBe(Buffer.from(chunk).toString("base64"));
    expect(openaiSocket.binaryFrames()).toHaveLength(0);
    openai.stop();

    const deepgram = new VoiceTranscriptionService();
    const deepgramSocket = await bringDeepgramReady(deepgram);
    deepgram.sendAudioChunk(chunk);
    expect(deepgramSocket.binaryFrames()).toHaveLength(1);
    expect(deepgramSocket.binaryFrames()[0].equals(Buffer.from(chunk))).toBe(true);
    deepgram.stop();
  });

  // ── Provider switch teardown ───────────────────────────────────────────────

  it("tears down the previous provider and stops forwarding its events on switch", async () => {
    const service = new VoiceTranscriptionService();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const openaiSocket = await bringOpenAiReady(service);

    // Switch to Deepgram — the previous OpenAI socket must be closed.
    const deepgramSocket = await bringDeepgramReady(service);
    expect(deepgramSocket).not.toBe(openaiSocket);
    expect(openaiSocket.closeCalls).toBeGreaterThanOrEqual(1);

    const completesBefore = events.filter((e) => e.type === "complete").length;
    // A late event from the torn-down OpenAI socket must not be forwarded.
    openaiSocket.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "ghost",
    });
    expect(events.filter((e) => e.type === "complete").length).toBe(completesBefore);

    // The new Deepgram provider's events are forwarded.
    deepgramSocket.simulateMessage("Results", {
      is_final: true,
      channel: { alternatives: [{ transcript: "live" }] },
    });
    expect(events.some((e) => e.type === "complete" && e.text === "live")).toBe(true);
    service.stop();
  });

  // ── Lifecycle delegation ───────────────────────────────────────────────────

  it("delegates commitParagraphBoundary to the active provider", async () => {
    const service = new VoiceTranscriptionService();
    const socket = await bringDeepgramReady(service);
    service.commitParagraphBoundary();
    expect(socket.textFrames().filter((f) => f.type === "Finalize")).toHaveLength(1);
    service.stop();
  });

  it("stopGracefully is a no-op before any session is started", async () => {
    const service = new VoiceTranscriptionService();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));
    await expect(service.stopGracefully()).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("destroy disposes the active provider and clears listeners", async () => {
    const service = new VoiceTranscriptionService();
    const events: VoiceTranscriptionEvent[] = [];
    service.onEvent((e) => events.push(e));

    const socket = await bringOpenAiReady(service);
    service.destroy();
    expect(socket.closeCalls).toBe(1);

    const lengthAtDestroy = events.length;
    // Listener cleared — a brand-new session's events must not reach the array.
    const socket2 = await bringOpenAiReady(service);
    socket2.simulateMessage("conversation.item.input_audio_transcription.completed", {
      transcript: "after destroy",
    });
    expect(events.length).toBe(lengthAtDestroy);
  });
});
