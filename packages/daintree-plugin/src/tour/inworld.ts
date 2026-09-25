import { stripDirectionTags, type WordAlignment } from "../../../tour/src/tourNarration.js";

/** Inworld's "Simon" — articulate and steady, made for technical tutorials. */
export const DEFAULT_TTS_VOICE = "Simon";
export const DEFAULT_TTS_MODEL = "inworld-tts-2";
/** Inworld's own recogniser; any model Inworld's STT endpoint routes also works. */
export const DEFAULT_STT_MODEL = "inworld/inworld-stt-1";
/** Inworld rejects longer synthesis requests. */
export const MAX_TTS_CHARACTERS = 2000;

const TTS_URL = "https://api.inworld.ai/tts/v1/voice";
const STT_URL = "https://api.inworld.ai/stt/v1/transcribe";
const ERROR_BODY_LIMIT = 500;

export interface InworldAuth {
  /** The Base64 credential Inworld issues; sent as HTTP Basic auth. */
  apiKey: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export interface SynthesizeOptions extends InworldAuth {
  text: string;
  voice?: string;
  model?: string;
}

export interface TranscribeOptions extends InworldAuth {
  /** Mono Ogg Opus at 48 kHz, as `encodeOggOpus` writes it. */
  audio: Buffer;
  model?: string;
  language?: string;
}

/** Reads the key from the environment, naming the variable but never echoing a value. */
export function inworldKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.INWORLD_API_KEY?.trim();
  if (!key) throw new Error("INWORLD_API_KEY is not set");
  return key;
}

async function post(auth: InworldAuth, url: string, label: string, body: unknown) {
  const doFetch = auth.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      redact(`${label} request failed: ${(error as Error).message ?? String(error)}`, auth.apiKey)
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
    throw new Error(redact(`${label} failed (${response.status}): ${detail}`, auth.apiKey));
  }
  return (await response.json()) as unknown;
}

/** An error body could echo the request back; the key must never reach a terminal or log. */
function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

export async function synthesizeSpeech(
  opts: SynthesizeOptions
): Promise<{ audio: Buffer; alignment: WordAlignment }> {
  if (opts.text.length > MAX_TTS_CHARACTERS) {
    throw new Error(
      `Narration is ${opts.text.length} characters; Inworld voices at most ${MAX_TTS_CHARACTERS} per chapter. Split the chapter.`
    );
  }
  const body = (await post(opts, TTS_URL, "Inworld TTS", {
    text: opts.text,
    voiceId: opts.voice ?? DEFAULT_TTS_VOICE,
    modelId: opts.model ?? DEFAULT_TTS_MODEL,
    audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 48000 },
    timestampType: "WORD",
  })) as { audioContent?: string; timestampInfo?: { wordAlignment?: WordAlignment } };
  const alignment = body.timestampInfo?.wordAlignment;
  if (!body.audioContent) throw new Error("Inworld TTS response carried no audio");
  if (!alignment) throw new Error("Inworld TTS response carried no word alignment");
  return {
    audio: Buffer.from(body.audioContent, "base64"),
    alignment: stripDirectionTags(alignment),
  };
}

export async function transcribeSpeech(opts: TranscribeOptions): Promise<WordAlignment> {
  const body = (await post(opts, STT_URL, "Inworld STT", {
    transcribeConfig: {
      modelId: opts.model ?? DEFAULT_STT_MODEL,
      language: opts.language ?? "en-US",
      audioEncoding: "OGG_OPUS",
      sampleRateHertz: 48000,
      numberOfChannels: 1,
      includeWordTimestamps: true,
    },
    audioData: { content: opts.audio.toString("base64") },
  })) as {
    transcription?: {
      wordTimestamps?: { word: string; startTimeMs: number; endTimeMs: number }[];
    };
  };
  const words = body.transcription?.wordTimestamps ?? [];
  return {
    words: words.map((w) => w.word),
    wordStartTimeSeconds: words.map((w) => w.startTimeMs / 1000),
    wordEndTimeSeconds: words.map((w) => w.endTimeMs / 1000),
  };
}
