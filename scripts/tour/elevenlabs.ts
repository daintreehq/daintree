import { stripDirectionTags, type WordAlignment } from "@daintreehq/tour";

const API_ORIGIN = "https://api.elevenlabs.io";
const ERROR_BODY_LIMIT = 500;
const ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;
/** Covers the request and reading its body; a chapter voices in well under a minute. */
const REQUEST_TIMEOUT_MS = 180_000;
/**
 * Refusals that come before anything is voiced, so retrying can't buy a take
 * twice. A gateway timeout or other server error may arrive after synthesis.
 */
const RETRYABLE = new Set([429, 503]);

export interface ElevenLabsSpeechOptions {
  apiKey: string;
  text: string;
  voiceId: string;
  modelId: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
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
  if (
    !Array.isArray(a.characters) ||
    a.characters.length === 0 ||
    !a.characters.every((c) => typeof c === "string") ||
    !finite(a.character_start_times_seconds) ||
    !finite(a.character_end_times_seconds) ||
    a.character_start_times_seconds!.length !== a.characters.length ||
    a.character_end_times_seconds!.length !== a.characters.length
  ) {
    return false;
  }
  // Cues are placed from these starts, so time must only move forward.
  const starts = a.character_start_times_seconds!;
  const ends = a.character_end_times_seconds!;
  return starts.every((start, i) => ends[i]! >= start && (i === 0 || start >= starts[i - 1]!));
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
  const sleep = opts.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const notRetried = (what: string, error: unknown) => {
    // Not retried: the request may have been voiced, and billed, before it failed.
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
      redact(
        `ElevenLabs TTS ${what}: ${message} (not retried; it may have been billed)`,
        opts.apiKey
      )
    );
  };
  let response: Response;
  let raw: string;
  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "xi-api-key": opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text: opts.text, model_id: opts.modelId }),
        signal,
      });
    } catch (error) {
      throw notRetried("request failed", error);
    }
    if (!RETRYABLE.has(response.status) || attempt >= ATTEMPTS) {
      try {
        raw = await response.text();
      } catch (error) {
        throw notRetried("response could not be read", error);
      }
      break;
    }
    await response.body?.cancel().catch(() => {});
    await sleep(retryDelayMs(response.headers.get("retry-after"), attempt));
  }
  if (!response.ok) {
    // Redact before truncating, or a key cut at the limit would leak its prefix.
    const text = redact(raw, opts.apiKey);
    const detail = text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${detail}`);
  }
  type Body = { audio_base64?: unknown; alignment?: unknown };
  let body: Body | null = null;
  try {
    body = JSON.parse(raw) as Body | null;
  } catch {
    // Reported below without quoting the body.
  }
  if (!body || typeof body.audio_base64 !== "string" || body.audio_base64.length === 0) {
    throw new Error("ElevenLabs TTS response carried no audio");
  }
  if (!isCharacterAlignment(body.alignment)) {
    throw new Error("ElevenLabs TTS response carried no usable character alignment");
  }
  // Cues and captions are placed on these characters, so they must be the text that was sent.
  if (normalizeSpace(body.alignment.characters.join("")) !== normalizeSpace(opts.text)) {
    throw new Error("ElevenLabs TTS aligned different text from the narration it was sent");
  }
  const alignment = wordsFromCharacters(body.alignment);
  if (alignment.words.length === 0) {
    throw new Error("ElevenLabs TTS response aligned no words");
  }
  return { audio: Buffer.from(body.audio_base64, "base64"), alignment };
}

// Delivery directions are read as stage cues, not text, so they may not come back.
const normalizeSpace = (text: string) =>
  text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** `Retry-After` in seconds or as an HTTP date, capped; a backoff when it's absent. */
export function retryDelayMs(header: string | null, attempt: number, now = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_WAIT_MS);
  }
  return 2000 * attempt;
}

function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
