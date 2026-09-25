import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../tour/audio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tour/audio.js")>();
  return {
    ...actual,
    // ffmpeg is not a test dependency; the fixture recordings are already Ogg Opus.
    encodeOggOpus: vi.fn(async (input: string, output: string) => {
      await fs.copyFile(input, output);
    }),
  };
});

import { runTourAlign, runTourVoice } from "../commands/tour.js";
import { oggOpusDuration } from "../tour/audio.js";
import { TourContributionSchema } from "../../../../electron/schemas/plugin.js";
import { narrationFingerprint, parseNarration } from "../../../tour/src/tourNarration.js";

const API_KEY = "c2VjcmV0LWlkOnNlY3JldC1rZXk=";
const PRE_SKIP = 312;

function oggPage(
  headerType: number,
  granule: bigint,
  serial: number,
  seq: number,
  payload: Buffer
) {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[4] = 0;
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  const segments: number[] = [];
  let left = payload.length;
  while (left >= 255) {
    segments.push(255);
    left -= 255;
  }
  segments.push(left);
  header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments), payload]);
}

function opusHead(): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(PRE_SKIP, 10);
  head.writeUInt32LE(48000, 12);
  return head;
}

/** A structurally valid Ogg Opus stream `seconds` long (the packets are not real audio). */
function oggOpus(seconds: number, serial = 7): Buffer {
  const head = opusHead();
  const tags = Buffer.from("OpusTags\0\0\0\0\0\0\0\0", "latin1");
  const end = BigInt(Math.round(seconds * 48000) + PRE_SKIP);
  return Buffer.concat([
    oggPage(2, 0n, serial, 0, head),
    oggPage(0, 0n, serial, 1, tags),
    oggPage(0, end / 2n, serial, 2, Buffer.alloc(300, 1)),
    oggPage(4, end, serial, 3, Buffer.alloc(40, 2)),
  ]);
}

function alignmentFor(text: string, step = 0.4) {
  const words = text.split(/\s+/).filter(Boolean);
  return {
    words,
    wordStartTimeSeconds: words.map((_, i) => 0.2 + i * step),
    wordEndTimeSeconds: words.map((_, i) => 0.2 + i * step + step * 0.8),
  };
}

let tmpDir: string;

const NARRATION = {
  chapters: [
    { id: "intro", narration: "Welcome to the [[panel]] panel. [warmly] It is great." },
    { id: "wrap", narration: "That is [[done]] everything." },
  ],
};

async function writePlugin(tours: unknown[], narration: unknown = NARRATION) {
  await fs.writeFile(
    path.join(tmpDir, "plugin.json"),
    JSON.stringify({ name: "acme.demo", version: "1.0.0", contributes: { tours } }, null, 2)
  );
  await fs.mkdir(path.join(tmpDir, "tours"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "tours", "welcome.narration.json"),
    JSON.stringify(narration)
  );
}

const TOUR = { id: "welcome", title: "Welcome", componentPath: "dist/tour.js", chapters: [] };

async function readTour() {
  const manifest = JSON.parse(await fs.readFile(path.join(tmpDir, "plugin.json"), "utf8"));
  return manifest.contributes.tours[0];
}

/** Inworld TTS double: voices whatever text it is sent, word for word, directions stripped. */
function ttsFetch(seconds = 3) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string };
    return new Response(
      JSON.stringify({
        audioContent: oggOpus(seconds).toString("base64"),
        timestampInfo: { wordAlignment: alignmentFor(body.text) },
      }),
      { status: 200 }
    );
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("oggOpusDuration", () => {
  it("reads the final granule minus pre-skip at 48 kHz", () => {
    expect(oggOpusDuration(oggOpus(2.5))).toBeCloseTo(2.5, 5);
  });

  it("rejects bytes that are not Ogg Opus", () => {
    expect(() => oggOpusDuration(Buffer.from("RIFF0000WAVE"))).toThrow(/Not an Ogg stream/);
  });

  it("walks pages by their segment tables, so a capture pattern inside audio is not a page", () => {
    // A fake page header whose granule would claim ~10 hours if it were read.
    const decoy = Buffer.alloc(40, 0xff);
    decoy.write("OggS", 0, "latin1");
    decoy[4] = 0;
    decoy.writeBigInt64LE(1_728_000_000n, 6);
    decoy.writeUInt32LE(7, 14);
    const pages = Buffer.concat([
      oggPage(2, 0n, 7, 0, opusHead()),
      oggPage(0, 48312n, 7, 1, decoy),
      oggPage(4, 96312n, 7, 2, Buffer.alloc(10)),
    ]);
    expect(oggOpusDuration(pages)).toBeCloseTo(2, 5);
  });

  it("skips pages whose granule is -1", () => {
    const pages = Buffer.concat([
      oggPage(2, 0n, 7, 0, opusHead()),
      oggPage(0, 48312n, 7, 1, Buffer.alloc(10)),
      oggPage(4, -1n, 7, 2, Buffer.alloc(10)),
    ]);
    expect(oggOpusDuration(pages)).toBeCloseTo(1, 5);
  });

  it("refuses chained, multiplexed and truncated streams instead of guessing", () => {
    expect(() => oggOpusDuration(Buffer.concat([oggOpus(2), oggOpus(3, 99)]))).toThrow(/chained/);
    const multiplexed = Buffer.concat([
      oggPage(2, 0n, 7, 0, opusHead()),
      oggPage(0, 48312n, 8, 0, Buffer.alloc(10)),
    ]);
    expect(() => oggOpusDuration(multiplexed)).toThrow(/more than one stream/);
    const full = oggOpus(2);
    expect(() => oggOpusDuration(full.subarray(0, full.length - 5))).toThrow(/truncated/);
    // Cut cleanly between pages: every remaining page is whole, but the end page is gone.
    const lastPage = full.lastIndexOf("OggS");
    expect(() => oggOpusDuration(full.subarray(0, lastPage))).toThrow(/no end page/);
  });
});

