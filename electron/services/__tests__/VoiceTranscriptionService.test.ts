import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";

const deepgramMock = vi.hoisted(() => {
  const LiveTranscriptionEvents = {
    Open: "open",
    Close: "close",
    Error: "error",
    Transcript: "Results",
    UtteranceEnd: "UtteranceEnd",
  };

  class MockConnection {
    private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    sent: Buffer[] = [];
    finalized = false;
    closed = false;
    keepAliveCalled = 0;

    on(event: string, handler: (...args: unknown[]) => void) {
      const listeners = this.handlers.get(event) ?? new Set();
      listeners.add(handler);
      this.handlers.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      const listeners = this.handlers.get(event);
      if (!listeners) return;
      for (const handler of listeners) {
        handler(...args);
      }
    }

    send(buf: Buffer) {
      this.sent.push(buf);
    }

    finish() {
      this.finalized = true;
    }

    requestClose() {
      this.closed = true;
      this.emit(LiveTranscriptionEvents.Close);
    }

    keepAlive() {
      this.keepAliveCalled++;
    }
  }

  const instances: MockConnection[] = [];

  const mockClient = {
    listen: {
      live: (_opts: unknown) => {
        const conn = new MockConnection();
        instances.push(conn);
        return conn;
      },
    },
  };

  return { LiveTranscriptionEvents, MockConnection, instances, mockClient };
});

vi.mock("@deepgram/sdk", () => ({
  createClient: () => deepgramMock.mockClient,
  LiveTranscriptionEvents: deepgramMock.LiveTranscriptionEvents,
}));

import { VoiceTranscriptionService } from "../VoiceTranscriptionService.js";

const BASE_SETTINGS: VoiceInputSettings = {
  enabled: true,
  deepgramApiKey: "dg-test-key",
  correctionApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionModel: "nova-3",
  correctionEnabled: false,
  correctionModel: "gpt-5-nano",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
};

function makeTranscriptEvent(transcript: string, isFinal: boolean, speechFinal: boolean): unknown {
  return {
    channel: { alternatives: [{ transcript }] },
    is_final: isFinal,
    speech_final: speechFinal,
  };
}

