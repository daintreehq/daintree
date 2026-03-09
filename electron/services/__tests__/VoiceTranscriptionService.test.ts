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
});
