import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const BASE_SETTINGS = {
  model: "gpt-5-nano",
  apiKey: "sk-test",
  customDictionary: [] as string[],
};

function makeFetchResponse(
  payload: { action?: "no_change" | "replace"; corrected_text?: string; confidence?: string },
  ok = true,
  status = 200
) {
  return {
    ok,
    status,
    json: async () => ({
      output_text: JSON.stringify({
        action: payload.action ?? "replace",
        corrected_text: payload.corrected_text ?? "",
        confidence: payload.confidence ?? "high",
      }),
    }),
  } as unknown as Response;
}

describe("VoiceCorrectionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns corrected text from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ action: "replace", corrected_text: "React is great." })
        )
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct({ rawText: "react is great" }, BASE_SETTINGS);
    expect(result.correctedText).toBe("React is great.");
    expect(result.confirmedText).toBe("React is great.");
    expect(result.action).toBe("replace");
  });

  it("returns a no_change result without modifying the text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ action: "no_change", corrected_text: "" }))
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct({ rawText: "leave this alone" }, BASE_SETTINGS);
    expect(result.action).toBe("no_change");
    expect(result.correctedText).toBe("leave this alone");
    expect(result.confirmedText).toBe("leave this alone");
  });

  it("falls back to raw text on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse({}, false, 500)));

    const svc = new VoiceCorrectionService();
    const result = await svc.correct({ rawText: "react is great" }, BASE_SETTINGS);
    expect(result.confirmedText).toBe("react is great");
    expect(result.action).toBe("no_change");
  });

  it("falls back to raw text on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve(
                    makeFetchResponse({ action: "replace", corrected_text: "Corrected sentence." })
                  ),
                30000
              )
            )
        )
    );

    const svc = new VoiceCorrectionService();
    const resultPromise = svc.correct({ rawText: "react is great" }, BASE_SETTINGS);
    vi.advanceTimersByTime(8000);
    const result = await resultPromise;
    expect(result.confirmedText).toBe("react is great");
  });

  it("includes project context and custom dictionary in the system prompt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "canopy is great" },
      {
        ...BASE_SETTINGS,
        projectName: "Canopy",
        customDictionary: ["Canopy", "Worktree"],
      }
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.instructions).toContain("Canopy");
    expect(body.instructions).toContain("Worktree");
  });

  it("formats explicit correction context in the user message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      {
        rawText: "react native",
        recentContext: ["I wanna test this app.", "It runs locally."],
        rightContext: "on iOS first",
        reason: "stop",
        segmentCount: 2,
      },
      BASE_SETTINGS
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const userMessage = body.input as string;
    expect(userMessage).toContain("<confirmed_history>");
    expect(userMessage).toContain("<job>");
    expect(userMessage).toContain("reason=stop");
    expect(userMessage).toContain("segments=2");
    expect(userMessage).toContain("<target>");
    expect(userMessage).toContain("<right_context>");
  });

  it("uses structured output without reasoning parameters for gpt-5-mini", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct({ rawText: "test" }, { ...BASE_SETTINGS, model: "gpt-5-mini" });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.reasoning).toBeUndefined();
    expect(body.max_output_tokens).toBe(1024);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.prompt_cache_key).toContain("voice-correction-v4");
  });

  it("skips LLM call when all words are high confidence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    const result = await svc.correct(
      { rawText: "Hello world", uncertainWords: [], minConfidence: 0.95, wordCount: 2 },
      BASE_SETTINGS
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.action).toBe("no_change");
    expect(result.confirmedText).toBe("Hello world");
    expect(result.confidence).toBe("high");
  });

  it("does not skip when uncertainWords is absent (legacy behavior)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ action: "no_change", corrected_text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct({ rawText: "Hello world" }, BASE_SETTINGS);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not skip when wordCount is 0 (no confidence data available)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ action: "no_change", corrected_text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "Hello world", uncertainWords: [], minConfidence: 1.0, wordCount: 0 },
      BASE_SETTINGS
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not skip when minConfidence equals threshold exactly", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ action: "no_change", corrected_text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "Hello world", uncertainWords: [], minConfidence: 0.85, wordCount: 2 },
      BASE_SETTINGS
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("annotates uncertain words in the target block", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "React native" }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "racked native", uncertainWords: ["racked"], minConfidence: 0.6 },
      BASE_SETTINGS
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const userMessage = body.input as string;
    expect(userMessage).toContain("<uncertain>racked</uncertain>");
    expect(userMessage).not.toContain("<uncertain>native</uncertain>");
  });

  it("annotates duplicate uncertain words positionally", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "test corrected" }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "test foo test bar", uncertainWords: ["test", "test"], minConfidence: 0.5 },
      BASE_SETTINGS
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const userMessage = body.input as string;
    expect(userMessage).toContain(
      "<uncertain>test</uncertain> foo <uncertain>test</uncertain> bar"
    );
  });

  describe("annotateUncertainWords", () => {
    it("wraps matching words with uncertain tags", () => {
      const result = VoiceCorrectionService.annotateUncertainWords("hello world foo", ["world"]);
      expect(result).toBe("hello <uncertain>world</uncertain> foo");
    });

    it("handles punctuation attached to words", () => {
      const result = VoiceCorrectionService.annotateUncertainWords("hello, world!", ["hello"]);
      expect(result).toBe("<uncertain>hello</uncertain>, world!");
    });

    it("returns text unchanged when no uncertain words", () => {
      const result = VoiceCorrectionService.annotateUncertainWords("hello world", []);
      expect(result).toBe("hello world");
    });

    it("matches case-insensitively", () => {
      const result = VoiceCorrectionService.annotateUncertainWords("Hello World", ["hello"]);
      expect(result).toBe("<uncertain>Hello</uncertain> World");
    });
  });
});
