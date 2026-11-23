import { describe, expect, it, vi } from "vitest";
import { alignWordStarts, parseNarration } from "@daintreehq/tour";
import { retryDelayMs, synthesizeElevenLabs, wordsFromCharacters } from "../elevenlabs";

function characterAlignment(text: string, step = 0.1) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * step),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * step),
  };
}

describe("wordsFromCharacters", () => {
  it("joins characters into whitespace-separated words, timed first start to last end", () => {
    const words = wordsFromCharacters(characterAlignment("Hi  there,\nyou."));
    expect(words.words).toEqual(["Hi", "there,", "you."]);
    expect(words.wordStartTimeSeconds).toEqual([0, 0.4, 1.1]);
    expect(words.wordEndTimeSeconds.map((t) => Math.round(t * 10) / 10)).toEqual([0.2, 1, 1.5]);
  });

  it("drops delivery directions the engine reads as stage cues", () => {
    expect(wordsFromCharacters(characterAlignment("[calm] Hello")).words).toEqual(["Hello"]);
  });

  it("pins every narration word when the voice read the narration as written", () => {
    const parsed = parseNarration("Click [[plus]] the plus button, then [[name]] name it.");
    const aligned = alignWordStarts(
      parsed.words,
      wordsFromCharacters(characterAlignment(parsed.spoken))
    );
    expect(aligned.matched).toBe(parsed.words.length);
  });
});

describe("synthesizeElevenLabs", () => {
  const ok = (body: unknown) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("sends the text, model and voice, and returns the audio and word timings", async () => {
    const fetchMock = ok({
      audio_base64: Buffer.from("mp3").toString("base64"),
      alignment: characterAlignment("Two words"),
      normalized_alignment: characterAlignment("Two words"),
    });
    const result = await synthesizeElevenLabs({
      apiKey: "key",
      text: "Two words",
      voiceId: "voice/1",
      modelId: "eleven_v4",
      fetch: fetchMock,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/with-timestamps?output_format=mp3_44100_128"
    );
    expect(JSON.parse(String(init!.body))).toEqual({ text: "Two words", model_id: "eleven_v4" });
    expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe("key");
    expect(result.audio.toString()).toBe("mp3");
    expect(result.alignment.words).toEqual(["Two", "words"]);
  });

  it("refuses a response without a usable alignment", async () => {
    await expect(
      synthesizeElevenLabs({
        apiKey: "key",
        text: "Hi",
        voiceId: "v",
        modelId: "m",
        fetch: ok({ audio_base64: "AA==", alignment: { characters: ["H"] } }),
      })
    ).rejects.toThrow(/no usable character alignment/);
  });

  it("never echoes the key from an error body", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("bad key secret-key", { status: 401 })
    );
    const error = await synthesizeElevenLabs({
      apiKey: "secret-key",
      text: "Hi",
      voiceId: "v",
      modelId: "m",
      fetch: fetchMock,
    }).catch((e: Error) => e);
    expect(String(error)).toContain("(401)");
    expect(String(error)).not.toContain("secret-key");
  });
});

describe("synthesizeElevenLabs retries", () => {
  const body = {
    audio_base64: Buffer.from("mp3").toString("base64"),
    alignment: characterAlignment("Hi"),
  };

  it("waits out throttling, then succeeds", async () => {
    const responses = [
      new Response("busy", { status: 429, headers: { "retry-after": "1" } }),
      new Response(JSON.stringify(body), { status: 200 }),
    ];
    const sleep = vi.fn(async () => {});
    const result = await synthesizeElevenLabs({
      apiKey: "k",
      text: "Hi",
      voiceId: "v",
      modelId: "m",
      fetch: vi.fn<typeof fetch>(async () => responses.shift()!),
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(result.alignment.words).toEqual(["Hi"]);
  });

  it("does not retry a refused request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("no", { status: 400 }));
    await expect(
      synthesizeElevenLabs({
        apiKey: "k",
        text: "Hi",
        voiceId: "v",
        modelId: "m",
        fetch: fetchMock,
      })
    ).rejects.toThrow(/\(400\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses timings that run backwards", async () => {
    const alignment = {
      characters: ["H", "i"],
      character_start_times_seconds: [0.5, 0.1],
      character_end_times_seconds: [0.6, 0.2],
    };
    await expect(
      synthesizeElevenLabs({
        apiKey: "k",
        text: "Hi",
        voiceId: "v",
        modelId: "m",
        fetch: vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify({ audio_base64: "AA==", alignment }), { status: 200 })
        ),
      })
    ).rejects.toThrow(/no usable character alignment/);
  });
});

describe("synthesizeElevenLabs safeguards", () => {
  const audio = Buffer.from("mp3").toString("base64");
  const call = (fetchMock: typeof fetch, text = "Hi", extra = {}) =>
    synthesizeElevenLabs({
      apiKey: "k",
      text,
      voiceId: "v",
      modelId: "m",
      fetch: fetchMock,
      sleep: async () => {},
      ...extra,
    });

  it("gives up after three refusals before voicing", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 }));
    await expect(call(fetchMock)).rejects.toThrow(/\(503\)/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries a gateway timeout, which may arrive after the take was voiced", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("late", { status: 504 }));
    await expect(call(fetchMock)).rejects.toThrow(/\(504\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at its deadline without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
        })
    );
    await expect(call(fetchMock, "Hi", { timeoutMs: 10 })).rejects.toThrow(/not retried/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times words from the text as sent, not the engine's normalized reading", async () => {
    const result = await call(
      ok({
        audio_base64: audio,
        alignment: characterAlignment("1 item"),
        normalized_alignment: characterAlignment("one item", 0.2),
      }),
      "1 item"
    );
    expect(result.alignment.words).toEqual(["1", "item"]);
    expect(result.alignment.wordStartTimeSeconds).toEqual([0, 0.2]);
  });

  it("refuses an alignment of different words from the narration sent", async () => {
    await expect(
      call(
        ok({ audio_base64: audio, alignment: characterAlignment("go right now") }),
        "go left now"
      )
    ).rejects.toThrow(/different text/);
  });

  function ok(body: unknown) {
    return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
  }
});

describe("retryDelayMs", () => {
  it("reads seconds or an HTTP date, capped at thirty seconds", () => {
    const now = Date.parse("2026-11-23T00:00:00Z");
    expect(retryDelayMs("4", 1, now)).toBe(4000);
    expect(retryDelayMs("Mon, 23 Nov 2026 00:00:25 GMT", 1, now)).toBe(25_000);
    expect(retryDelayMs("600", 1, now)).toBe(30_000);
    expect(retryDelayMs(null, 2, now)).toBe(4000);
  });
});
