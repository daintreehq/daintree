import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wsMock = vi.hoisted(() => {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    private handlers = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(
      public readonly _url: string,
      public readonly _options?: Record<string, unknown>
    ) {
      instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      const listeners = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
      listeners.add(handler);
      this.handlers.set(event, listeners);
      return this;
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    terminate() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    emit(event: string, ...args: unknown[]) {
      const listeners = this.handlers.get(event);
      if (!listeners) return;
      for (const handler of listeners) {
        handler(...args);
      }
    }

    open() {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }
  }

  const instances: MockWebSocket[] = [];

  return { MockWebSocket, instances };
});

vi.mock("ws", () => ({
  default: wsMock.MockWebSocket,
}));

import { VoiceTranscriptionService } from "../VoiceTranscriptionService.js";

describe("VoiceTranscriptionService", () => {
  beforeEach(() => {
    wsMock.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("transitions from connecting to recording when the websocket opens", async () => {
    const service = new VoiceTranscriptionService();
    const statuses: string[] = [];

    service.onEvent((event) => {
      if (event.type === "status") {
        statuses.push(event.status);
      }
    });

    const startPromise = service.start({
      enabled: true,
      apiKey: "sk-test",
      language: "en",
      customDictionary: [],
      transcriptionModel: "gpt-4o-mini-transcribe" as const,
      correctionEnabled: false,
      correctionModel: "gpt-5-nano" as const,
      correctionSystemPrompt: "",
    });

    expect(statuses).toContain("connecting");

    const socket = wsMock.instances.at(-1);
    expect(socket).toBeDefined();

    socket?.open();

    await expect(startPromise).resolves.toEqual({ ok: true });
    expect(statuses.at(-1)).toBe("recording");
  });

  it("does not emit idle when start() replaces a previous session", async () => {
    const service = new VoiceTranscriptionService();
    const events: Array<{ type: string; status?: string }> = [];

    service.onEvent((event) => events.push(event));

    const settings = {
      enabled: true,
      apiKey: "sk-test",
      language: "en",
      customDictionary: [],
      transcriptionModel: "gpt-4o-mini-transcribe" as const,
      correctionEnabled: false,
      correctionModel: "gpt-5-nano" as const,
      correctionSystemPrompt: "",
    };

    // Start first session
    const firstPromise = service.start(settings);
    const firstSocket = wsMock.instances.at(-1)!;
    firstSocket.open();
    await firstPromise;

    // Clear events from first session
    events.length = 0;

    // Start second session (replaces first)
    const secondPromise = service.start(settings);
    const secondSocket = wsMock.instances.at(-1)!;

    // The cleanup of the first session must NOT have emitted idle
    const idleBeforeConnect = events.filter((e) => e.type === "status" && e.status === "idle");
    expect(idleBeforeConnect).toHaveLength(0);

    secondSocket.open();
    await secondPromise;
  });

  it("settles a pending start when the session is stopped before connect completes", async () => {
    const service = new VoiceTranscriptionService();

    const startPromise = service.start({
      enabled: true,
      apiKey: "sk-test",
      language: "en",
      customDictionary: [],
      transcriptionModel: "gpt-4o-mini-transcribe" as const,
      correctionEnabled: false,
      correctionModel: "gpt-5-nano" as const,
      correctionSystemPrompt: "",
    });

    service.stop();

    await expect(startPromise).resolves.toEqual({
      ok: false,
      error: "Voice session stopped",
    });
  });
});
