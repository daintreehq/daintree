import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodePcm16Wav,
  longestUtteranceMs,
  pcmDurationMs,
  prepareClip,
  readPcm16Wav,
  REPLAY_SAMPLE_RATE,
  trimSilence,
  type PreparedClip,
  type ReplayClip,
} from "../../../e2e/helpers/voiceReplayFixtures";

/**
 * Speech for the dictation pipeline benchmark in more than one voice: macOS
 * `say` as the replay benchmark synthesises it, Gemini's TTS models, and
 * MiniMax through Replicate. A clip's `[[slnc N]]` markers are exact silences
 * in every voice: `say` renders them itself, and for the others each phrase
 * between them is synthesised alone, trimmed, and joined to the next by that
 * many milliseconds of silence.
 */

export type VoiceEngine = "say" | "gemini" | "minimax";

export interface PipelineVoice {
  /** As given on the command line: `say`, `say:Samantha`, `gemini:Puck`, `minimax:English_Wiselady`. */
  id: string;
  engine: VoiceEngine;
  /** The engine's own voice name; empty for the system `say` voice. */
  name: string;
}

const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
const MINIMAX_MODEL = "minimax/speech-2.8-hd";
// Bumped whenever how a voice's clip is built changes, so the cache rebuilds it.
const PIPELINE_AUDIO_VERSION = 1;
const SILENCE_RE = /\[\[slnc (\d+)\]\]/;

export function parseVoice(spec: string): PipelineVoice {
  const [engine, ...rest] = spec.split(":");
  const name = rest.join(":");
  if (engine === "say") return { id: spec, engine, name };
  if ((engine === "gemini" || engine === "minimax") && name) return { id: spec, engine, name };
  throw new Error(`unknown voice "${spec}" (say, say:<name>, gemini:<name>, minimax:<voice_id>)`);
}

/** The phrases between a clip's silences, each with the pause that follows it. */
export function speechPhrases(speech: string): Array<{ text: string; pauseMs: number }> {
  const parts = speech.split(SILENCE_RE);
  const phrases: Array<{ text: string; pauseMs: number }> = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i]!.trim();
    const pauseMs = i + 1 < parts.length ? Number(parts[i + 1]) : 0;
    if (text) phrases.push({ text, pauseMs });
    else if (phrases.length > 0) phrases[phrases.length - 1]!.pauseMs += pauseMs;
  }
  return phrases;
}

async function geminiSpeech(text: string, voice: string, apiKey: string): Promise<Buffer> {
  // Plain text only: the model reads a style note aloud with the words.
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    }
  );
  const body = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
    error?: { message?: string };
  };
  const data = body.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!response.ok || !data) {
    throw new Error(`Gemini TTS ${response.status}: ${body.error?.message ?? "no audio"}`);
  }
  return Buffer.from(data, "base64");
}

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

// `Prefer: wait` holds the request up to a minute, but a prediction can still
// come back starting or processing, so it is followed to a terminal state.
const REPLICATE_DEADLINE_MS = 180_000;
const REPLICATE_POLL_MS = 1_000;

async function minimaxSpeech(text: string, voice: string, token: string): Promise<Buffer> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const deadline = Date.now() + REPLICATE_DEADLINE_MS;
  const response = await fetch(`https://api.replicate.com/v1/models/${MINIMAX_MODEL}/predictions`, {
    method: "POST",
    headers: { ...headers, Prefer: "wait=60" },
    body: JSON.stringify({ input: { text, voice_id: voice, audio_format: "wav" } }),
    signal: AbortSignal.timeout(REPLICATE_DEADLINE_MS),
  });
  let prediction = (await response.json()) as ReplicatePrediction;
  if (!response.ok)
    throw new Error(`Replicate ${response.status}: ${String(prediction.error ?? "")}`);
  while (prediction.status === "starting" || prediction.status === "processing") {
    if (Date.now() > deadline || !prediction.urls?.get) {
      throw new Error(`Replicate prediction ${prediction.id ?? "?"} didn't finish`);
    }
    await new Promise((resolve) => setTimeout(resolve, REPLICATE_POLL_MS));
    const poll = await fetch(prediction.urls.get, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    prediction = (await poll.json()) as ReplicatePrediction;
  }
  if (prediction.status !== "succeeded" || typeof prediction.output !== "string") {
    throw new Error(`Replicate ${prediction.status}: ${String(prediction.error ?? "no audio")}`);
  }
  const audio = await fetch(prediction.output, { signal: AbortSignal.timeout(60_000) });
  if (!audio.ok) throw new Error(`Replicate output ${audio.status}`);
  return Buffer.from(await audio.arrayBuffer());
}

/** Any audio ffmpeg reads, as 24 kHz mono s16le samples, silence trimmed from both ends. */
function toCapturePcm(audio: Buffer, scratch: string): Int16Array {
  const input = path.join(scratch, "in.bin");
  const output = path.join(scratch, "out.wav");
  writeFileSync(input, audio);
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-ac",
    "1",
    "-ar",
    String(REPLAY_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    output,
  ]);
  return trimSilence(readPcm16Wav(readFileSync(output))).samples;
}

export interface VoiceKeys {
  gemini: string;
  replicate: string;
}

/**
 * The clip in `voice`, as a cached 24 kHz mono WAV. `say` clips are the
 * replay benchmark's own, so the two benchmarks hear the same audio.
 */
export async function prepareVoiceClip(
  clip: ReplayClip,
  voice: PipelineVoice,
  cacheDir: string,
  keys: VoiceKeys
): Promise<PreparedClip> {
  if (voice.engine === "say") {
    return prepareClip(clip, { cacheDir, ...(voice.name ? { voice: voice.name } : {}) });
  }
  mkdirSync(cacheDir, { recursive: true });
  const model = voice.engine === "gemini" ? GEMINI_TTS_MODEL : MINIMAX_MODEL;
  const key = createHash("sha256")
    .update([PIPELINE_AUDIO_VERSION, model, voice.name, clip.speech].join("\n"))
    .digest("hex")
    .slice(0, 16);
  const safeName = voice.name.replace(/[^\w-]+/g, "_");
  const wavPath = path.join(cacheDir, `${clip.id}-${voice.engine}-${safeName}-${key}.wav`);
  if (!existsSync(wavPath)) {
    const scratch = mkdtempSync(path.join(tmpdir(), "daintree-voice-pipeline-"));
    try {
      const pieces: Int16Array[] = [];
      for (const phrase of speechPhrases(clip.speech)) {
        const audio =
          voice.engine === "gemini"
            ? await geminiSpeech(phrase.text, voice.name, keys.gemini)
            : await minimaxSpeech(phrase.text, voice.name, keys.replicate);
        const samples = toCapturePcm(audio, scratch);
        if (samples.length === 0) throw new Error(`${voice.id} produced silence for "${clip.id}"`);
        pieces.push(samples);
        if (phrase.pauseMs > 0) {
          pieces.push(new Int16Array(Math.round((phrase.pauseMs / 1000) * REPLAY_SAMPLE_RATE)));
        }
      }
      const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
      const samples = new Int16Array(total);
      let at = 0;
      for (const piece of pieces) {
        samples.set(piece, at);
        at += piece.length;
      }
      writeFileSync(wavPath, encodePcm16Wav({ sampleRate: REPLAY_SAMPLE_RATE, samples }));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const pcm = readPcm16Wav(readFileSync(wavPath));
  return {
    clip,
    wavPath,
    source: "synthesised",
    audioMs: pcmDurationMs(pcm),
    longestUtteranceMs: longestUtteranceMs(pcm),
  };
}