describe("VoiceTranscriptionService", () => {
  beforeEach(() => {
    deepgramMock.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("transitions from connecting to recording when the connection opens", async () => {
    const service = new VoiceTranscriptionService();
    const statuses: string[] = [];

    service.onEvent((event) => {
      if (event.type === "status") statuses.push(event.status);
    });

    const startPromise = service.start(BASE_SETTINGS);
    expect(statuses).toContain("connecting");

    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);

    await expect(startPromise).resolves.toEqual({ ok: true });
    expect(statuses.at(-1)).toBe("recording");
  });

  it("fails to start when no Deepgram API key is configured", async () => {
    const service = new VoiceTranscriptionService();
    const result = await service.start({ ...BASE_SETTINGS, deepgramApiKey: "" });
    expect(result).toEqual({ ok: false, error: "Deepgram API key not configured" });
  });

  it("settles a pending start when the session is stopped before connect completes", async () => {
    const service = new VoiceTranscriptionService();

    const startPromise = service.start(BASE_SETTINGS);
    service.stop();

    await expect(startPromise).resolves.toEqual({
      ok: false,
      error: "Voice session stopped",
    });
  });

  it("does not emit idle when start() replaces a previous session", async () => {
    const service = new VoiceTranscriptionService();
    const events: Array<{ type: string; status?: string }> = [];

    service.onEvent((event) => events.push(event));

    const firstPromise = service.start(BASE_SETTINGS);
    deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await firstPromise;

    events.length = 0;

    const secondPromise = service.start(BASE_SETTINGS);
    const idleBeforeConnect = events.filter((e) => e.type === "status" && e.status === "idle");
    expect(idleBeforeConnect).toHaveLength(0);

    deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await secondPromise;
  });

  it("emits delta for interim transcripts", async () => {
    const service = new VoiceTranscriptionService();
    const deltas: string[] = [];
    service.onEvent((e) => {
      if (e.type === "delta") deltas.push(e.text);
    });

    const p = service.start(BASE_SETTINGS);
    deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("Hello", false, false)
    );
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("Hello world", false, false)
    );

    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("emits complete on speech_final", async () => {
    const service = new VoiceTranscriptionService();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const p = service.start(BASE_SETTINGS);
    deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("Hello world", true, true)
    );

    expect(completes).toEqual(["Hello world"]);
  });

  it("accumulates is_final segments and emits them as complete on speech_final", async () => {
    const service = new VoiceTranscriptionService();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const p = service.start(BASE_SETTINGS);
    deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("Hello world", true, false)
    );
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("how are you", true, true)
    );

    expect(completes).toEqual(["Hello world how are you"]);
  });

  it("resets utterance state after each speech_final", async () => {
    const service = new VoiceTranscriptionService();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const p = service.start(BASE_SETTINGS);
    deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("First utterance.", true, true)
    );
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("Second utterance.", true, true)
    );

    expect(completes).toEqual(["First utterance.", "Second utterance."]);
  });

  it("sends audio chunks as ArrayBuffer after connection opens", async () => {
    const service = new VoiceTranscriptionService();
    const p = service.start(BASE_SETTINGS);
    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const chunk = new ArrayBuffer(8);
    service.sendAudioChunk(chunk);

    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect((conn.sent[0] as unknown as ArrayBuffer).byteLength).toBe(8);
  });

  it("buffers pre-connect audio chunks and flushes on open", async () => {
    const service = new VoiceTranscriptionService();
    const startPromise = service.start(BASE_SETTINGS);
    const conn = deepgramMock.instances.at(-1)!;

    const chunk1 = new ArrayBuffer(4);
    const chunk2 = new ArrayBuffer(8);
    service.sendAudioChunk(chunk1);
    service.sendAudioChunk(chunk2);

    expect(conn.sent).toHaveLength(0);

    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await startPromise;

    expect(conn.sent).toHaveLength(2);
  });

  it("rejects audio chunks during drain", async () => {
    const service = new VoiceTranscriptionService();
    const p = service.start(BASE_SETTINGS);
    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const stopPromise = service.stopGracefully();
    service.sendAudioChunk(new ArrayBuffer(4));

    const chunksAfterDrain = conn.sent.length;
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("done", true, true)
    );
    await stopPromise;

    expect(conn.sent.length).toBe(chunksAfterDrain);
  });

  it("calls connection.finish() on graceful stop", async () => {
    const service = new VoiceTranscriptionService();
    const p = service.start(BASE_SETTINGS);
    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const stopPromise = service.stopGracefully();
    expect(conn.finalized).toBe(true);

    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("bye", true, true)
    );
    await stopPromise;
  });

  it("drain resolves after speech_final during graceful stop", async () => {
    const service = new VoiceTranscriptionService();
    const p = service.start(BASE_SETTINGS);
    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    let drained = false;
    const stopPromise = service.stopGracefully().then(() => {
      drained = true;
    });

    expect(drained).toBe(false);
    conn.emit(
      deepgramMock.LiveTranscriptionEvents.Transcript,
      makeTranscriptEvent("final text", true, true)
    );
    await stopPromise;
    expect(drained).toBe(true);
  });

  it("drain resolves after timeout if no speech_final arrives", async () => {
    const service = new VoiceTranscriptionService();
    const p = service.start(BASE_SETTINGS);
    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    let drained = false;
    const stopPromise = service.stopGracefully().then(() => {
      drained = true;
    });

    expect(drained).toBe(false);
    vi.advanceTimersByTime(3001);
    await stopPromise;
    expect(drained).toBe(true);
  });

  it("emits error and error status on connection error", async () => {
    const service = new VoiceTranscriptionService();
    const events: Array<{ type: string; message?: string; status?: string }> = [];
    service.onEvent((e) => events.push(e));

    const p = service.start(BASE_SETTINGS);
    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    conn.emit(deepgramMock.LiveTranscriptionEvents.Error, new Error("websocket died"));

    const errorEvent = events.find((e) => e.type === "error");
    const statusEvent = events.find((e) => e.type === "status" && e.status === "error");
    expect(errorEvent).toBeDefined();
    expect(statusEvent).toBeDefined();
  });

  it("times out with an error if connection does not open within 10s", async () => {
    const service = new VoiceTranscriptionService();
    const statuses: string[] = [];
    service.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
    });

    const startPromise = service.start(BASE_SETTINGS);
    vi.advanceTimersByTime(10001);
    const result = await startPromise;

    expect(result).toEqual({ ok: false, error: "Connection timed out" });
    expect(statuses).toContain("error");
  });

  describe("paragraphing strategy — Deepgram connection options", () => {
    it("spoken-command strategy sends dictation:true and punctuate:true to Deepgram", async () => {
      const capturedOpts: Record<string, unknown>[] = [];
      deepgramMock.mockClient.listen.live = (opts: unknown) => {
        capturedOpts.push(opts as Record<string, unknown>);
        const conn = new deepgramMock.MockConnection();
        deepgramMock.instances.push(conn);
        return conn;
      };

      const service = new VoiceTranscriptionService();
      void service.start({ ...BASE_SETTINGS, paragraphingStrategy: "spoken-command" });

      expect(capturedOpts[0]).toMatchObject({ dictation: true, punctuate: true });
      expect(capturedOpts[0]).not.toHaveProperty("paragraphs");
      expect(capturedOpts[0].endpointing).toBe(800);
    });

    it("manual strategy does not send dictation or punctuate to Deepgram", async () => {
      const capturedOpts: Record<string, unknown>[] = [];
      deepgramMock.mockClient.listen.live = (opts: unknown) => {
        capturedOpts.push(opts as Record<string, unknown>);
        const conn = new deepgramMock.MockConnection();
        deepgramMock.instances.push(conn);
        return conn;
      };

      const service = new VoiceTranscriptionService();
      void service.start({ ...BASE_SETTINGS, paragraphingStrategy: "manual" });

      expect(capturedOpts[0]).not.toHaveProperty("dictation");
      expect(capturedOpts[0]).not.toHaveProperty("paragraphs");
      expect(capturedOpts[0].endpointing).toBe(800);
    });

    it("defaults to spoken-command when paragraphingStrategy is undefined", async () => {
      const capturedOpts: Record<string, unknown>[] = [];
      deepgramMock.mockClient.listen.live = (opts: unknown) => {
        capturedOpts.push(opts as Record<string, unknown>);
        const conn = new deepgramMock.MockConnection();
        deepgramMock.instances.push(conn);
        return conn;
      };

      const service = new VoiceTranscriptionService();
      // Simulate a stored settings object without the new field (pre-migration)
      void service.start({
        ...BASE_SETTINGS,
        paragraphingStrategy: undefined as unknown as "spoken-command",
      });

      expect(capturedOpts[0]).toMatchObject({ dictation: true, punctuate: true });
    });
  });

  describe("paragraph boundary detection via \\n\\n in transcript", () => {
    it("emits complete + paragraph_boundary + complete when speech_final contains \\n\\n", async () => {
      const service = new VoiceTranscriptionService();
      const events: Array<{ type: string; text?: string }> = [];
      service.onEvent((e) => {
        if (e.type === "complete" || e.type === "paragraph_boundary") events.push(e);
      });

      const p = service.start(BASE_SETTINGS);
      deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;

      const conn = deepgramMock.instances.at(-1)!;
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("First paragraph.\n\nSecond paragraph.", true, true)
      );

      expect(events).toEqual([
        { type: "complete", text: "First paragraph." },
        { type: "paragraph_boundary" },
        { type: "complete", text: "Second paragraph." },
      ]);
    });

    it("does not emit paragraph_boundary for transcripts without \\n\\n", async () => {
      const service = new VoiceTranscriptionService();
      const boundaries: unknown[] = [];
      service.onEvent((e) => {
        if (e.type === "paragraph_boundary") boundaries.push(e);
      });

      const p = service.start(BASE_SETTINGS);
      deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;

      const conn = deepgramMock.instances.at(-1)!;
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("No paragraph break here.", true, true)
      );

      expect(boundaries).toHaveLength(0);
    });
  });

  it("does not emit complete for empty speech_final transcripts", async () => {
    const service = new VoiceTranscriptionService();
    const completes: string[] = [];
    service.onEvent((e) => {
      if (e.type === "complete") completes.push(e.text);
    });

    const p = service.start(BASE_SETTINGS);
    deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
    await p;

    const conn = deepgramMock.instances.at(-1)!;
    conn.emit(deepgramMock.LiveTranscriptionEvents.Transcript, makeTranscriptEvent("", true, true));

    expect(completes).toHaveLength(0);
  });
});
