import { describe, expect, it, vi } from "vitest";
import { alignWordStarts, parseNarration } from "@daintreehq/tour";
import { synthesizeElevenLabs, wordsFromCharacters } from "../elevenlabs";

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