describe("runTourVoice", () => {
  it("voices every chapter, writes audio into the plugin and schema-valid timing", async () => {
    await writePlugin([TOUR]);
    const fetch = ttsFetch();
    const result = await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.inworld.ai/tts/v1/voice");
    const sent = JSON.parse(String(init?.body));
    expect(sent.voiceId).toBe("Simon");
    expect(sent.text).toBe("Welcome to the panel. [warmly] It is great.");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${API_KEY}`);

    expect(result.chapters.map((c) => [c.id, c.outcome])).toEqual([
      ["intro", "voiced"],
      ["wrap", "voiced"],
    ]);
    const tour = await readTour();
    expect(TourContributionSchema.safeParse(tour).success).toBe(true);
    const [intro] = tour.chapters;
    expect(intro.id).toBe("intro");
    expect(intro.audioUrl).toMatch(/^tours\/welcome\/intro\.simon\.[0-9a-f]{12}\.ogg$/);
    // "panel" is the fourth word; the double starts word i at 0.2 + 0.4i.
    expect(intro.cues.panel).toBeCloseTo(1.4, 3);
    expect(intro.duration).toBeCloseTo(3.6, 3);
    expect(intro.narrationHash).toBe(
      narrationFingerprint(parseNarration(NARRATION.chapters[0]!.narration))
    );
    const audio = await fs.readFile(path.join(tmpDir, intro.audioUrl));
    expect(oggOpusDuration(audio)).toBeCloseTo(3, 5);
  });

  it("re-voices only chapters whose narration changed", async () => {
    await writePlugin([TOUR]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });

    const rerun = ttsFetch();
    const unchanged = await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: rerun });
    expect(rerun).not.toHaveBeenCalled();
    expect(unchanged.chapters.every((c) => c.outcome === "up-to-date")).toBe(true);

    await fs.writeFile(
      path.join(tmpDir, "tours", "welcome.narration.json"),
      JSON.stringify({
        chapters: [NARRATION.chapters[0], { id: "wrap", narration: "That is [[done]] all." }],
      })
    );
    const edited = ttsFetch();
    const result = await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: edited });
    expect(edited).toHaveBeenCalledTimes(1);
    expect(result.chapters.map((c) => c.outcome)).toEqual(["up-to-date", "voiced"]);
  });

  it("re-voices when the voice changes, and with --force", async () => {
    await writePlugin([TOUR]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    const simon = (await readTour()).chapters[0].audioUrl;

    const other = ttsFetch();
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: other, voice: "Ashley" });
    expect(other).toHaveBeenCalledTimes(2);
    expect((await readTour()).chapters[0].audioUrl).toMatch(/\/intro\.ashley\.[0-9a-f]{12}\.ogg$/);
    // The replaced take is removed once no manifest references it.
    expect(existsSync(path.join(tmpDir, simon))).toBe(false);

    const forced = ttsFetch();
    await runTourVoice({
      dir: tmpDir,
      apiKey: API_KEY,
      fetch: forced,
      voice: "Ashley",
      force: true,
    });
    expect(forced).toHaveBeenCalledTimes(2);
  });

  it("refuses an --only run that would leave a chapter with no timing, before any request", async () => {
    await writePlugin([TOUR]);
    const fetch = ttsFetch();
    await expect(
      runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch, only: ["wrap"] })
    ).rejects.toThrow(/No timing yet for intro/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-voices just the --only chapters and keeps the rest, flagging stale ones", async () => {
    await writePlugin([TOUR]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    const before = (await readTour()).chapters[0];
    await fs.writeFile(
      path.join(tmpDir, "tours", "welcome.narration.json"),
      JSON.stringify({
        chapters: [
          { id: "intro", narration: "Welcome to the [[panel]] panel. It is fine." },
          { id: "wrap", narration: "That is [[done]] all." },
        ],
      })
    );
    const fetch = ttsFetch();
    const result = await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch, only: ["wrap"] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.chapters[0]).toMatchObject({ id: "intro", outcome: "not-selected", stale: true });
    expect((await readTour()).chapters[0]).toEqual(before);
  });

  it("names a non-default model in the audio path, so switching model re-voices", async () => {
    await writePlugin([TOUR]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    const fetch = ttsFetch();
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch, model: "inworld-tts-2-max" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).modelId).toBe("inworld-tts-2-max");
    expect((await readTour()).chapters[0].audioUrl).toMatch(
      /\/intro\.simon-inworld-tts-2-max\.[0-9a-f]{12}\.ogg$/
    );
  });

  it("refuses chapter ids that are unsafe as file names", async () => {
    await writePlugin([TOUR], { chapters: [{ id: "..", narration: "Hello there." }] });
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY })).rejects.toThrow(
      /Chapter id "\.\."/
    );
    await writePlugin([TOUR], {
      chapters: [
        { id: "Intro", narration: "Hello there." },
        { id: "intro", narration: "Hello again." },
      ],
    });
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY })).rejects.toThrow(
      /duplicate chapter id "intro"/
    );
  });

  it("keeps every referenced audio file when a run fails partway", async () => {
    await writePlugin([TOUR]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    let calls = 0;
    const flaky = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 2) return new Response("overloaded", { status: 503 });
      return ttsFetch(5)(url, init);
    });
    await expect(
      runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: flaky, force: true })
    ).rejects.toThrow(/503/);
    const tour = await readTour();
    expect(TourContributionSchema.safeParse(tour).success).toBe(true);
    for (const chapter of tour.chapters) {
      const audio = await fs.readFile(path.join(tmpDir, chapter.audioUrl));
      // Each chapter's duration is its own audio's length plus the 0.6s tail.
      expect(chapter.duration).toBeCloseTo(oggOpusDuration(audio) + 0.6, 3);
    }
    expect(tour.chapters[0].duration).toBeCloseTo(5.6, 3);
  });

  it("does not rewrite plugin.json when nothing changed, and keeps its indentation", async () => {
    await fs.mkdir(path.join(tmpDir, "tours"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "tours", "welcome.narration.json"),
      JSON.stringify(NARRATION)
    );
    await fs.writeFile(
      path.join(tmpDir, "plugin.json"),
      JSON.stringify(
        { name: "acme.demo", version: "1.0.0", contributes: { tours: [TOUR] } },
        null,
        "\t"
      )
    );
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    const manifestPath = path.join(tmpDir, "plugin.json");
    expect(await fs.readFile(manifestPath, "utf8")).toMatch(/^\t"name"/m);
    const past = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(manifestPath, past, past);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    expect((await fs.stat(manifestPath)).mtime.getTime()).toBe(past.getTime());
  });

  it("does not count an entry the host would refuse as existing timing", async () => {
    await writePlugin([{ ...TOUR, chapters: [{ id: "wrap" }] }]);
    const fetch = ttsFetch();
    await expect(
      runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch, only: ["intro"] })
    ).rejects.toThrow(/No timing yet for wrap/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses tours whose ids differ only in case", async () => {
    await writePlugin([TOUR, { ...TOUR, id: "Welcome" }]);
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY, tour: "welcome" })).rejects.toThrow(
      /differ only in case/
    );
  });

  it("refuses narration longer than Inworld voices in one request, before sending it", async () => {
    await writePlugin([TOUR], {
      chapters: [{ id: "intro", narration: "word ".repeat(450) }],
    });
    const fetch = ttsFetch();
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch })).rejects.toThrow(
      /at most 2000/
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a TTS alignment whose arrays disagree", async () => {
    await writePlugin([TOUR]);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audioContent: oggOpus(2).toString("base64"),
            timestampInfo: {
              wordAlignment: {
                words: ["a", "b"],
                wordStartTimeSeconds: [0],
                wordEndTimeSeconds: [1],
              },
            },
          })
        )
    );
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch })).rejects.toThrow(
      /no usable word alignment/
    );
  });

  it("drops chapters the narration no longer lists and keeps other manifest fields", async () => {
    await writePlugin([
      {
        ...TOUR,
        audioHosts: ["cdn.example.com"],
        chapters: [{ id: "gone", duration: 1, audioUrl: null, narrationHash: "00000000" }],
      },
    ]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    const tour = await readTour();
    expect(tour.chapters.map((c: { id: string }) => c.id)).toEqual(["intro", "wrap"]);
    expect(tour.audioHosts).toEqual(["cdn.example.com"]);
    expect(tour.title).toBe("Welcome");
  });

  it("reads the key from INWORLD_API_KEY and fails clearly without it", async () => {
    await writePlugin([TOUR]);
    vi.stubEnv("INWORLD_API_KEY", "");
    await expect(runTourVoice({ dir: tmpDir, fetch: ttsFetch() })).rejects.toThrow(
      "INWORLD_API_KEY is not set"
    );
    vi.stubEnv("INWORLD_API_KEY", API_KEY);
    const fetch = ttsFetch();
    await runTourVoice({ dir: tmpDir, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never lets the key into an error message", async () => {
    await writePlugin([TOUR]);
    const fetch = vi.fn(
      async () => new Response(`bad credentials: Basic ${API_KEY}`, { status: 401 })
    );
    const error = await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Inworld TTS failed \(401\)/);
    expect(error.message).not.toContain(API_KEY);
  });

  it("redacts a key that straddles the error-body limit, and never quotes an unparsable body", async () => {
    await writePlugin([TOUR]);
    const padded = vi.fn(async () => new Response(`${"x".repeat(490)}${API_KEY}`, { status: 400 }));
    const cut = await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: padded }).catch((e) => e);
    expect(cut.message).not.toContain(API_KEY.slice(0, 10));

    const garbled = vi.fn(async () => new Response(`{"echo": "${API_KEY}"`, { status: 200 }));
    const parse = await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: garbled }).catch(
      (e) => e
    );
    expect(parse.message).toMatch(/not a JSON object/);
    expect(parse.message).not.toContain(API_KEY);
  });

  it("refuses timing when too few words line up, leaving the plugin untouched", async () => {
    await writePlugin([TOUR]);
    const before = await fs.readFile(path.join(tmpDir, "plugin.json"), "utf8");
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audioContent: oggOpus(2).toString("base64"),
            timestampInfo: { wordAlignment: alignmentFor("something else entirely spoken") },
          })
        )
    );
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch })).rejects.toThrow(
      /words lined up/
    );
    expect(await fs.readFile(path.join(tmpDir, "plugin.json"), "utf8")).toBe(before);
    expect(existsSync(path.join(tmpDir, "tours/welcome"))).toBe(false);
  });

  it("needs --tour when several tours are declared, and a declared tour at all", async () => {
    await writePlugin([TOUR, { ...TOUR, id: "other" }]);
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY })).rejects.toThrow(/--tour/);
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY, tour: "nope" })).rejects.toThrow(
      /No tour "nope"/
    );
    await writePlugin([]);
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY })).rejects.toThrow(
      /declares no contributes.tours/
    );
  });

  it("rejects narration that names an unknown --only chapter or breaks the cue grammar", async () => {
    await writePlugin([TOUR]);
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY, only: ["missing"] })).rejects.toThrow(
      /--only names no chapter/
    );
    await writePlugin([TOUR], { chapters: [{ id: "intro", narration: "Ends on a cue [[late]]" }] });
    await expect(runTourVoice({ dir: tmpDir, apiKey: API_KEY })).rejects.toThrow(
      /has no word after it/
    );
  });
});

function sttFetch(text = "Welcome to the panel. It is great.") {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.transcribeConfig.includeWordTimestamps).toBe(true);
    const words = text.split(" ").filter(Boolean);
    return new Response(
      JSON.stringify({
        transcription: {
          wordTimestamps: words.map((word, i) => ({
            word,
            startTimeMs: 100 + i * 500,
            endTimeMs: 500 + i * 500,
          })),
        },
      })
    );
  });
}

describe("runTourAlign", () => {
  let recordings: string;

  beforeEach(async () => {
    recordings = path.join(tmpDir, "takes");
    await fs.mkdir(recordings);
  });

  it("times the author's recording and keeps chapters that have none", async () => {
    await writePlugin([TOUR]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    const wrapBefore = (await readTour()).chapters[1];
    await fs.writeFile(path.join(recordings, "intro.ogg"), oggOpus(4));

    const fetch = sttFetch();
    const logs: string[] = [];
    const result = await runTourAlign({
      dir: tmpDir,
      apiKey: API_KEY,
      fetch,
      recordings,
      log: (line) => logs.push(line),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.inworld.ai/stt/v1/transcribe");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).transcribeConfig.modelId).toBe(
      "groq/whisper-large-v3"
    );
    expect(result.chapters.map((c) => [c.id, c.outcome])).toEqual([
      ["intro", "aligned"],
      ["wrap", "no-recording"],
    ]);
    const tour = await readTour();
    expect(tour.chapters[0].audioUrl).toMatch(/\/intro\.recorded\.[0-9a-f]{12}\.ogg$/);
    // "panel." is the fourth word; the transcript starts word i at 0.1 + 0.5i.
    expect(tour.chapters[0].cues.panel).toBeCloseTo(1.6, 3);
    expect(tour.chapters[0].duration).toBeCloseTo(4.6, 3);
    expect(tour.chapters[1]).toEqual(wrapBefore);
    expect(TourContributionSchema.safeParse(tour).success).toBe(true);
    const shipped = await fs.readFile(path.join(tmpDir, tour.chapters[0].audioUrl));
    expect(oggOpusDuration(shipped)).toBeCloseTo(4, 5);
    expect(logs.join("\n")).not.toContain(API_KEY);
  });

  it("times a fresh tour from recordings alone", async () => {
    await writePlugin([TOUR]);
    await fs.writeFile(path.join(recordings, "intro.wav"), oggOpus(4));
    await fs.writeFile(path.join(recordings, "wrap.mp3"), oggOpus(2));
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const audio = Buffer.from(JSON.parse(String(init?.body)).audioData.content, "base64");
      const text =
        oggOpusDuration(audio) > 3 ? "Welcome to the panel. It is great." : "That is everything.";
      return sttFetch(text)(url, init);
    });
    await runTourAlign({ dir: tmpDir, apiKey: API_KEY, fetch, recordings });
    const tour = await readTour();
    expect(tour.chapters.map((c: { audioUrl: string }) => c.audioUrl)).toEqual([
      expect.stringMatching(/\/intro\.recorded\.[0-9a-f]{12}\.ogg$/),
      expect.stringMatching(/\/wrap\.recorded\.[0-9a-f]{12}\.ogg$/),
    ]);
    expect(TourContributionSchema.safeParse(tour).success).toBe(true);
  });

  it("refuses a run that would leave a chapter untimed, before any request", async () => {
    await writePlugin([TOUR]);
    await fs.writeFile(path.join(recordings, "intro.ogg"), oggOpus(4));
    const fetch = sttFetch();
    await expect(runTourAlign({ dir: tmpDir, apiKey: API_KEY, fetch, recordings })).rejects.toThrow(
      /No timing yet for wrap/
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a directory named like a recording", async () => {
    await writePlugin([TOUR]);
    await fs.mkdir(path.join(recordings, "intro.wav"));
    await expect(runTourAlign({ dir: tmpDir, apiKey: API_KEY, recordings })).rejects.toThrow(
      /No recording in .* matches/
    );
  });

  it("refuses two recordings for one chapter", async () => {
    await writePlugin([TOUR]);
    await fs.writeFile(path.join(recordings, "intro.ogg"), oggOpus(4));
    await fs.writeFile(path.join(recordings, "intro.wav"), oggOpus(4));
    await expect(runTourAlign({ dir: tmpDir, apiKey: API_KEY, recordings })).rejects.toThrow(
      /Two recordings for chapter "intro"/
    );
  });

  it("explains a transcript without word timestamps instead of failing to align", async () => {
    await writePlugin([TOUR]);
    await runTourVoice({ dir: tmpDir, apiKey: API_KEY, fetch: ttsFetch() });
    await fs.writeFile(path.join(recordings, "intro.ogg"), oggOpus(4));
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ transcription: { transcript: "hi" } }))
    );
    await expect(
      runTourAlign({
        dir: tmpDir,
        apiKey: API_KEY,
        fetch,
        recordings,
        sttModel: "inworld/inworld-stt-1",
      })
    ).rejects.toThrow(/inworld\/inworld-stt-1\) returned no word timestamps/);
  });

  it("fails when the recordings folder is missing", async () => {
    await writePlugin([TOUR]);
    await expect(
      runTourAlign({ dir: tmpDir, apiKey: API_KEY, recordings: path.join(tmpDir, "nope") })
    ).rejects.toThrow(/Recordings folder not found/);
  });
});
