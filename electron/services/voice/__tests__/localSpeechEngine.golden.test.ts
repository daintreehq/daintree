import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pcm16ToFloat, Resampler24kTo16k } from "../localSpeechAudio.js";
import { LocalSpeechEngine } from "../localSpeechEngine.js";
import { LOCAL_SPEECH_GEOMETRY, localSpeechPromptId } from "../localSpeechModelSpec.js";

/**
 * The real model on real speech, opt-in: set DAINTREE_LOCAL_SPEECH_MODEL_DIR to
 * a folder holding the pinned files (Settings downloads them to
 * `<userData>/voice/models/nemotron-3.5-asr-streaming-0.6b-int4/<revision>`).
 * The speech is synthesised with macOS `say`, so it runs on macOS only.
 */
const MODEL_DIR = process.env.DAINTREE_LOCAL_SPEECH_MODEL_DIR;
const runs = Boolean(MODEL_DIR) && process.platform === "darwin";

function synthesise(text: string): ArrayBuffer {
  const dir = mkdtempSync(path.join(tmpdir(), "local-speech-golden-"));
  try {
    const aiff = path.join(dir, "speech.aiff");
    const wav = path.join(dir, "speech.wav");
    execFileSync("say", ["-o", aiff, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]);
    const bytes = readFileSync(wav);
    const data = bytes.indexOf("data") + 8;
    return bytes.buffer.slice(bytes.byteOffset + data, bytes.byteOffset + bytes.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function transcribe(engine: LocalSpeechEngine, pcm: ArrayBuffer, language: string) {
  engine.reset();
  engine.setPromptId(localSpeechPromptId(language));
  await engine.decodeChunk(new Float32Array(LOCAL_SPEECH_GEOMETRY.chunkSamples));
  const resampler = new Resampler24kTo16k();
  const capture = pcm16ToFloat(pcm);
  let pending = new Float32Array(0);
  const ids: number[] = [];
  const feed = async (samples: Float32Array, final = false) => {
    const joined = new Float32Array(pending.length + samples.length);
    joined.set(pending);
    joined.set(samples, pending.length);
    pending = joined;
    while (pending.length >= LOCAL_SPEECH_GEOMETRY.chunkSamples || (final && pending.length > 0)) {
      const chunk = new Float32Array(LOCAL_SPEECH_GEOMETRY.chunkSamples);
      chunk.set(pending.subarray(0, LOCAL_SPEECH_GEOMETRY.chunkSamples));
      pending = pending.slice(LOCAL_SPEECH_GEOMETRY.chunkSamples);
      ids.push(...(await engine.decodeChunk(chunk)).map((token) => token.id));
    }
  };
  for (let i = 0; i < capture.length; i += 2_400)
    await feed(resampler.push(capture.subarray(i, i + 2_400)));
  await feed(resampler.flush(), true);
  return engine.vocabulary.decode(ids).replace(/\s+/g, " ").trim().toLowerCase();
}

describe.runIf(runs)("LocalSpeechEngine on the real model", () => {
  it("transcribes English speech", { timeout: 120_000 }, async () => {
    const ort = await import("onnxruntime-node");
    const engine = await LocalSpeechEngine.load(
      (ort as unknown as { default?: typeof ort }).default ?? ort,
      MODEL_DIR!,
      2
    );
    try {
      const text = await transcribe(
        engine,
        synthesise("Fix the failing test in the parser, then update the docs."),
        "en"
      );
      expect(text).toContain("failing test");
      expect(text).toContain("parser");
      // The stream's last words land too: the final part-chunk is decoded.
      expect(text).toMatch(/update the do/);
      // Auto-detect reads the same speech without being told its language.
      const auto = await transcribe(engine, synthesise("Then send it."), "auto");
      expect(auto).toContain("send it");
    } finally {
      await engine.release();
    }
  });
});
