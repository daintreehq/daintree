import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { logWarn } from "../../utils/logger.js";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const SETTINGS = {
  model: "claude-haiku-5-5",
  apiKey: "sk-ant-test",
  customDictionary: [] as string[],
};

function reply(correctedText: string, action = "replace", confidence = "high"): string {
  return JSON.stringify({ action, corrected_text: correctedText, confidence });
}

function message(text: string, stopReason = "end_turn") {
  return {
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage: {
      input_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3000,
      output_tokens: 30,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Frame = Record<string, unknown> & { type: string };

/** The reply as Messages stream events, the JSON in small text deltas. */
function frames(json: string, stopReason = "end_turn"): Frame[] {
  const out: Frame[] = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 20, cache_read_input_tokens: 3000, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ];
  for (let i = 0; i < json.length; i += 5) {
    out.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: json.slice(i, i + 5) },
    });
  }
  out.push({ type: "content_block_stop", index: 0 });
  out.push({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 30 },
  });
  out.push({ type: "message_stop" });
  return out;
}

function streamed(list: Frame[], chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(
    list.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("")
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

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string);
}

describe("VoiceCorrectionService on Claude", () => {
  beforeEach(() => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 50));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a cleanup to the Messages API with the schema enforced and thinking off", async () => {
    const fetchMock = stubFetch(jsonResponse(message(reply("Run Vitest."))));

    const result = await new VoiceCorrectionService().correct({ rawText: "run v test" }, SETTINGS);

    expect(result.confirmedText).toBe("Run Vitest.");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": expect.any(String),
    });
    expect(init.headers).not.toHaveProperty("Authorization");
    const body = sentBody(fetchMock);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.required).toEqual([
      "action",
      "corrected_text",
      "confidence",
    ]);
    expect(body.system).toEqual([
      expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } }),
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: expect.stringContaining("<target>\nrun v test\n</target>") },
    ]);
    // No OpenAI-only fields reach Anthropic.
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("input");
  });

  it("turns Sonnet's thinking off the way Sonnet 5.5 accepts", async () => {
    const fetchMock = stubFetch(jsonResponse(message(reply("Ok."))));
    await new VoiceCorrectionService().correct(
      { rawText: "ok" },
      { ...SETTINGS, model: "claude-sonnet-5-5" }
    );
    expect(sentBody(fetchMock).thinking).toEqual({ type: "between_tools" });
  });

  it("thinks adaptively at the effort asked for, with room for the thinking", async () => {
    const fetchMock = stubFetch(jsonResponse(message(reply("Ok."))));
    await new VoiceCorrectionService().correct(
      { rawText: "ok" },
      { ...SETTINGS, reasoningEffort: "medium" }
    );
    const body = sentBody(fetchMock);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config.effort).toBe("medium");
    expect(body.max_tokens).toBeGreaterThan(4096);
  });

  it("counts cache reads and writes inside the input, as OpenAI's usage does", async () => {
    stubFetch(
      jsonResponse({
        ...message(reply("Ok.")),
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 3000,
          output_tokens: 30,
        },
      })
    );
    const result = await new VoiceCorrectionService().correct({ rawText: "ok" }, SETTINGS);
    expect(result.roundTrip?.usage).toEqual({
      inputTokens: 3120,
      cachedTokens: 3000,
      cacheWriteTokens: 100,
      outputTokens: 30,
      reasoningTokens: 0,
    });
  });

  it("marks the last recent prompt as a cache breakpoint, and nothing after it", async () => {
    const fetchMock = stubFetch(jsonResponse(message(reply("Ok."))));
    await new VoiceCorrectionService().correct(
      { rawText: "ok", recentPrompts: ["first prompt", "second prompt"] },
      SETTINGS
    );
    const content = sentBody(fetchMock).messages[0].content;
    expect(content).toHaveLength(3);
    expect(content.map((block: { cache_control?: unknown }) => block.cache_control)).toEqual([
      undefined,
      { type: "ephemeral" },
      undefined,
    ]);
    expect(content[0].text).toContain("<recent_prompts>");
    expect(content[2].text).toContain("<target>\nok\n</target>");
  });

  it("streams the corrected text and lands the same result", async () => {
    const corrected = "Fix the bug in the parser, then run the tests.";
    stubFetch(streamed(frames(reply(corrected))));
    const heard: string[] = [];

    const result = await new VoiceCorrectionService().correct(
      { rawText: "fix the bug in the parser then run the tests" },
      SETTINGS,
      undefined,
      (text) => heard.push(text)
    );

    expect(result.confirmedText).toBe(corrected);
    expect(heard.length).toBeGreaterThan(1);
    expect(corrected.startsWith(heard[heard.length - 1]!)).toBe(true);
    expect(result.roundTrip?.usage).toMatchObject({ cachedTokens: 3000, outputTokens: 30 });
  });

  it("keeps the raw text when the reply ran out of tokens", async () => {
    stubFetch(streamed(frames(reply("Half a"), "max_tokens")));
    const result = await new VoiceCorrectionService().correct(
      { rawText: "half a sentence" },
      SETTINGS,
      undefined,
      () => undefined
    );
    expect(result).toMatchObject({ confirmedText: "half a sentence", failed: true });
  });

  it("keeps the raw text when the stream ends before message_stop", async () => {
    stubFetch(streamed(frames(reply("Cut off.")).slice(0, -1)));
    const result = await new VoiceCorrectionService().correct(
      { rawText: "cut off" },
      SETTINGS,
      undefined,
      () => undefined
    );
    expect(result).toMatchObject({ confirmedText: "cut off", failed: true });
  });

  it("keeps the raw text on a refusal, even when the reply parses", async () => {
    stubFetch(jsonResponse(message(reply("Hello there."), "refusal")));
    const result = await new VoiceCorrectionService().correct({ rawText: "hello" }, SETTINGS);
    expect(result).toMatchObject({ confirmedText: "hello", failed: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Correction failed"),
      expect.objectContaining({ errorCode: "refused" })
    );
  });

  it("keeps the raw text on a streamed refusal", async () => {
    stubFetch(streamed(frames(reply("Hello there."), "refusal")));
    const result = await new VoiceCorrectionService().correct(
      { rawText: "hello" },
      SETTINGS,
      undefined,
      () => undefined
    );
    expect(result).toMatchObject({ confirmedText: "hello", failed: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Correction failed"),
      expect.objectContaining({ errorCode: "refused" })
    );
  });

  it("logs Anthropic's error type, never its message", async () => {
    stubFetch(
      jsonResponse(
        { type: "error", error: { type: "overloaded_error", message: "echoes run v test" } },
        529
      )
    );
    const result = await new VoiceCorrectionService().correct({ rawText: "run v test" }, SETTINGS);
    expect(result.failed).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Correction failed"),
      expect.objectContaining({ status: 529, code: "overloaded_error" })
    );
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain("echoes");
  });

  it("fails on an error event mid-stream with its type, never its message", async () => {
    stubFetch(
      streamed([
        frames(reply("Ok."))[0]!,
        { type: "error", error: { type: "overloaded_error", message: "echoes ok" } },
      ])
    );
    const result = await new VoiceCorrectionService().correct(
      { rawText: "ok" },
      SETTINGS,
      undefined,
      () => undefined
    );
    expect(result.failed).toBe(true);
    // An ignored error event would end as a cut-off stream, logged without a status.
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Correction failed"),
      expect.objectContaining({ status: 200, code: "overloaded_error" })
    );
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain("echoes");
  });

  it("warms with the passage's own request shape, without OpenAI's store flag", async () => {
    const fetchMock = stubFetch(jsonResponse(message(reply("x"), "max_tokens")));
    await new VoiceCorrectionService().warm(SETTINGS);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty("store");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config.format.type).toBe("json_schema");
  });

  it("preconnects to Anthropic for a Claude cleanup", async () => {
    const fetchMock = stubFetch(new Response(""));
    new VoiceCorrectionService().preconnect("anthropic");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/");
  });

  it("keeps each provider's preconnect apart", async () => {
    const fetchMock = vi.fn((url: string) =>
      url.endsWith("/v1/messages")
        ? Promise.resolve(jsonResponse(message(reply("Ok."))))
        : // A probe that never lands.
          new Promise<Response>(() => undefined)
    );
    vi.stubGlobal("fetch", fetchMock);
    const svc = new VoiceCorrectionService();

    svc.preconnect("openai");
    // OpenAI's pending probe neither stands in for Anthropic's nor holds a Claude cleanup.
    svc.preconnect("anthropic");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/",
      "https://api.anthropic.com/",
    ]);

    vi.useFakeTimers();
    try {
      const pending = svc.correct({ rawText: "ok" }, SETTINGS);
      await vi.advanceTimersByTimeAsync(249);
      // Waiting on its own probe, which hasn't landed, for at most the preconnect wait.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).confirmedText).toBe("Ok.");
      expect(fetchMock.mock.calls[2]![0]).toBe("https://api.anthropic.com/v1/messages");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a Claude cleanup straight away while only OpenAI's probe is pending", async () => {
    const fetchMock = vi.fn((url: string) =>
      url.endsWith("/v1/messages")
        ? Promise.resolve(jsonResponse(message(reply("Ok."))))
        : new Promise<Response>(() => undefined)
    );
    vi.stubGlobal("fetch", fetchMock);
    const svc = new VoiceCorrectionService();
    svc.preconnect("openai");

    vi.useFakeTimers();
    try {
      const pending = svc.correct({ rawText: "ok" }, SETTINGS);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock.mock.calls[1]![0]).toBe("https://api.anthropic.com/v1/messages");
      expect((await pending).confirmedText).toBe("Ok.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rewrites a selection on Claude", async () => {
    const fetchMock = stubFetch(
      jsonResponse(
        message(JSON.stringify({ action: "replace", rewritten_text: "Shorter text here." }))
      )
    );
    const outcome = await new VoiceCorrectionService().rewrite(
      { selectedText: "Some long text here.", instruction: "make it shorter" },
      SETTINGS
    );
    expect(outcome).toEqual({ status: "replace", text: "Shorter text here." });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
    expect(sentBody(fetchMock).output_config.format.schema.required).toEqual([
      "action",
      "rewritten_text",
    ]);
  });
});
