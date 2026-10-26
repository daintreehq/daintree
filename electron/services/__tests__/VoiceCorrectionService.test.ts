import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { logWarn } from "../../utils/logger.js";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const BASE_SETTINGS = {
  model: "gpt-6-luna",
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

  it("logs the OpenAI error code, not its message, when a request is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: { code: "string_above_max_length", message: "secret dictation text" },
        }),
      } as unknown as Response)
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct({ rawText: "react is great" }, BASE_SETTINGS);

    expect(result.action).toBe("no_change");
    const [, context] = vi.mocked(logWarn).mock.calls.at(-1)!;
    expect(context).toMatchObject({ status: 400, code: "string_above_max_length" });
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls.at(-1))).not.toContain("secret");
  });

  it("keeps prompt_cache_key within OpenAI's 64-character limit for any project and dictionary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({ corrected_text: "Ok." }));
    vi.stubGlobal("fetch", fetchMock);
    const keyFor = async (overrides: Record<string, unknown>) => {
      fetchMock.mockClear();
      await new VoiceCorrectionService().correct(
        { rawText: "react is great" },
        { ...BASE_SETTINGS, ...overrides }
      );
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      return body.prompt_cache_key as string;
    };

    const huge = await keyFor({
      projectName: "p".repeat(500),
      customDictionary: Array.from({ length: 200 }, (_, i) => `Term${i}Longer`),
    });
    expect(huge.length).toBeLessThanOrEqual(64);
    expect((await keyFor({})).length).toBeLessThanOrEqual(64);

    const base = await keyFor({ projectName: "daintree", customDictionary: ["Daintree"] });
    expect(await keyFor({ projectName: "daintree", customDictionary: ["Daintree"] })).toBe(base);
    expect(await keyFor({ projectName: "other", customDictionary: ["Daintree"] })).not.toBe(base);
    expect(await keyFor({ projectName: "daintree", customDictionary: ["Daintree", "X"] })).not.toBe(
      base
    );
    expect(
      await keyFor({
        model: "other-model",
        projectName: "daintree",
        customDictionary: ["Daintree"],
      })
    ).not.toBe(base);
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

  it("sends gpt-6-luna with explicit none reasoning effort and strict JSON output", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct({ rawText: "test" }, BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    // gpt-6-luna defaults reasoning to "medium" when omitted, so the request
    // must pin "none" explicitly — never leave the field off (issue #11365).
    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_output_tokens).toBe(1024);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
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

  it.each([
    { name: "uncertainWords is absent (legacy behavior)", request: { rawText: "Hello world" } },
    {
      name: "wordCount is 0 (no confidence data available)",
      request: { rawText: "Hello world", uncertainWords: [], minConfidence: 1.0, wordCount: 0 },
    },
    {
      name: "minConfidence equals threshold exactly",
      request: { rawText: "Hello world", uncertainWords: [], minConfidence: 0.85, wordCount: 2 },
    },
  ])("does not skip the LLM call when $name", async ({ request }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ action: "no_change", corrected_text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(request, BASE_SETTINGS);

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

  describe("meaning guards", () => {
    async function correctWith(
      rawText: string,
      reply: { action?: "no_change" | "replace"; corrected_text: string; confidence?: string },
      settings: Partial<typeof BASE_SETTINGS> = {}
    ) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(reply)));
      return new VoiceCorrectionService().correct({ rawText }, { ...BASE_SETTINGS, ...settings });
    }

    it("does not apply a low-confidence replacement", async () => {
      const result = await correctWith("the promise rejects when it times out", {
        corrected_text: "The promise regex when it times out.",
        confidence: "low",
      });
      expect(result.action).toBe("no_change");
      expect(result.confirmedText).toBe("the promise rejects when it times out");
    });

    it("applies a medium-confidence cleanup", async () => {
      const result = await correctWith("um wire up the racked component", {
        corrected_text: "Wire up the React component.",
        confidence: "medium",
      });
      expect(result.action).toBe("replace");
      expect(result.confirmedText).toBe("Wire up the React component.");
    });

    it.each([
      ["drops a negation", "don't delete the branch yet", "Delete the branch yet."],
      ["adds a negation", "merge it after the tests pass", "Don't merge it after the tests pass."],
      ["changes a number", "bump the timeout to 3000 ms", "Bump the timeout to 300 ms."],
      [
        "recases a path",
        "fix the bug in src/utils/foo.ts please",
        "Fix the bug in src/Utils/foo.ts.",
      ],
      ["edits a flag", "run it with --dry-run first", "Run it with --dryrun first."],
      ["edits an @-reference", "check @src/App.tsx for the bug", "Check @src/app.tsx for the bug."],
      [
        "edits backticked text",
        "rename `useFooBar` to something clearer",
        "Rename `useFoobar` to something clearer.",
      ],
      [
        "answers the prompt instead of cleaning it",
        "can you explain how the auth flow works",
        "The auth flow works by issuing a short-lived token when the user signs in, then refreshing it in the background with a long-lived refresh token stored securely on the server side.",
      ],
    ])("keeps the raw text when the model %s", async (_label, rawText, corrected) => {
      const result = await correctWith(rawText, { corrected_text: corrected });
      expect(result.action).toBe("no_change");
      expect(result.confirmedText).toBe(rawText);
    });

    it("keeps protected spans byte for byte through an accepted cleanup", async () => {
      const rawText = "um so check @src/App.tsx and run `npm test` with --watch on port 5173";
      const result = await correctWith(rawText, {
        corrected_text: "So check @src/App.tsx and run `npm test` with --watch on port 5173.",
      });
      expect(result.action).toBe("replace");
      for (const span of ["@src/App.tsx", "`npm test`", "--watch", "5173"]) {
        expect(result.confirmedText).toContain(span);
      }
    });

    it("does not recase a custom dictionary term inside a protected span", async () => {
      const rawText = "open daintree/src/index.ts in daintree";
      const result = await correctWith(
        rawText,
        { action: "no_change", corrected_text: "" },
        { customDictionary: ["Daintree"] }
      );
      expect(result.confirmedText).toBe("open daintree/src/index.ts in Daintree");
    });

    it("falls back to the exact raw text, not a recased copy, when a result is rejected", async () => {
      const rawText = "  ask daintree not to push  ";
      const result = await correctWith(
        rawText,
        { corrected_text: "Ask Daintree to push.", confidence: "high" },
        { customDictionary: ["Daintree"] }
      );
      expect(result.action).toBe("no_change");
      expect(result.correctedText).toBe(rawText);
      expect(result.confirmedText).toBe(rawText);
    });

    it("rejects a malformed reply instead of applying it", async () => {
      const result = await correctWith("react is great", {
        corrected_text: "React is great.",
        confidence: "certain",
      });
      expect(result.action).toBe("no_change");
      expect(result.confirmedText).toBe("react is great");
    });
  });

  describe("long passages", () => {
    function longPassage(chars: number): string {
      return "the parser keeps the tokens in order ".repeat(Math.ceil(chars / 37)).slice(0, chars);
    }

    it("leaves a passage over the limit raw without calling the API", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const rawText = longPassage(12_001);

      const result = await new VoiceCorrectionService().correct({ rawText }, BASE_SETTINGS);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.action).toBe("no_change");
      expect(result.confirmedText).toBe(rawText);
    });

    it("gives the reply room to return the whole passage", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ action: "no_change", corrected_text: "" }));
      vi.stubGlobal("fetch", fetchMock);
      const svc = new VoiceCorrectionService();

      const budgetFor = async (chars: number) => {
        fetchMock.mockClear();
        await svc.correct({ rawText: longPassage(chars) }, BASE_SETTINGS);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        return JSON.parse(init.body as string).max_output_tokens as number;
      };

      // Even CJK, at about one token per character, fits with room for the JSON wrapper.
      expect(await budgetFor(4000)).toBeGreaterThan(4000);
      expect(await budgetFor(12_000)).toBeGreaterThan(12_000);
      expect(await budgetFor(12_000)).toBeGreaterThan(await budgetFor(4000));
    });

    it("applies a whole reply but drops one that was cut off, even if it parses", async () => {
      const rawText = longPassage(3000);
      const cleaned = `T${rawText.slice(1)}.`;
      const reply = (status: string) => ({
        ok: true,
        status: 200,
        json: async () => ({
          status,
          incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : undefined,
          output_text: JSON.stringify({
            action: "replace",
            corrected_text: cleaned,
            confidence: "high",
          }),
        }),
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("completed")));
      const whole = await new VoiceCorrectionService().correct({ rawText }, BASE_SETTINGS);
      expect(whole.confirmedText).toBe(cleaned);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("incomplete")));
      const cutOff = await new VoiceCorrectionService().correct({ rawText }, BASE_SETTINGS);
      expect(cutOff.action).toBe("no_change");
      expect(cutOff.confirmedText).toBe(rawText);
      expect(vi.mocked(logWarn).mock.calls.at(-1)?.[1]).toMatchObject({
        errorName: "CorrectionDiscardedError",
        errorCode: "incomplete",
      });
    });

    it("keeps the raw text when the reply drops the end of the passage", async () => {
      const rawText = longPassage(3000);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeFetchResponse({ corrected_text: rawText.slice(0, 2500) }))
      );
      const truncated = await new VoiceCorrectionService().correct({ rawText }, BASE_SETTINGS);
      expect(truncated.action).toBe("no_change");
      expect(truncated.confirmedText).toBe(rawText);
    });

    it.each([
      [5000, 35_000],
      [12_000, 60_000],
    ])(
      "waits for a %i-character passage until %ims, then keeps it raw",
      async (chars, deadline) => {
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
        const rawText = longPassage(chars);
        const resultPromise = new VoiceCorrectionService().correct({ rawText }, BASE_SETTINGS);
        let settled = false;
        void resultPromise.finally(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(deadline - 1);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect((await resultPromise).confirmedText).toBe(rawText);
      }
    );
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
      ["open a PR"],
      ["that is open source"],
      ["keep the file open"],
      ["at least one test file"],
      ["at the top of the file"],
      ["open the settings dialog"],
      ["please reference the old API"],
    ])("skips API call for ordinary speech: %s", async (utterance) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const svc = new VoiceCorrectionService();
      const result = await svc.detectFileLinkTokens(utterance, { apiKey: "sk-test" });

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["link to the hybrid input bar"],
      ["at file index ts"],
      ["reference file auth flow"],
      ["add file router"],
      ["insert file config"],
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
      expect(body.prompt_cache_key).toBe("voice-file-link-v2");
      // File-link detection shares the single voice model and the explicit
      // low-latency reasoning effort (issue #11365).
      expect(body.model).toBe("gpt-6-luna");
      expect(body.reasoning).toEqual({ effort: "none" });
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

    it("outlives the session signal, so a stop doesn't cancel the final utterance", async () => {
      const session = new AbortController();
      let respond: (() => void) | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((resolve, reject) => {
              init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
                once: true,
              });
              respond = () =>
                resolve({
                  ok: true,
                  json: async () => ({
                    output_text: JSON.stringify({
                      file_references: [{ description: "input bar" }],
                    }),
                  }),
                });
            })
        )
      );

      const svc = new VoiceCorrectionService();
      svc.setSessionSignal(session.signal);
      const resultPromise = svc.detectFileLinkTokens(
        "link to input bar",
        { apiKey: "sk-test" },
        new AbortController().signal
      );
      session.abort();
      respond!();

      expect(await resultPromise).toEqual([{ description: "input bar" }]);
    });

    it("returns empty array silently when its signal aborts", async () => {
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
      const resultPromise = svc.detectFileLinkTokens(
        "link to something",
        { apiKey: "sk-test" },
        controller.signal
      );
      controller.abort();

      const result = await resultPromise;
      expect(result).toEqual([]);
    });
  });

  describe("annotateUncertainWords", () => {
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
