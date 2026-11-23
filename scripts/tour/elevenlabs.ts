import { stripDirectionTags, type WordAlignment } from "@daintreehq/tour";

const API_ORIGIN = "https://api.elevenlabs.io";
const ERROR_BODY_LIMIT = 500;

export interface ElevenLabsSpeechOptions {
  apiKey: string;
  text: string;
  voiceId: string;
  modelId: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export interface ElevenLabsCharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Reads the key from the environment, naming the variable but never echoing a value. */
export function elevenLabsKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  return key;
}

/**
 * ElevenLabs times every character of the text it was sent; the tour aligns on
 * words. A word runs from its first character's start to its last character's
 * end, split on whitespace exactly as the text was, so the words come back as
 * the narration's own.
 */
export function wordsFromCharacters(alignment: ElevenLabsCharacterAlignment): WordAlignment {
  const {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = alignment;
  const words: string[] = [];
  const wordStartTimeSeconds: number[] = [];
  const wordEndTimeSeconds: number[] = [];
  let current = "";
  for (let i = 0; i < characters.length; i++) {
    const char = characters[i]!;
    if (/\s/.test(char)) {
      current = "";
      continue;
    }
    if (current === "") {
      words.push(char);
      wordStartTimeSeconds.push(starts[i]!);
      wordEndTimeSeconds.push(ends[i]!);
    } else {
      words[words.length - 1] += char;
      wordEndTimeSeconds[wordEndTimeSeconds.length - 1] = ends[i]!;
    }
    current += char;
  }
  return stripDirectionTags({ words, wordStartTimeSeconds, wordEndTimeSeconds });
}

function isCharacterAlignment(value: unknown): value is ElevenLabsCharacterAlignment {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Partial<ElevenLabsCharacterAlignment>;
  const finite = (xs: unknown) =>
    Array.isArray(xs) && xs.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);
  return (
    Array.isArray(a.characters) &&
    a.characters.every((c) => typeof c === "string") &&
    finite(a.character_start_times_seconds) &&
    finite(a.character_end_times_seconds) &&
    a.character_start_times_seconds!.length === a.characters.length &&
    a.character_end_times_seconds!.length === a.characters.length
  );
}

/**
 * Voices `text` and returns MP3 bytes with the word timings ElevenLabs reports.
 * The alignment used is the one for the text as sent, not the normalized one,
 * whose characters are the engine's expansion of it ("1" read as "one").
 */
export async function synthesizeElevenLabs(
  opts: ElevenLabsSpeechOptions
): Promise<{ audio: Buffer; alignment: WordAlignment }> {
  const url = `${API_ORIGIN}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const doFetch = opts.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "xi-api-key": opts.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: opts.text, model_id: opts.modelId }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`ElevenLabs TTS request failed: ${message}`, opts.apiKey));
  }
  if (!response.ok) {
    // Redact before truncating, or a key cut at the limit would leak its prefix.
    const text = redact(await response.text().catch(() => ""), opts.apiKey);
    const detail = text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${detail}`);
  }
  const body = (await response.json().catch(() => null)) as {
    audio_base64?: unknown;
    alignment?: unknown;
  } | null;
  if (!body || typeof body.audio_base64 !== "string" || body.audio_base64.length === 0) {
    throw new Error("ElevenLabs TTS response carried no audio");
  }
  if (!isCharacterAlignment(body.alignment)) {
    throw new Error("ElevenLabs TTS response carried no usable character alignment");
  }
  const alignment = wordsFromCharacters(body.alignment);
  if (alignment.words.length === 0) {
    throw new Error("ElevenLabs TTS response aligned no words");
  }
  return { audio: Buffer.from(body.audio_base64, "base64"), alignment };
}

function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
