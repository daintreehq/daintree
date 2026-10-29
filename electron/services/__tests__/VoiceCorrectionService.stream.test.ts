import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { logWarn } from "../../utils/logger.js";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const SETTINGS = { model: "gpt-6-luna", apiKey: "sk-test", customDictionary: [] as string[] };

type Frame = Record<string, unknown> & { type: string };

function reply(correctedText: string, action = "replace", confidence = "high"): string {
  return JSON.stringify({ action, corrected_text: correctedText, confidence });
}

/** The reply as Responses API stream events: the JSON in small deltas, then its terminal event. */
function replyFrames(json: string, terminal: Frame | null = completed(json)): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < json.length; i += 5) {
    frames.push({ type: "response.output_text.delta", delta: json.slice(i, i + 5) });
  }
  frames.push({ type: "response.output_text.done", text: json });
  if (terminal) frames.push(terminal);
  return frames;
}

function completed(json: string, status = "completed"): Frame {
  return {
    type: status === "completed" ? "response.completed" : "response.incomplete",
    response: {
      status,
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      output: [{ content: [{ text: json }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

/** A streamed response whose body arrives `chunkSize` bytes at a time. */
function streamed(frames: Frame[], chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(
    frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("")
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("VoiceCorrectionService streaming", () => {
  beforeEach(() => {
    // Every read is past the progress interval, so each chunk may report.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 50));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("streams only when asked, and lands the same result as an unstreamed reply", async () => {
    const corrected = "Fix the bug in the parser, then run the tests.";
    const fetchMock = stubFetch(streamed(replyFrames(reply(corrected))));
    const heard: string[] = [];

    const svc = new VoiceCorrectionService();
    const result = await svc.correct(
      { rawText: "fix the bug in the parser then run the tests" },
      SETTINGS,
      undefined,
      (text) => heard.push(text)
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(result).toMatchObject({ action: "replace", correctedText: corrected });
    expect(heard.length).toBeGreaterThan(3);
    heard.forEach((text, i) => {
      // Whole words only, growing, each a prefix of what landed.
      expect(corrected.startsWith(text)).toBe(true);
      expect(corrected.charAt(text.length)).toMatch(/\s/);
      if (i > 0) expect(text.length).toBeGreaterThan(heard[i - 1]!.length);
    });
  });

  it("reports the tokens a streamed reply was billed for, a cut-off one included", async () => {
    const usage = {
      input_tokens: 3_100,
      input_tokens_details: { cached_tokens: 2_944, cache_write_tokens: 64 },
      output_tokens: 140,
      output_tokens_details: { reasoning_tokens: 70 },
    };
    const billed = (json: string, status: string): Frame => {
      const frame = completed(json, status);
      return { ...frame, response: { ...(frame.response as object), usage } };
    };
    const json = reply("Fix the parser.");
    const svc = new VoiceCorrectionService();
    const request = { rawText: "fix the parsr" };
    const expected = {
      inputTokens: 3_100,
      cachedTokens: 2_944,
      cacheWriteTokens: 64,
      outputTokens: 140,
      reasoningTokens: 70,
    };

    stubFetch(streamed(replyFrames(json, billed(json, "completed"))));
    const landed = await svc.correct(request, SETTINGS, undefined, () => {});
    expect(landed.action).toBe("replace");
    expect(landed.roundTrip?.usage).toEqual(expected);

    stubFetch(streamed(replyFrames(json, billed(json, "incomplete"))));
    const cutOff = await svc.correct(request, SETTINGS, undefined, () => {});
    expect(cutOff.failed).toBe(true);
    expect(cutOff.roundTrip?.usage).toEqual(expected);
  });

  it("reports at most once per interval however fast the reply arrives", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 10));
    const corrected = "Fix the bug in the parser, then run the tests and ship the release.";
    stubFetch(streamed(replyFrames(reply(corrected)), 8));
    const reportedAt: number[] = [];

    await new VoiceCorrectionService().correct(
      { rawText: "fix the bug in the parser then run the tests and ship the release" },
      SETTINGS,
      undefined,
      () => reportedAt.push(now)
    );

    expect(reportedAt.length).toBeGreaterThan(1);
    for (let i = 1; i < reportedAt.length; i++) {
      expect(reportedAt[i]! - reportedAt[i - 1]!).toBeGreaterThanOrEqual(33);
    }
  });

  it("leaves the request unstreamed without a listener", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output_text: reply("Ship it.") }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new VoiceCorrectionService().correct({ rawText: "ship it" }, SETTINGS);

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).not.toHaveProperty("stream");
    expect(result.correctedText).toBe("Ship it.");
  });

  it("decodes escapes split across deltas and multi-byte text split across chunks", async () => {
    const corrected = '1. Install the "deps" café\n2. Run the tests\n3. Ship it';
    stubFetch(streamed(replyFrames(reply(corrected)), 3));
    const heard: string[] = [];

    const result = await new VoiceCorrectionService().correct(
      { rawText: "first install the deps cafe second run the tests third ship it" },
      SETTINGS,
      undefined,
      (text) => heard.push(text)
    );

    expect(result.correctedText).toBe(corrected);
    expect(heard).toContain('1. Install the "deps" café\n2. Run the');
    for (const text of heard) expect(corrected.startsWith(text)).toBe(true);
  });

  it("drops leading filler from the text it reports, as from the text it lands", async () => {
    stubFetch(streamed(replyFrames(reply("Um, so we ship the release today."))));
    const heard: string[] = [];

    const result = await new VoiceCorrectionService().correct(
      { rawText: "um so we ship the release today" },
      SETTINGS,
      undefined,
      (text) => heard.push(text)
    );

    expect(result.correctedText).toBe("so we ship the release today.");
    expect(heard.length).toBeGreaterThan(0);
    for (const text of heard) expect(result.correctedText.startsWith(text)).toBe(true);
  });

  it("never shows a pause mark the reply copies, whole or still arriving", async () => {
    // Two spaces before a mark that a comma follows: the space shown first must not be taken back.
    const json = reply(
      "Leave the tests. <pause /> Failing builds can wait  <pause/>, until the branch is cut."
    );
    const frames: Frame[] = [...json].map((delta) => ({
      type: "response.output_text.delta",
      delta,
    }));
    frames.push({ type: "response.output_text.done", text: json }, completed(json));
    stubFetch(streamed(frames, 7));
    const heard: string[] = [];

    const result = await new VoiceCorrectionService().correct(
      {
        rawText: "leave the tests failing builds can wait until the branch is cut",
        pauses: [15, 39],
      },
      { ...SETTINGS, model: "gpt-6.1-terra" },
      undefined,
      (text) => heard.push(text)
    );

    expect(result.correctedText).toBe(
      "Leave the tests. Failing builds can wait, until the branch is cut."
    );
    expect(heard.length).toBeGreaterThan(5);
    for (const text of heard) {
      expect(text).not.toContain("<");
      expect(result.correctedText.startsWith(text)).toBe(true);
    }
  });

  it("reports nothing for a reply that keeps the passage", async () => {
    stubFetch(streamed(replyFrames(reply("ship it", "no_change"))));
    const onText = vi.fn();

    const result = await new VoiceCorrectionService().correct(
      { rawText: "ship it today please" },
      SETTINGS,
      undefined,
      onText
    );

    expect(onText).not.toHaveBeenCalled();
    expect(result.action).toBe("no_change");
  });

  it("lands a streamed command opening the prompt as the model wrote it", async () => {
    stubFetch(streamed(replyFrames(reply("/test the parser before the release now"))));
    const onText = vi.fn();

    const result = await new VoiceCorrectionService().correct(
      { rawText: "test the parser before the release now", startsPrompt: true },
      SETTINGS,
      undefined,
      onText
    );

    expect(onText).toHaveBeenCalledWith(expect.stringMatching(/^\/test /));
    expect(result).toMatchObject({
      action: "replace",
      correctedText: "/test the parser before the release now",
      verdict: "replaced",
    });
  });

  it("discards a reply whose stream ends before its last event", async () => {
    stubFetch(streamed(replyFrames(reply("Fix the parser now."), null)));

    const result = await new VoiceCorrectionService().correct(
      { rawText: "fix the parser now" },
      SETTINGS,
      undefined,
      vi.fn()
    );

    expect(result).toMatchObject({ action: "no_change", failed: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Correction failed"),
      expect.objectContaining({ errorCode: "incomplete" })
    );
  });

  it("discards a reply the stream reports cut off", async () => {
    const json = reply("Fix the parser now.");
    stubFetch(streamed(replyFrames(json, completed(json, "incomplete"))));

    const result = await new VoiceCorrectionService().correct(
      { rawText: "fix the parser now" },
      SETTINGS,
      undefined,
      vi.fn()
    );

    expect(result).toMatchObject({ action: "no_change", failed: true });
  });

  it("reads its text from the first part only, as an unstreamed reply is read", async () => {
    const json = reply("Fix the parser now.");
    const frames = replyFrames(json).map((frame) =>
      frame.type === "response.output_text.delta"
        ? { ...frame, output_index: 0, content_index: 0 }
        : frame
    );
    frames.splice(2, 0, {
      type: "response.output_text.delta",
      output_index: 1,
      content_index: 0,
      delta: "stray",
    });
    stubFetch(streamed(frames));

    const result = await new VoiceCorrectionService().correct(
      { rawText: "fix the parser now" },
      SETTINGS,
      undefined,
      vi.fn()
    );

    expect(result.correctedText).toBe("Fix the parser now.");
  });

  it("takes an error event's code from the top level too", async () => {
    const frames = replyFrames(reply("Fix the parser now."), null).slice(0, 3);
    frames.push({ type: "error", code: "rate_limit_exceeded", message: "fix the parser now" });
    stubFetch(streamed(frames));

    const result = await new VoiceCorrectionService().correct(
      { rawText: "fix the parser now" },
      SETTINGS,
      undefined,
      vi.fn()
    );

    expect(result).toMatchObject({ failed: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Correction failed"),
      expect.objectContaining({ code: "rate_limit_exceeded" })
    );
  });

  it("fails on an error event mid-stream, logging its code and nothing else", async () => {
    const frames = replyFrames(reply("Fix the parser now."), null).slice(0, 3);
    frames.push({
      type: "error",
      error: { code: "server_error", message: "fix the parser now" },
    });
    stubFetch(streamed(frames));

    const result = await new VoiceCorrectionService().correct(
      { rawText: "fix the parser now" },
      SETTINGS,
      undefined,
      vi.fn()
    );

    expect(result).toMatchObject({ action: "no_change", failed: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Correction failed"),
      expect.objectContaining({ code: "server_error" })
    );
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain("parser");
  });

  describe("verdicts", () => {
    /**
     * A reply that streams `frames` and then stalls with the body open, until
     * the request's signal aborts: the body then errors with its reason, as
     * fetch's does.
     */
    function stallingFetch(frames: Frame[]) {
      const bytes = new TextEncoder().encode(
        frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("")
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), {
                once: true,
              });
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        })
      );
    }

    // Far enough into the corrected text for some of it to have been reported.
    const partial = () => replyFrames(reply("Fix the bug in the parser now."), null).slice(0, 12);

    it("names a streamed cleanup that lands replaced, whatever its confidence", async () => {
      stubFetch(streamed(replyFrames(reply("Fix the parser now."))));
      const replaced = await new VoiceCorrectionService().correct(
        { rawText: "fix the parser now" },
        SETTINGS,
        undefined,
        vi.fn()
      );
      expect(replaced.verdict).toBe("replaced");

      stubFetch(streamed(replyFrames(reply("Fix the bug in the parser now.", "replace", "low"))));
      const onText = vi.fn();
      const unsure = await new VoiceCorrectionService().correct(
        { rawText: "fix the bug in the parser now" },
        SETTINGS,
        undefined,
        onText
      );
      expect(onText).toHaveBeenCalled();
      expect(unsure).toMatchObject({
        action: "replace",
        correctedText: "Fix the bug in the parser now.",
        confirmedText: "Fix the bug in the parser now.",
        verdict: "replaced",
      });
      expect(unsure.failed).toBeUndefined();
    });

    it("names a stream that errors, or ends or is cut off before its last event, failed", async () => {
      const errored = partial();
      errored.push({ type: "error", error: { code: "server_error" } });
      const failedFrames = partial();
      failedFrames.push({
        type: "response.failed",
        response: { status: "failed", error: { code: "server_error" } },
      });
      const json = reply("Fix the parser now.");
      for (const frames of [
        errored,
        failedFrames,
        replyFrames(json, null),
        replyFrames(json, completed(json, "incomplete")),
      ]) {
        stubFetch(streamed(frames));
        const result = await new VoiceCorrectionService().correct(
          { rawText: "fix the parser now" },
          SETTINGS,
          undefined,
          vi.fn()
        );
        expect(result).toMatchObject({ action: "no_change", failed: true, verdict: "failed" });
      }
    });

    it("names a stream that runs out its deadline part-way timed_out", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        stallingFetch(partial());
        const heard: string[] = [];
        const pending = new VoiceCorrectionService().correct(
          { rawText: "fix the bug in the parser now" },
          { ...SETTINGS, reasoningEffort: "none" },
          undefined,
          (text) => heard.push(text)
        );
        await vi.advanceTimersByTimeAsync(7_000);
        const result = await pending;

        expect(heard.length).toBeGreaterThan(0);
        expect(result).toMatchObject({ action: "no_change", failed: true, verdict: "timed_out" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("names a stream cancelled part-way failed", async () => {
      stallingFetch(partial());
      const controller = new AbortController();
      const heard: string[] = [];
      const pending = new VoiceCorrectionService().correct(
        { rawText: "fix the bug in the parser now" },
        SETTINGS,
        controller.signal,
        (text) => heard.push(text)
      );
      await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
      controller.abort();
      const result = await pending;

      expect(result).toMatchObject({ action: "no_change", failed: true, verdict: "failed" });
    });
  });
});
