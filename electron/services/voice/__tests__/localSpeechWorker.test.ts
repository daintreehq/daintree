import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalSpeechWorkerInbound,
  LocalSpeechWorkerOutbound,
} from "../localSpeechWorkerProtocol.js";

// 100 ms of 24 kHz capture, as the renderer sends it.
const PACKET_SAMPLES = 2_400;
// The worker's chunk: 560 ms at 16 kHz.
const CHUNK_SAMPLES = 8_960;

type VadCallbacks = {
  onFrameProcessed: () => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onVADMisfire: () => void;
};

const script = vi.hoisted(() => ({
  /** Per audio packet, in order: VAD callbacks to fire, as frame offsets inside it. */
  vad: [] as Array<Array<"start" | "end">>,
  /** Per decoded chunk (priming excluded): tokens as [id, frame]. */
  tokens: [] as Array<Array<[number, number]>>,
  chunks: 0,
}));

vi.mock("avr-vad", () => ({
  RealTimeVAD: {
    new: async (options: VadCallbacks) => {
      let packet = 0;
      return {
        start: () => {},
        destroy: async () => {},
        processAudio: async (samples: Float32Array) => {
          // avr-vad works in 32 ms frames at 16 kHz: about three a packet.
          const frames = Math.round(((samples.length / 24_000) * 1000) / 32);
          const events = script.vad[packet++] ?? [];
          for (let f = 0; f < frames; f++) {
            options.onFrameProcessed();
            if (f === 0 && events[0] === "end") options.onSpeechEnd();
            if (f === 0 && events[0] === "start") options.onSpeechStart();
            if (f === 1 && events[1] === "start") options.onSpeechStart();
            if (f === 1 && events[1] === "end") options.onSpeechEnd();
          }
        },
      };
    },
  },
}));

const PIECES = ["▁send", "▁it", "▁to", "▁the", "▁tests"];

vi.mock("../localSpeechEngine.js", () => ({
  FRAMES_PER_CHUNK: 7,
  LocalSpeechEngine: {
    load: async () => {
      let primed = false;
      return {
        vocabulary: {
          decode: (ids: number[]) => ids.map((id) => PIECES[id].replace("▁", " ")).join(""),
          startsWord: (id: number) => PIECES[id].startsWith("▁"),
        },
        reset: () => {
          primed = false;
          script.chunks = 0;
        },
        setPromptId: () => {},
        decodeChunk: async (chunk: Float32Array) => {
          expect(chunk.length).toBe(CHUNK_SAMPLES);
          if (!primed) {
            primed = true;
            return [];
          }
          const tokens = script.tokens[script.chunks++] ?? [];
          return tokens.map(([id, frame]) => ({ id, frame }));
        },
        release: async () => {},
      };
    },
  },
}));

let posted: LocalSpeechWorkerOutbound[];
let listener: ((event: { data: LocalSpeechWorkerInbound }) => void) | null;

async function bootWorker() {
  posted = [];
  listener = null;
  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (_event: string, l: typeof listener) => {
      listener = l;
    },
    postMessage: (message: LocalSpeechWorkerOutbound) => posted.push(message),
  };
  vi.resetModules();
  await import("../localSpeechWorker.js");
  send({ type: "load", dir: "/model", threads: 2 });
  await vi.waitFor(() =>
    expect(posted).toContainEqual({ type: "ready", loadMs: expect.any(Number) })
  );
}

function send(message: LocalSpeechWorkerInbound) {
  listener!({ data: message });
}

async function start(session = 1) {
  send({ type: "start", session, promptId: 0 });
  await vi.waitFor(() => expect(posted).toContainEqual({ type: "started", session, vad: true }));
}

function packets(count: number, session = 1) {
  for (let i = 0; i < count; i++) {
    send({ type: "audio", session, pcm: new Int16Array(PACKET_SAMPLES).buffer });
  }
}

const segments = () => posted.filter((m) => m.type === "segment");

beforeEach(async () => {
  script.vad = [];
  script.tokens = [];
  script.chunks = 0;
  await bootWorker();
});

afterEach(() => {
  delete (process as unknown as { parentPort?: unknown }).parentPort;
});

describe("localSpeechWorker", () => {
  it("closes a passage at its pause with end of speech when silence follows", async () => {
    await start();
    // "send it" in the first chunk; the VAD hears speech end in packet 12
    // (its speech ended ~770 ms earlier, inside the first chunk's audio).
    script.tokens = [
      [
        [0, 1],
        [1, 3],
      ],
      [],
      [],
      [],
    ];
    script.vad[0] = ["start"];
    script.vad[11] = ["end"];
    packets(14);
    await vi.waitFor(() => expect(segments()).toHaveLength(1));
    expect(segments()[0]).toMatchObject({
      text: "send it",
      reason: "pause",
      endOfSpeech: true,
    });
  });

  it("never marks end of speech when the speaker resumes in the packet the pause closes in", async () => {
    await start();
    script.tokens = [
      [
        [0, 1],
        [1, 3],
      ],
      [],
      [],
      [],
    ];
    script.vad[0] = ["start"];
    // The holdover runs out and speech starts again inside one packet.
    script.vad[11] = ["end", "start"];
    packets(14);
    await vi.waitFor(() => expect(segments()).toHaveLength(1));
    expect(segments()[0]).toMatchObject({ text: "send it", reason: "pause", endOfSpeech: false });
    const speechStarts = posted.filter((m) => m.type === "speech-start");
    expect(speechStarts).toHaveLength(2);
  });

  it("puts words decoded after the pause point in the next passage", async () => {
    await start();
    // Chunk 2 (1120-1680 ms) brings "to the tests", after the pause closed at ~730 ms.
    script.tokens = [
      [
        [0, 1],
        [1, 3],
      ],
      [],
      [
        [2, 1],
        [3, 2],
        [4, 4],
      ],
    ];
    script.vad[0] = ["start"];
    script.vad[11] = ["end", "start"];
    packets(18);
    send({ type: "finish", session: 1 });
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "finished", session: 1 }));
    expect(segments().map((s) => [s.text, s.reason])).toEqual([
      ["send it", "pause"],
      ["to the tests", "finish"],
    ]);
  });

  it("transcribes the last part-chunk on stop, finished with silence", async () => {
    await start();
    script.tokens = [[[0, 2]]];
    packets(2);
    send({ type: "finish", session: 1 });
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "finished", session: 1 }));
    expect(segments()).toEqual([
      expect.objectContaining({ text: "send", reason: "finish", endOfSpeech: false }),
    ]);
  });

  it("closes what was heard at Enter and carries on", async () => {
    await start();
    script.tokens = [[[0, 1]], [[2, 1]]];
    packets(2);
    send({ type: "cut", session: 1 });
    packets(6);
    send({ type: "finish", session: 1 });
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "finished", session: 1 }));
    expect(segments().map((s) => [s.text, s.reason])).toEqual([
      ["send", "cut"],
      ["to", "finish"],
    ]);
  });

  it("ignores audio for a session that isn't the live one", async () => {
    await start(1);
    await start(2);
    script.tokens = [[[0, 1]]];
    packets(6, 1);
    send({ type: "finish", session: 2 });
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "finished", session: 2 }));
    expect(posted.filter((m) => "session" in m && m.session === 1 && m.type !== "started")).toEqual(
      []
    );
  });
});
