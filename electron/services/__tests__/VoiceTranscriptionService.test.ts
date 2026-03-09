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
  let originalLiveFn: (opts: unknown) => InstanceType<typeof deepgramMock.MockConnection>;

  beforeEach(() => {
    deepgramMock.instances.length = 0;
    // Save original listen.live so option-mapping tests can restore it
    originalLiveFn = deepgramMock.mockClient.listen.live;
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Restore listen.live in case an option-mapping test replaced it
    deepgramMock.mockClient.listen.live = originalLiveFn;
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

    it("spoken-command strategy does not enable dictation for non-English languages", async () => {
      const capturedOpts: Record<string, unknown>[] = [];
      deepgramMock.mockClient.listen.live = (opts: unknown) => {
        capturedOpts.push(opts as Record<string, unknown>);
        const conn = new deepgramMock.MockConnection();
        deepgramMock.instances.push(conn);
        return conn;
      };

      const service = new VoiceTranscriptionService();
      void service.start({
        ...BASE_SETTINGS,
        paragraphingStrategy: "spoken-command",
        language: "es",
      });

      expect(capturedOpts[0]).not.toHaveProperty("dictation");
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

    it("ignores leading and trailing \\n\\n — no spurious boundary events", async () => {
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
        makeTranscriptEvent("\n\nOnly one paragraph.\n\n", true, true)
      );

      expect(events).toEqual([{ type: "complete", text: "Only one paragraph." }]);
    });

    it("collapses repeated \\n\\n delimiters to a single boundary", async () => {
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
        makeTranscriptEvent("First.\n\n\n\nSecond.", true, true)
      );

      expect(events).toEqual([
        { type: "complete", text: "First." },
        { type: "paragraph_boundary" },
        { type: "complete", text: "Second." },
      ]);
    });

    it("does not split on single \\n — only \\n\\n triggers a boundary", async () => {
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
        makeTranscriptEvent("Line one.\nLine two.", true, true)
      );

      // A single \n is not a paragraph boundary — the text contains it but is not split
      expect(events.filter((e) => e.type === "paragraph_boundary")).toHaveLength(0);
      expect(events.filter((e) => e.type === "complete")).toHaveLength(1);
    });

    it("emits paragraph boundary via UtteranceEnd flush when accumulated text contains \\n\\n", async () => {
      const service = new VoiceTranscriptionService();
      const events: Array<{ type: string; text?: string }> = [];
      service.onEvent((e) => {
        if (e.type === "complete" || e.type === "paragraph_boundary") events.push(e);
      });

      const p = service.start(BASE_SETTINGS);
      deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;

      const conn = deepgramMock.instances.at(-1)!;
      // Accumulate an is_final segment with \n\n
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Part one.\n\nPart two.", true, false)
      );
      // UtteranceEnd flushes the accumulated segments
      conn.emit(deepgramMock.LiveTranscriptionEvents.UtteranceEnd);

      expect(events).toEqual([
        { type: "complete", text: "Part one." },
        { type: "paragraph_boundary" },
        { type: "complete", text: "Part two." },
      ]);
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

  describe("paragraph boundary detection from is_final segments", () => {
    async function startService(): Promise<{
      service: VoiceTranscriptionService;
      conn: (typeof deepgramMock.instances)[number];
      events: Array<{ type: string; text?: string }>;
    }> {
      const service = new VoiceTranscriptionService();
      const events: Array<{ type: string; text?: string }> = [];
      service.onEvent((e) => events.push(e));

      const p = service.start(BASE_SETTINGS);
      const conn = deepgramMock.instances.at(-1)!;
      conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;

      return { service, conn, events };
    }

    it("leading \\n\\n in is_final flushes current utterance and emits paragraph_boundary", async () => {
      const { conn, events } = await startService();

      // First paragraph — two is_final segments
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("First paragraph.", true, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("More of first.", true, false)
      );

      // Deepgram signals new paragraph with leading \n\n on next is_final
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nSecond paragraph.", true, false)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes).toEqual(["First paragraph. More of first."]);
      expect(boundaries).toHaveLength(1);
    });

    it("leading \\n\\n in is_final: text after boundary accumulates for next speech_final", async () => {
      const { conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para one.", true, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nPara two start", true, false)
      );
      // speech_final finalizes para two
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para two start and end.", true, true)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes[0]).toBe("Para one.");
      expect(boundaries).toHaveLength(1);
      // Para two is finalized by speech_final — it joins the after-boundary segment
      expect(completes[1]).toContain("Para two");
    });

    it("embedded \\n\\n in is_final splits at boundary and accumulates remainder", async () => {
      const { conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("End of para one.\n\nStart of para two.", true, false)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes).toEqual(["End of para one."]);
      expect(boundaries).toHaveLength(1);
    });

    it("\\n\\n-only is_final flushes current utterance and emits boundary with no new text", async () => {
      const { conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para one text.", true, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\n", true, false)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes).toEqual(["Para one text."]);
      expect(boundaries).toHaveLength(1);
    });

    it("paragraph boundary in is_final does not emit duplicate complete when speech_final follows", async () => {
      const { conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para one.", true, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nPara two.", true, false)
      );
      // speech_final for para two
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para two.", true, true)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      // Para one flushed at boundary, para two finalized at speech_final — exactly 2 completes
      expect(completes).toHaveLength(2);
      expect(completes[0]).toBe("Para one.");
      expect(boundaries).toHaveLength(1);
    });

    it("is_final without \\n\\n still accumulates normally", async () => {
      const { conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Hello world", true, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("how are you", true, true)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes).toEqual(["Hello world how are you"]);
      expect(boundaries).toHaveLength(0);
    });

    it("leading \\n\\n on first-ever is_final (empty utteranceSegments) emits no boundary", async () => {
      const { conn, events } = await startService();

      // First segment ever received starts with \n\n — there is no previous paragraph to close
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nFirst text.", true, false)
      );

      // No complete and no boundary — nothing to close yet
      const completesBefore = events.filter((e) => e.type === "complete");
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");
      expect(completesBefore).toHaveLength(0);
      expect(boundaries).toHaveLength(0);

      // The text after \n\n should have been accumulated, so speech_final finalizes it
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("First text continued.", true, true)
      );
      const completesAfter = events.filter((e) => e.type === "complete").map((e) => e.text);
      expect(completesAfter).toHaveLength(1);
      expect(completesAfter[0]).toContain("First text");
    });

    it("emits events in correct order: complete → paragraph_boundary", async () => {
      const { conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para one text.", true, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nPara two start.", true, false)
      );

      const relevant = events.filter(
        (e) => e.type === "complete" || e.type === "paragraph_boundary"
      );
      expect(relevant).toHaveLength(2);
      expect(relevant[0]).toEqual({ type: "complete", text: "Para one text." });
      expect(relevant[1]).toEqual({ type: "paragraph_boundary" });
    });

    it("UtteranceEnd after paragraph boundary flushes the new paragraph correctly", async () => {
      const { conn, events } = await startService();

      // Para one ends, \n\n detected, Para two starts
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para one.", true, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nPara two text.", true, false)
      );

      // UtteranceEnd fires (instead of speech_final) to finalize para two
      conn.emit(deepgramMock.LiveTranscriptionEvents.UtteranceEnd);

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes).toEqual(["Para one.", "Para two text."]);
      expect(boundaries).toHaveLength(1);
    });

    it("three paragraphs in one session produce two boundaries", async () => {
      const { conn, events } = await startService();

      // Para one accumulates as is_final
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para one.", true, false)
      );
      // \n\n → flush Para one, boundary 1, start Para two
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nPara two.", true, false)
      );
      // \n\n → flush Para two, boundary 2, start Para three
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("\n\nPara three.", true, false)
      );
      // speech_final finalizes Para three
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para three end.", true, true)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes[0]).toBe("Para one.");
      expect(completes[1]).toBe("Para two.");
      expect(boundaries).toHaveLength(2);
      expect(completes.at(-1)).toContain("Para three");
    });

    it("speech_final with embedded \\n\\n splits via emitCompleteWithParagraphDetection", async () => {
      const { conn, events } = await startService();

      // speech_final itself contains \n\n — the existing speechFinal path handles this
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Para one text.\n\nPara two text.", true, true)
      );

      const completes = events.filter((e) => e.type === "complete").map((e) => e.text);
      const boundaries = events.filter((e) => e.type === "paragraph_boundary");

      expect(completes).toEqual(["Para one text.", "Para two text."]);
      expect(boundaries).toHaveLength(1);
    });
  });

  describe("commitParagraphBoundary — manual paragraph flush coordination", () => {
    async function startService() {
      const service = new VoiceTranscriptionService();
      const events: Array<{ type: string; text?: string }> = [];
      service.onEvent((e) => {
        if (e.type === "complete" || e.type === "delta" || e.type === "paragraph_boundary") {
          events.push(e);
        }
      });
      const p = service.start(BASE_SETTINGS);
      const conn = deepgramMock.instances.at(-1)!;
      conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;
      return { service, events, conn };
    }

    it("returns empty string when no utterance is in flight", async () => {
      const { service } = await startService();
      expect(service.commitParagraphBoundary()).toBe("");
    });

    it("returns accumulated delta text (liveText) and clears utterance state", async () => {
      const { service, conn } = await startService();

      // Interim delta builds liveText
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("how are", false, false)
      );

      expect(service.commitParagraphBoundary()).toBe("how are");

      // Subsequent call returns empty — utterance state was cleared
      expect(service.commitParagraphBoundary()).toBe("");
    });

    it("returns is_final accumulated text (which is_final also stores in liveText)", async () => {
      const { service, conn } = await startService();

      // is_final events accumulate in utteranceSegments AND update liveText via
      // emitIncrementalDelta, so commitParagraphBoundary returns the liveText value.
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("hello world", true, false)
      );
      expect(service.commitParagraphBoundary()).toBe("hello world");
    });

    it("late speech_final after commitParagraphBoundary does not emit complete", async () => {
      const { service, conn, events } = await startService();

      // Build up some interim state
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("how are you", false, false)
      );

      service.commitParagraphBoundary();
      events.length = 0; // Reset after capture

      // Deepgram sends speech_final for the consumed utterance
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("how are you doing", true, true)
      );

      expect(events.filter((e) => e.type === "complete")).toHaveLength(0);
    });

    it("late UtteranceEnd after commitParagraphBoundary does not emit complete", async () => {
      const { service, conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("in flight", false, false)
      );

      service.commitParagraphBoundary();
      events.length = 0;

      conn.emit(deepgramMock.LiveTranscriptionEvents.UtteranceEnd);

      expect(events.filter((e) => e.type === "complete")).toHaveLength(0);
    });

    it("is_final events after commitParagraphBoundary (before speech_final) are suppressed", async () => {
      const { service, conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("first words", false, false)
      );

      service.commitParagraphBoundary();
      events.length = 0;

      // is_final event for the suppressed utterance
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("first words extended", true, false)
      );

      expect(events.filter((e) => e.type === "delta")).toHaveLength(0);
    });

    it("suppression clears after speech_final — new utterance events flow normally", async () => {
      const { service, conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("first paragraph", false, false)
      );

      service.commitParagraphBoundary();

      // speech_final clears suppression
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("first paragraph final", true, true)
      );

      events.length = 0;

      // New utterance after the boundary should flow normally
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("second paragraph", false, false)
      );
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("second paragraph done", true, true)
      );

      expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(0);
      expect(events.filter((e) => e.type === "complete")).toHaveLength(1);
      expect(events.find((e) => e.type === "complete")?.text).toBe("second paragraph done");
    });

    it("suppression clears after UtteranceEnd — new utterance events flow normally", async () => {
      const { service, conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("first", false, false)
      );

      service.commitParagraphBoundary();

      conn.emit(deepgramMock.LiveTranscriptionEvents.UtteranceEnd);

      events.length = 0;

      // New utterance after boundary
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("after boundary", true, true)
      );

      expect(events.filter((e) => e.type === "complete")).toHaveLength(1);
      expect(events.find((e) => e.type === "complete")?.text).toBe("after boundary");
    });

    it("rapid back-to-back commitParagraphBoundary calls are safe", async () => {
      const { service, conn, events } = await startService();

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("first", false, false)
      );

      const text1 = service.commitParagraphBoundary();
      // Second call finds no in-flight text — returns "" and does NOT clear the
      // first call's suppression flag (only armed when non-empty text was captured).
      const text2 = service.commitParagraphBoundary();

      expect(text1).toBe("first");
      expect(text2).toBe("");

      events.length = 0;

      // Late speech_final for the original utterance should still be suppressed.
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("first extended", true, true)
      );

      expect(events.filter((e) => e.type === "complete")).toHaveLength(0);

      // New utterance after suppression clears flows normally.
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("new paragraph text", true, true)
      );

      expect(events.filter((e) => e.type === "complete")).toHaveLength(1);
      expect(events.find((e) => e.type === "complete")?.text).toBe("new paragraph text");
    });
  });

  describe("realistic Deepgram payload scenarios", () => {
    it("ignores alternatives[0].paragraphs field and emits complete from transcript text only", async () => {
      const service = new VoiceTranscriptionService();
      const events: Array<{ type: string; text?: string }> = [];
      service.onEvent((e) => {
        if (e.type === "complete" || e.type === "paragraph_boundary") events.push(e);
      });

      const p = service.start(BASE_SETTINGS);
      deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;

      const conn = deepgramMock.instances.at(-1)!;
      // Full-shape Deepgram response object with a paragraphs field (REST-only)
      conn.emit(deepgramMock.LiveTranscriptionEvents.Transcript, {
        channel: {
          alternatives: [
            {
              transcript: "Hello world",
              paragraphs: {
                paragraphs: [
                  {
                    sentences: [{ text: "Hello world", start: 0, end: 1.5 }],
                    start: 0,
                    end: 1.5,
                  },
                ],
              },
            },
          ],
        },
        is_final: true,
        speech_final: true,
      });

      // Only transcript text is used — paragraphs field is ignored
      expect(events).toEqual([{ type: "complete", text: "Hello world" }]);
    });

    it("non-prefix interim revision produces correct final text without spurious events", async () => {
      const service = new VoiceTranscriptionService();
      const deltas: string[] = [];
      const completes: string[] = [];
      service.onEvent((e) => {
        if (e.type === "delta") deltas.push(e.text);
        if (e.type === "complete") completes.push(e.text);
      });

      const p = service.start(BASE_SETTINGS);
      deepgramMock.instances.at(-1)!.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;

      const conn = deepgramMock.instances.at(-1)!;

      // Interim 1: "hell" — first delta emitted
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("hell", false, false)
      );
      expect(deltas).toEqual(["hell"]);

      // Interim 2: "help" — non-prefix revision (not an extension of "hell"),
      // triggers the silent liveText update path (no delta emitted)
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("help", false, false)
      );
      expect(deltas).toEqual(["hell"]); // No new delta

      // Interim 3: "help me" — prefix extension of revised "help" baseline,
      // proves the liveText baseline was correctly updated so delta emission recovers
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("help me", false, false)
      );
      expect(deltas).toEqual(["hell", " me"]); // " me" delta from "help" → "help me"

      // speech_final: "Hello world" — produces exactly one complete event
      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("Hello world", true, true)
      );

      expect(completes).toEqual(["Hello world"]);
      // No spurious complete for the intermediate "help" or "help me"
      expect(completes).toHaveLength(1);
    });
  });

  describe("status sequence regression — finishing phase", () => {
    async function startService() {
      const service = new VoiceTranscriptionService();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });
      const p = service.start(BASE_SETTINGS);
      const conn = deepgramMock.instances.at(-1)!;
      conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await p;
      return { service, statuses, conn };
    }

    it("emits finishing status during graceful stop before idle", async () => {
      const { service, statuses, conn } = await startService();

      const stopPromise = service.stopGracefully();
      expect(statuses).toContain("finishing");

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("", true, true)
      );
      await stopPromise;

      expect(statuses.at(-1)).toBe("idle");
    });

    it("full status sequence: connecting → recording → finishing → idle", async () => {
      const service = new VoiceTranscriptionService();
      const statuses: string[] = [];
      service.onEvent((e) => {
        if (e.type === "status") statuses.push(e.status);
      });

      const startPromise = service.start(BASE_SETTINGS);
      expect(statuses).toContain("connecting");

      const conn = deepgramMock.instances.at(-1)!;
      conn.emit(deepgramMock.LiveTranscriptionEvents.Open);
      await startPromise;
      expect(statuses).toContain("recording");

      const stopPromise = service.stopGracefully();
      expect(statuses).toContain("finishing");

      conn.emit(
        deepgramMock.LiveTranscriptionEvents.Transcript,
        makeTranscriptEvent("last words", true, true)
      );
      await stopPromise;

      expect(statuses).toEqual(["connecting", "recording", "finishing", "idle"]);
    });
  });
});
