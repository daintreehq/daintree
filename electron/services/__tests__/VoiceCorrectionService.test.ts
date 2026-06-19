import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

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

  it("removes leading filler from replacement text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ action: "replace", corrected_text: "Um, React is great." })
        )
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct({ rawText: "um react is great" }, BASE_SETTINGS);
    expect(result.correctedText).toBe("React is great.");
    expect(result.confirmedText).toBe("React is great.");
  });

  it("keeps raw text unchanged when API returns no_change with leading filler", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFetchResponse({ action: "no_change", corrected_text: "Um, React is great." })
        )
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct({ rawText: "um react is great" }, BASE_SETTINGS);
    expect(result.correctedText).toBe("um react is great");
    expect(result.confirmedText).toBe("um react is great");
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

  it("canonicalizes exact custom dictionary term casing deterministically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          action: "no_change",
          corrected_text: "we need to update the daintree dashboard",
        })
      )
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct(
      { rawText: "we need to update the daintree dashboard" },
      { ...BASE_SETTINGS, customDictionary: ["Daintree"] }
    );

    expect(result.action).toBe("replace");
    expect(result.correctedText).toBe("we need to update the Daintree dashboard");
    expect(result.confirmedText).toBe("we need to update the Daintree dashboard");
  });

  it("does not force custom dictionary terms inside larger words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          action: "replace",
          corrected_text: "the daintreehouse fixture mentions daintree",
        })
      )
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct(
      { rawText: "the daintreehouse fixture mentions daintree" },
      { ...BASE_SETTINGS, customDictionary: ["Daintree"] }
    );

    expect(result.confirmedText).toBe("the daintreehouse fixture mentions Daintree");
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
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => {}, 30000);
            init.signal!.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(init.signal!.reason);
              },
              { once: true }
            );
          })
      )
    );

    const svc = new VoiceCorrectionService();
    const resultPromise = svc.correct({ rawText: "react is great" }, BASE_SETTINGS);
    await vi.advanceTimersByTimeAsync(8000);
    const result = await resultPromise;
    expect(result.confirmedText).toBe("react is great");
    expect(result.action).toBe("no_change");
  });

  it("keeps the short timeout for single-sentence corrections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => {}, 30000);
            init.signal!.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(init.signal!.reason);
              },
              { once: true }
            );
          })
      )
    );

    const svc = new VoiceCorrectionService();
    const resultPromise = svc.correct({ rawText: "type script compiler" }, BASE_SETTINGS);
    await vi.advanceTimersByTimeAsync(6999);
    await Promise.resolve();

    let settled = false;
    resultPromise.finally(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;
    expect(result.confirmedText).toBe("type script compiler");
    expect(result.action).toBe("no_change");
  });

  it("allows a longer timeout for paragraph-length corrections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => {}, 30000);
            init.signal!.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(init.signal!.reason);
              },
              { once: true }
            );
          })
      )
    );

    const input =
      "um so the type script compiler is throwing errors and we need to fix the racked component, also the tail wind styles are broken and the zoo stand store needs updating";
    const svc = new VoiceCorrectionService();
    const resultPromise = svc.correct({ rawText: input }, BASE_SETTINGS);

    let settled = false;
    resultPromise.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(8000);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(7000);
    const result = await resultPromise;
    expect(result.confirmedText).toBe(input);
    expect(result.action).toBe("no_change");
  }, 20_000);

  it("includes project context and custom dictionary in the system prompt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "daintree is great" },
      {
        ...BASE_SETTINGS,
        projectName: "Daintree",
        customDictionary: ["Daintree", "Worktree"],
      }
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // System prompt rides in the first developer message of `input`, not the
    // top-level `instructions` field — required for prompt caching (issue #9746).
    expect(body.instructions).toBeUndefined();
    expect(body.input[0].role).toBe("developer");
    expect(body.input[0].content).toContain("Daintree");
    expect(body.input[0].content).toContain("Worktree");
    expect(body.input[1].role).toBe("user");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the cacheable system prompt as the first developer message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct({ rawText: "react is great" }, BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.input).toHaveLength(2);
    expect(body.input[0].role).toBe("developer");
    expect(body.input[0].content).toContain("speech-to-text correction engine");
    // The static prefix must not be split into the short-lived `instructions` field,
    // and we intentionally omit prompt_cache_retention (issue #9746).
    expect(body.instructions).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it("keeps the cacheable prefix identical across utterances while the user turn varies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "react is great", reason: "stop", segmentCount: 1 },
      BASE_SETTINGS
    );
    await svc.correct(
      { rawText: "type script rules", recentContext: ["earlier text"], segmentCount: 3 },
      BASE_SETTINGS
    );

    const first = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const second = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(first.input[0].content).toBe(second.input[0].content);
    expect(first.prompt_cache_key).toBe(second.prompt_cache_key);
    expect(first.input[1].content).not.toBe(second.input[1].content);
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
    const userMessage = body.input[1].content as string;
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
    expect(body.prompt_cache_key).toMatch(/^voice-correction-v7:/);
  });

  it("uses low reasoning effort for gpt-5-nano corrections", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct({ rawText: "test" }, { ...BASE_SETTINGS, model: "gpt-5-nano" });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_output_tokens).toBe(1024);
    expect(body.text.format.type).toBe("json_schema");
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
    const userMessage = body.input[1].content as string;
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
    const userMessage = body.input[1].content as string;
    expect(userMessage).toContain(
      "<uncertain>test</uncertain> foo <uncertain>test</uncertain> bar"
    );
  });

  it("returns fallback silently on session abort", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
              once: true,
            });
          })
      )
    );

    const svc = new VoiceCorrectionService();
    svc.setSessionSignal(controller.signal);

    const resultPromise = svc.correct({ rawText: "react is great" }, BASE_SETTINGS);
    controller.abort();

    const result = await resultPromise;
    expect(result.confirmedText).toBe("react is great");
    expect(result.action).toBe("no_change");
  });

  describe("detectFileLinkTokens", () => {
    it("returns detected file references from the API", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              file_references: [{ description: "hybrid input bar" }],
            }),
          }),
        } as unknown as Response)
      );

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens("link to the hybrid input bar", {
        apiKey: "sk-test",
      });

      expect(result).toEqual([{ description: "hybrid input bar" }]);
    });

    it("returns empty array on API error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        } as unknown as Response)
      );

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens("link to something", { apiKey: "sk-test" });

      expect(result).toEqual([]);
    });

    it("returns empty array for empty utterance", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens("", { apiKey: "sk-test" });

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips API call when utterance has no trigger phrase", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens("update the sidebar width", {
        apiKey: "sk-test",
      });

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["link to the hybrid input bar"],
      ["at file index ts"],
      ["please reference the auth flow"],
      ["add file router"],
      ["insert file config"],
      ["open the hybrid input"],
      ["at the bar component"],
    ])("calls API when trigger phrase present: %s", async (utterance) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ file_references: [] }),
        }),
      } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const svc = new VoiceCorrectionService();
      await svc.detectFileLinkTokens(utterance, { apiKey: "sk-test" });

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("uses max_output_tokens=256 for file-link detection (not 128)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ file_references: [] }),
        }),
      } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const svc = new VoiceCorrectionService();
      await svc.detectFileLinkTokens("link to something", { apiKey: "sk-test" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.max_output_tokens).toBe(256);
      expect(body.prompt_cache_key).toBe("voice-file-link-v1");
    });

    it("preserves all references in a multi-reference utterance (regression)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              file_references: [
                { description: "hybrid input bar" },
                { description: "auth service" },
                { description: "project switcher" },
              ],
            }),
          }),
        } as unknown as Response)
      );

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens(
        "link to the hybrid input bar and the auth service and the project switcher",
        { apiKey: "sk-test" }
      );

      expect(result).toEqual([
        { description: "hybrid input bar" },
        { description: "auth service" },
        { description: "project switcher" },
      ]);
    });

    it("returns empty array when response is truncated (status=incomplete)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output_text: "",
          }),
        } as unknown as Response)
      );

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens(
        "link to the hybrid input bar and the auth flow",
        { apiKey: "sk-test" }
      );

      expect(result).toEqual([]);
    });

    it("returns empty array on malformed JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            output_text: "not json",
          }),
        } as unknown as Response)
      );

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens("link to something", { apiKey: "sk-test" });

      expect(result).toEqual([]);
    });

    it("filters out empty descriptions", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              file_references: [{ description: "valid" }, { description: "  " }],
            }),
          }),
        } as unknown as Response)
      );

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens("link to valid and nothing", {
        apiKey: "sk-test",
      });

      expect(result).toEqual([{ description: "valid" }]);
    });

    it("returns empty array on timeout", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              const timer = setTimeout(() => {}, 30000);
              init.signal!.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(init.signal!.reason);
                },
                { once: true }
              );
            })
        )
      );

      const svc = new VoiceCorrectionService();
      const resultPromise = svc.detectFileLinkTokens("link to something", { apiKey: "sk-test" });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result).toEqual([]);
    });

    it("returns empty array silently on session abort", async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
                once: true,
              });
            })
        )
      );

      const svc = new VoiceCorrectionService();
      svc.setSessionSignal(controller.signal);

      const resultPromise = svc.detectFileLinkTokens("link to something", { apiKey: "sk-test" });
      controller.abort();

      const result = await resultPromise;
      expect(result).toEqual([]);
    });
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
