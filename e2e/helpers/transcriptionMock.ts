import { WebSocketServer, type RawData, type WebSocket } from "ws";

export type TranscriptionProviderId = "openai" | "deepgram";

/** One scripted transcript, played out at the next segment boundary of whichever provider is connected. */
export interface ScriptedSegment {
  text: string;
  /** Interim events sent before the final one: OpenAI deltas, Deepgram non-final Results. */
  deltas?: string[];
  /** Wait this long after the boundary before sending, to model server latency. */
  delayMs?: number;
}

export interface MockConnection {
  id: number;
  provider: TranscriptionProviderId;
  send(event: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface AudioRecord {
  /** `Date.now()` when the bytes reached the mock, comparable with timestamps taken in the spec. */
  t: number;
  connection: number;
  provider: TranscriptionProviderId;
  bytes: Buffer;
}

export interface ControlRecord {
  t: number;
  connection: number;
  provider: TranscriptionProviderId;
  type: string;
  raw: Record<string, unknown>;
}

export interface SentRecord {
  t: number;
  connection: number;
  type: string;
}

export interface ConnectionRecord {
  connection: number;
  provider: TranscriptionProviderId;
  /** The upgrade request URL, so a spec can assert the query the provider built. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  openedAt: number;
  closedAt?: number;
  closeCode?: number;
}

export interface MockHooks {
  /** After the default `session.updated`, when the client sends `session.update`. */
  onSessionUpdate?: (conn: MockConnection, message: Record<string, unknown>) => void;
  /** After the default segment playback, when a segment boundary arrives (OpenAI commit, Deepgram Finalize/CloseStream). */
  onBoundary?: (conn: MockConnection, kind: "commit" | "finalize" | "close-stream") => void;
}

export interface TranscriptionMock {
  readonly port: number;
  readonly openaiUrl: string;
  readonly deepgramUrl: string;
  /** Environment overrides that point both providers at this mock. */
  env(): Record<string, string>;
  /** Queue segments; each boundary consumes one. */
  script(...segments: ScriptedSegment[]): void;
  /** Send a final transcript on every live connection of a provider now, without waiting for a boundary. */
  emit(text: string, provider?: TranscriptionProviderId): void;
  hooks: MockHooks;
  /** Don't answer `session.update`, to exercise a start that never becomes ready. */
  setAutoHandshake(enabled: boolean): void;
  readonly audio: readonly AudioRecord[];
  readonly control: readonly ControlRecord[];
  readonly sent: readonly SentRecord[];
  readonly connections: readonly ConnectionRecord[];
  audioBytes(provider?: TranscriptionProviderId): number;
  /** Every audio byte received, in arrival order across connections. */
  pcm(provider?: TranscriptionProviderId): Buffer;
  waitForAudioBytes(minBytes: number, timeoutMs: number): Promise<void>;
  dropConnections(): void;
  reset(): void;
  close(): Promise<void>;
}

// A commit under ~100ms of audio is rejected by the real server; the mock treats it as
// "nothing to transcribe" rather than modelling the error.
const OPENAI_MIN_COMMIT_BYTES = 4_800;

function jsonOf(data: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function createTranscriptionMock(): Promise<TranscriptionMock> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Mock server failed to bind");
  const port = address.port;

  let queue: ScriptedSegment[] = [];
  let audio: AudioRecord[] = [];
  let control: ControlRecord[] = [];
  let sent: SentRecord[] = [];
  let connections: ConnectionRecord[] = [];
  let autoHandshake = true;
  let nextId = 1;
  const hooks: MockHooks = {};
  const live = new Map<number, { ws: WebSocket; conn: MockConnection }>();
  const timers = new Set<NodeJS.Timeout>();
  const bytesSinceBoundary = new Map<number, number>();

  const later = (ms: number, fn: () => void): void => {
    if (ms <= 0) return fn();
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  function playOpenAI(conn: MockConnection, segment: ScriptedSegment): void {
    for (const delta of segment.deltas ?? []) {
      conn.send({ type: "conversation.item.input_audio_transcription.delta", delta });
    }
    // The `?intent=transcription` endpoint: an item shell, then the done event carrying the text.
    conn.send({ type: "conversation.item.added", item: { content: [{ type: "input_audio" }] } });
    conn.send({
      type: "conversation.item.done",
      item: { content: [{ type: "input_audio", transcript: segment.text }] },
    });
  }

  function deepgramResults(
    text: string,
    flags: { is_final: boolean; speech_final?: boolean; from_finalize?: boolean }
  ): Record<string, unknown> {
    return {
      type: "Results",
      channel_index: [0, 1],
      is_final: flags.is_final,
      speech_final: flags.speech_final ?? false,
      from_finalize: flags.from_finalize ?? false,
      channel: { alternatives: [{ transcript: text, confidence: 0.99 }] },
    };
  }

  function playDeepgram(conn: MockConnection, segment: ScriptedSegment, finalize: boolean): void {
    for (const delta of segment.deltas ?? [])
      conn.send(deepgramResults(delta, { is_final: false }));
    conn.send(deepgramResults(segment.text, { is_final: true, from_finalize: finalize }));
  }

  function boundary(
    conn: MockConnection,
    kind: "commit" | "finalize" | "close-stream",
    minBytes: number
  ): number {
    const pending = bytesSinceBoundary.get(conn.id) ?? 0;
    bytesSinceBoundary.set(conn.id, 0);
    const segment = pending >= minBytes ? queue.shift() : undefined;
    if (segment) {
      later(segment.delayMs ?? 0, () => {
        if (conn.provider === "openai") playOpenAI(conn, segment);
        else playDeepgram(conn, segment, kind === "finalize");
      });
    }
    hooks.onBoundary?.(conn, kind);
    return segment?.delayMs ?? 0;
  }

  wss.on("connection", (ws, req) => {
    const url = req.url ?? "";
    const provider: TranscriptionProviderId = url.startsWith("/deepgram") ? "deepgram" : "openai";
    const id = nextId++;
    const conn: MockConnection = {
      id,
      provider,
      send(event) {
        sent.push({ t: Date.now(), connection: id, type: String(event.type ?? "") });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      },
      close: (code, reason) => ws.close(code, reason),
      terminate: () => ws.terminate(),
    };
    const record: ConnectionRecord = {
      connection: id,
      provider,
      url,
      headers: { ...req.headers },
      openedAt: Date.now(),
    };
    connections.push(record);
    live.set(id, { ws, conn });
    bytesSinceBoundary.set(id, 0);
    ws.on("close", (code) => {
      record.closedAt = Date.now();
      record.closeCode = code;
      live.delete(id);
    });

    ws.on("message", (data, isBinary) => {
      const t = Date.now();
      if (provider === "deepgram" && isBinary) {
        const bytes = Buffer.from(data as Buffer);
        audio.push({ t, connection: id, provider, bytes });
        bytesSinceBoundary.set(id, (bytesSinceBoundary.get(id) ?? 0) + bytes.length);
        return;
      }
      const message = jsonOf(data);
      if (!message) return;
      const type = typeof message.type === "string" ? message.type : "";

      if (provider === "openai" && type === "input_audio_buffer.append") {
        const bytes = Buffer.from(String(message.audio ?? ""), "base64");
        audio.push({ t, connection: id, provider, bytes });
        bytesSinceBoundary.set(id, (bytesSinceBoundary.get(id) ?? 0) + bytes.length);
        return;
      }

      control.push({ t, connection: id, provider, type, raw: message });

      if (provider === "openai") {
        if (type === "session.update") {
          if (autoHandshake) conn.send({ type: "session.updated" });
          hooks.onSessionUpdate?.(conn, message);
        } else if (type === "input_audio_buffer.commit") {
          conn.send({ type: "input_audio_buffer.committed" });
          boundary(conn, "commit", OPENAI_MIN_COMMIT_BYTES);
        }
        return;
      }

      if (type === "Finalize") boundary(conn, "finalize", 1);
      else if (type === "CloseStream") {
        const owed = boundary(conn, "close-stream", 1);
        // The server flushes what it owes, then closes, so a scripted latency stays ahead of the close.
        later(owed + 20, () => ws.close(1000));
      }
    });

    if (provider === "deepgram" && autoHandshake) {
      conn.send({ type: "Metadata", request_id: `mock-${id}` });
    }
  });

  const filterPcm = (provider?: TranscriptionProviderId) =>
    audio.filter((a) => !provider || a.provider === provider);

  return {
    port,
    openaiUrl: `ws://127.0.0.1:${port}/openai`,
    deepgramUrl: `ws://127.0.0.1:${port}/deepgram`,
    env: () => ({
      DAINTREE_REALTIME_WS_URL: `ws://127.0.0.1:${port}/openai`,
      DAINTREE_DEEPGRAM_WS_URL: `ws://127.0.0.1:${port}/deepgram`,
    }),
    script(...segments) {
      queue.push(...segments);
    },
    emit(text, provider) {
      for (const { conn } of live.values()) {
        if (provider && conn.provider !== provider) continue;
        if (conn.provider === "openai") playOpenAI(conn, { text });
        else playDeepgram(conn, { text }, false);
      }
    },
    hooks,
    setAutoHandshake(enabled) {
      autoHandshake = enabled;
    },
    get audio() {
      return audio;
    },
    get control() {
      return control;
    },
    get sent() {
      return sent;
    },
    get connections() {
      return connections;
    },
    audioBytes: (provider) => filterPcm(provider).reduce((n, a) => n + a.bytes.length, 0),
    pcm: (provider) => Buffer.concat(filterPcm(provider).map((a) => a.bytes)),
    async waitForAudioBytes(minBytes, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (audio.reduce((n, a) => n + a.bytes.length, 0) >= minBytes) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      const got = audio.reduce((n, a) => n + a.bytes.length, 0);
      throw new Error(
        `Mock received ${got} audio bytes, wanted ${minBytes}, within ${timeoutMs}ms`
      );
    },
    dropConnections() {
      for (const { ws } of live.values()) ws.terminate();
    },
    reset() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const { ws } of live.values()) {
        try {
          ws.close();
        } catch {
          // already closing
        }
      }
      live.clear();
      queue = [];
      audio = [];
      control = [];
      sent = [];
      connections = [];
      autoHandshake = true;
      bytesSinceBoundary.clear();
      for (const key of Object.keys(hooks)) delete hooks[key as keyof MockHooks];
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const { ws } of live.values()) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
