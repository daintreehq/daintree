import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTranscriptionMock, type TranscriptionMock } from "../transcriptionMock";
import { buildWav, fakeMicrophoneArgs, pcmPeak } from "../fakeMicrophone";

let mock: TranscriptionMock;
const open: WebSocket[] = [];

async function connect(
  url: string
): Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }> {
  const ws = new WebSocket(url);
  open.push(ws);
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages };
}

const until = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  mock = await createTranscriptionMock();
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await mock.close();
});

describe("transcription mock — OpenAI protocol", () => {
  it("acks session.update, records appended audio, and plays a scripted segment on commit", async () => {
    mock.script({ text: "hello world", deltas: ["hel", "hello"] });
    const { ws, messages } = await connect(mock.openaiUrl);
    ws.send(JSON.stringify({ type: "session.update", session: {} }));
    await until(() => messages.some((m) => m.type === "session.updated"));

    const pcm = Buffer.alloc(6_000, 1);
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await until(() => messages.some((m) => m.type === "conversation.item.done"));

    expect(mock.audioBytes("openai")).toBe(6_000);
    expect(mock.pcm().equals(pcm)).toBe(true);
    expect(mock.control.map((c) => c.type)).toEqual([
      "session.update",
      "input_audio_buffer.commit",
    ]);
    expect(messages.map((m) => m.type)).toEqual([
      "session.updated",
      "input_audio_buffer.committed",
      "conversation.item.input_audio_transcription.delta",
      "conversation.item.input_audio_transcription.delta",
      "conversation.item.added",
      "conversation.item.done",
    ]);
    const done = messages.at(-1) as { item: { content: Array<{ transcript: string }> } };
    expect(done.item.content[0].transcript).toBe("hello world");
  });

  it("does not consume a segment for a commit with no audio behind it", async () => {
    mock.script({ text: "kept" });
    const { ws, messages } = await connect(mock.openaiUrl);
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await until(() => messages.some((m) => m.type === "input_audio_buffer.committed"));
    ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.alloc(6_000).toString("base64"),
      })
    );
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await until(() => messages.some((m) => m.type === "conversation.item.done"));
  });
});

describe("transcription mock — silence and ordering", () => {
  it("answers an empty scripted segment with an authoritative empty completion", async () => {
    mock.script({ text: "" });
    const { ws, messages } = await connect(mock.openaiUrl);
    ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.alloc(6_000).toString("base64"),
      })
    );
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await until(() =>
      messages.some((m) => m.type === "conversation.item.input_audio_transcription.completed")
    );
    expect(messages.some((m) => m.type === "conversation.item.done")).toBe(false);
  });

  it("holds a Deepgram close until an earlier delayed Finalize result has been sent", async () => {
    mock.script({ text: "slow", delayMs: 150 });
    const { ws, messages } = await connect(mock.deepgramUrl);
    ws.send(Buffer.alloc(3_000));
    ws.send(JSON.stringify({ type: "Finalize" }));
    ws.send(JSON.stringify({ type: "CloseStream" }));
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    expect(messages.some((m) => m.is_final === true)).toBe(true);
  });
});

describe("transcription mock — Deepgram protocol", () => {
  it("records binary audio, finalizes on Finalize, and flushes then closes on CloseStream", async () => {
    mock.script({ text: "first" }, { text: "second", deltas: ["sec"] });
    const { ws, messages } = await connect(`${mock.deepgramUrl}?encoding=linear16`);
    ws.send(Buffer.alloc(3_000, 2));
    ws.send(JSON.stringify({ type: "Finalize" }));
    await until(() => messages.some((m) => m.is_final === true));
    ws.send(Buffer.alloc(3_000, 2));
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    ws.send(JSON.stringify({ type: "CloseStream" }));
    expect(await closed).toBe(1000);

    expect(mock.audioBytes("deepgram")).toBe(6_000);
    const results = messages.filter((m) => m.type === "Results") as Array<{
      is_final: boolean;
      from_finalize: boolean;
      channel: { alternatives: Array<{ transcript: string }> };
    }>;
    expect(results.map((r) => [r.channel.alternatives[0].transcript, r.is_final])).toEqual([
      ["first", true],
      ["sec", false],
      ["second", true],
    ]);
    expect(results[0].from_finalize).toBe(true);
    expect(mock.connections[0].url).toContain("encoding=linear16");
  });
});

describe("transcription mock — lifecycle", () => {
  it("points both providers at distinct paths and clears state on reset", async () => {
    expect(mock.env().DAINTREE_REALTIME_WS_URL).toBe(mock.openaiUrl);
    expect(mock.env().DAINTREE_DEEPGRAM_WS_URL).toBe(mock.deepgramUrl);
    const { ws } = await connect(mock.deepgramUrl);
    ws.send(Buffer.alloc(10));
    await until(() => mock.audioBytes() === 10);
    mock.reset();
    expect(mock.audioBytes()).toBe(0);
    expect(mock.connections).toEqual([]);
  });

  it("waitForAudioBytes rejects when the audio never arrives", async () => {
    await expect(mock.waitForAudioBytes(1, 100)).rejects.toThrow(/wanted 1/);
  });
});

describe("fake microphone helpers", () => {
  it("builds a valid mono s16 WAV with the requested tone", () => {
    const wav = buildWav({ seconds: 0.5, sampleRate: 24_000, amplitude: 0.5 });
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(12_000 * 2);
    expect(wav.length).toBe(44 + 12_000 * 2);
    expect(pcmPeak(wav.subarray(44))).toBeGreaterThan(15_000);
    expect(pcmPeak(buildWav({ seconds: 0.1, frequency: 0 }).subarray(44))).toBe(0);
  });

  it("marks a one-shot file with Chromium's %noloop suffix", () => {
    expect(fakeMicrophoneArgs("/a.wav")).toContain("--use-file-for-fake-audio-capture=/a.wav");
    expect(fakeMicrophoneArgs("/a.wav", false)).toContain(
      "--use-file-for-fake-audio-capture=/a.wav%noloop"
    );
  });
});
