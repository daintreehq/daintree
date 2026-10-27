import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { logWarn } from "../../utils/logger.js";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";
import type { VoiceCommandTarget } from "../voiceCommandTarget.js";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import { getBuiltinSlashCommands } from "../../../shared/types/slashCommands.js";
import { buildVoiceCommandVocabulary } from "../../../shared/utils/voiceAgentCommands.js";

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

  // The recasing pass this replaced rewrote every one of these.
  it.each([
    ["@src/react/hooks.ts", ["React", "Go"]],
    ["vite.config.ts", ["Vite"]],
    ["let's go", ["React", "Go"]],
    ["we need to update the daintree dashboard", ["Daintree"]],
    ["open daintree/src/index.ts in daintree", ["Daintree"]],
  ])("leaves %s as transcribed when the model changes nothing", async (rawText, terms) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFetchResponse({ action: "no_change", corrected_text: "" }))
    );

    const result = await new VoiceCorrectionService().correct(
      { rawText },
      { ...BASE_SETTINGS, customDictionary: terms }
    );

    expect(result.action).toBe("no_change");
    expect(result.confirmedText).toBe(rawText);
  });

  it("applies the model's cleanup without recasing dictionary terms in it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeFetchResponse({
          action: "replace",
          corrected_text: "Fix @src/react/hooks.ts, let's go.",
        })
      )
    );

    const result = await new VoiceCorrectionService().correct(
      { rawText: "fix @src/react/hooks.ts let's go" },
      { ...BASE_SETTINGS, customDictionary: ["React", "Go"] }
    );

    expect(result.confirmedText).toBe("Fix @src/react/hooks.ts, let's go.");
  });

  it("sends the heard-as rules in the prompt and keys the cache on what they say", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({ action: "no_change" }));
    vi.stubGlobal("fetch", fetchMock);
    const svc = new VoiceCorrectionService();
    const send = async (heardAs: { heard: string; term: string }[], rawText = "add Zustand") => {
      fetchMock.mockClear();
      await svc.correct({ rawText }, { ...BASE_SETTINGS, heardAs });
      return JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    };

    const rule = await send([{ heard: "zoo stand", term: "Zustand" }]);
    const sameRule = await send([{ heard: "zoo stand", term: "Zustand" }], "another passage");
    const otherHeard = await send([{ heard: "zoo stan", term: "Zustand" }]);
    const otherTerm = await send([{ heard: "zoo stand", term: "Zustand2" }]);
    const none = await send([]);

    expect(rule.input[0].content).toContain("zoo stand: Zustand");
    expect(none.input[0].content).not.toContain("<user_terms>");
    expect(sameRule.prompt_cache_key).toBe(rule.prompt_cache_key);
    expect(sameRule.input[0].content).toBe(rule.input[0].content);
    const keys = [rule, otherHeard, otherTerm, none].map((body) => body.prompt_cache_key);
    expect(new Set(keys).size).toBe(4);
  });

  it("falls back to raw text on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse({}, false, 500)));

    const svc = new VoiceCorrectionService();
    const result = await svc.correct({ rawText: "react is great" }, BASE_SETTINGS);
    expect(result.confirmedText).toBe("react is great");
    expect(result.action).toBe("no_change");
    expect(result.failed).toBe(true);
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

  it("folds workspace names into prompt_cache_key, and keeps the old key without them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({ corrected_text: "Ok." }));
    vi.stubGlobal("fetch", fetchMock);
    const requestFor = async (overrides: Record<string, unknown>) => {
      fetchMock.mockClear();
      await new VoiceCorrectionService().correct(
        { rawText: "run it on studio one" },
        { ...BASE_SETTINGS, projectName: "daintree", customDictionary: ["Daintree"], ...overrides }
      );
      return JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
        prompt_cache_key: string;
        input: Array<{ content: string }>;
      };
    };

    const without = await requestFor({});
    const [prefix] = without.prompt_cache_key.split(":");
    const namesFreeFingerprint = createHash("sha256")
      .update(JSON.stringify([BASE_SETTINGS.model, "daintree", "none", ["Daintree"]]))
      .digest("hex")
      .slice(0, 32);
    expect(without.prompt_cache_key).toBe(`${prefix}:${namesFreeFingerprint}`);
    expect((await requestFor({ knownNames: [] })).prompt_cache_key).toBe(without.prompt_cache_key);

    const studio = await requestFor({ knownNames: ["Studio 1"] });
    expect(studio.prompt_cache_key).not.toBe(without.prompt_cache_key);
    expect(studio.prompt_cache_key.length).toBeLessThanOrEqual(64);
    expect(studio.input[0].content).toContain('"Studio 1"');
    expect((await requestFor({ knownNames: ["Studio 2"] })).prompt_cache_key).not.toBe(
      studio.prompt_cache_key
    );
    expect((await requestFor({ knownNames: ["Studio 1"] })).prompt_cache_key).toBe(
      studio.prompt_cache_key
    );

    // Heard-as rules fold in the same way: no rules, no change to the key.
    expect((await requestFor({ heardAs: [] })).prompt_cache_key).toBe(without.prompt_cache_key);
    const rule = [{ heard: "studio one", term: "Studio 1" }];
    const ruled = await requestFor({ heardAs: rule });
    const both = await requestFor({ knownNames: ["Studio 1"], heardAs: rule });
    expect(new Set([without, studio, ruled, both].map((r) => r.prompt_cache_key)).size).toBe(4);
    expect(both.prompt_cache_key.length).toBeLessThanOrEqual(64);
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
        terminalOutput: "Use the migration or the shim?",
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
    expect(userMessage).toContain(
      "<terminal_output>\nUse the migration or the shim?\n</terminal_output>"
    );
  });

  it("leaves the terminal output out of the system prompt and the message when there is none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ corrected_text: "Corrected." }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct(
      { rawText: "go with the shin", terminalOutput: "Use the shim?" },
      BASE_SETTINGS
    );
    await svc.correct({ rawText: "go with the shin" }, BASE_SETTINGS);

    const [withOutput, without] = fetchMock.mock.calls.map(
      (call) => JSON.parse((call as [string, RequestInit])[1].body as string).input
    );
    expect(withOutput[0].content).toBe(without[0].content);
    expect(withOutput[0].content).not.toContain("Use the shim?");
    expect(withOutput[1].content).toContain("<terminal_output>\nUse the shim?\n</terminal_output>");
    expect(without[1].content).not.toContain("<terminal_output>");
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
    expect(result.failed).toBe(true);
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

    it.each([
      [
        "a resolved self-correction",
        "Use the old API, no wait, the new one for the session refresh.",
        "Use the new one for the session refresh.",
      ],
      [
        "a spoken list laid out on its own lines",
        "Two things. One, bump the timeout. And two, log the retries.",
        "Two things:\n1. Bump the timeout.\n2. Log the retries.",
      ],
    ])("applies %s", async (_label, rawText, corrected) => {
      const result = await correctWith(rawText, { corrected_text: corrected });
      expect(result.action).toBe("replace");
      expect(result.confirmedText).toBe(corrected);
    });

    it("keeps a self-correction as spoken when it would drop a negation", async () => {
      const rawText = "Don't push to main, no wait, push to the release branch.";
      const result = await correctWith(rawText, { corrected_text: "Push to the release branch." });
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
      // The request worked; only its answer was refused.
      expect(result.failed).toBeUndefined();
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

  describe("target commands", () => {
    function userSkill(agentId: "claude" | "codex", name: string, description: string) {
      return {
        id: `user:skill:${name}`,
        label: name,
        insertText: `$${name}`,
        description,
        scope: "user" as const,
        agentId,
        kind: "skill" as const,
        trigger: "$" as const,
      };
    }

    function targetFor(
      agentId: "claude" | "codex",
      isAssistant = false,
      extra: ReturnType<typeof userSkill>[] = []
    ): VoiceCommandTarget {
      const config = getAgentConfig(agentId)!;
      return {
        agentId,
        agentName: config.name,
        isAssistant,
        vocabulary: buildVoiceCommandVocabulary(
          [
            ...getBuiltinSlashCommands(agentId),
            ...(agentId === "codex"
              ? [
                  {
                    id: "user:plugin:github",
                    label: "GitHub",
                    insertText: "$github",
                    description: "GitHub plugin",
                    scope: "user" as const,
                    agentId,
                    kind: "plugin" as const,
                    trigger: "$" as const,
                  },
                  {
                    id: "user:skill:plugin-creator",
                    label: "Plugin Creator",
                    insertText: "$plugin-creator",
                    description: "Scaffold a plugin",
                    scope: "user" as const,
                    agentId,
                    kind: "skill" as const,
                    trigger: "$" as const,
                  },
                ]
              : []),
            ...extra,
          ],
          config.completionSources!
        ),
      };
    }

    function stubReply(correctedText: string, action: "replace" | "no_change" = "replace") {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ action, corrected_text: correctedText }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
      return JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    }

    it("tells correction the target and the commands it has", async () => {
      const fetchMock = stubReply("Compact.");
      await new VoiceCorrectionService().correct(
        { rawText: "compact", startsPrompt: true },
        { ...BASE_SETTINGS, commandTarget: targetFor("codex") }
      );
      const body = sentBody(fetchMock);
      expect(body.input[0].content).toContain("Codex, an AI coding agent");
      expect(body.input[0].content).toContain("$plugin-creator — Scaffold a plugin");
      expect(body.input[0].content).toContain("/compact");
      expect(body.input[1].content).toContain("prompt_start=yes");
    });

    it("screens credentials out of the commands it lists", async () => {
      const fetchMock = stubReply("Hi.");
      await new VoiceCorrectionService().correct(
        { rawText: "hi", startsPrompt: true },
        {
          ...BASE_SETTINGS,
          commandTarget: targetFor("codex", false, [
            userSkill(
              "codex",
              "deploy",
              "Ship it with OPENAI_API_KEY=sk-proj-Ab3dEf6hIj9kLm2nOp5q"
            ),
            userSkill("codex", "3f9a2c71d8e4b05a", "Pinned build"),
          ]),
        }
      );
      const prompt: string = sentBody(fetchMock).input[0].content;
      expect(prompt).toMatch(/^\$deploy$/m);
      expect(prompt).not.toContain("sk-proj-");
      expect(prompt).not.toContain("3f9a2c71d8e4b05a");
      expect(prompt).not.toContain("Pinned build");
      expect(prompt).toContain("$plugin-creator — Scaffold a plugin");
    });

    it("names the Assistant as the target", async () => {
      const fetchMock = stubReply("Hi.");
      await new VoiceCorrectionService().correct(
        { rawText: "hi", startsPrompt: false },
        { ...BASE_SETTINGS, commandTarget: targetFor("claude", true) }
      );
      const body = sentBody(fetchMock);
      expect(body.input[0].content).toContain("the Daintree Assistant");
      expect(body.input[1].content).toContain("prompt_start=no");
    });

    it("writes an implied command at the start of the prompt", async () => {
      stubReply("/compact");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "compact the conversation", startsPrompt: true },
        { ...BASE_SETTINGS, commandTarget: targetFor("claude") }
      );
      expect(result.confirmedText).toBe("/compact");
      expect(result.action).toBe("replace");
    });

    it("writes a skill in the target's own syntax", async () => {
      stubReply("$plugin-creator for the linter");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "use the plugin creator skill for the linter", startsPrompt: true },
        { ...BASE_SETTINGS, commandTarget: targetFor("codex") }
      );
      expect(result.confirmedText).toBe("$plugin-creator for the linter");
    });

    it("accepts a polite request the command replaced", async () => {
      stubReply("/review on auth");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "can you please run the review skill on auth", startsPrompt: true },
        { ...BASE_SETTINGS, commandTarget: targetFor("claude") }
      );
      expect(result.confirmedText).toBe("/review on auth");
    });

    it("keeps dictionary casing out of a command token", async () => {
      stubReply("$github");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "use the github plugin", startsPrompt: true },
        { ...BASE_SETTINGS, customDictionary: ["GitHub"], commandTarget: targetFor("codex") }
      );
      expect(result.confirmedText).toBe("$github");
    });

    it("keeps dictionary casing out of every part of a command token", async () => {
      stubReply("$plugin-creator for the linter");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "use the plugin creator skill for the linter", startsPrompt: true },
        { ...BASE_SETTINGS, customDictionary: ["Creator"], commandTarget: targetFor("codex") }
      );
      expect(result.confirmedText).toBe("$plugin-creator for the linter");
    });

    it.each([
      ["a command the target doesn't have", "run the deploy skill", "/deploy", true],
      ["another agent's syntax", "use the plugin creator skill", "$plugin-creator", true],
      ["a command away from the start", "compact the conversation", "/compact", false],
      ["a mention turned into a command", "the review skill is broken", "/review is broken", true],
    ])("keeps the raw text for %s", async (_label, rawText, reply, startsPrompt) => {
      stubReply(reply);
      const result = await new VoiceCorrectionService().correct(
        { rawText, startsPrompt },
        { ...BASE_SETTINGS, commandTarget: targetFor("claude") }
      );
      expect(result.confirmedText).toBe(rawText);
      expect(result.action).toBe("no_change");
    });

    it("keeps a leading command's arguments as dictated", async () => {
      stubReply("/review The last commit.");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "/review the last commit", startsPrompt: true },
        { ...BASE_SETTINGS, commandTarget: targetFor("claude") }
      );
      expect(result.confirmedText).toBe("/review the last commit");
    });

    it("keeps dictionary casing out of a command's arguments", async () => {
      stubReply("", "no_change");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "/review the daintree changes", startsPrompt: true },
        {
          ...BASE_SETTINGS,
          customDictionary: ["Daintree"],
          commandTarget: targetFor("claude"),
        }
      );
      expect(result.confirmedText).toBe("/review the daintree changes");
    });

    it("rejects invented command syntax with no target at all", async () => {
      stubReply("/compact");
      const result = await new VoiceCorrectionService().correct(
        { rawText: "compact the conversation", startsPrompt: true },
        BASE_SETTINGS
      );
      expect(result.confirmedText).toBe("compact the conversation");
    });

    it("keys the prompt cache by target", async () => {
      const fetchMock = stubReply("Hi.");
      const svc = new VoiceCorrectionService();
      await svc.correct(
        { rawText: "hi" },
        { ...BASE_SETTINGS, commandTarget: targetFor("claude") }
      );
      await svc.correct({ rawText: "hi" }, { ...BASE_SETTINGS, commandTarget: targetFor("codex") });
      const key = (call: number) =>
        JSON.parse((fetchMock.mock.calls[call] as [string, RequestInit])[1].body as string)
          .prompt_cache_key;
      expect(key(0)).not.toBe(key(1));
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

describe("VoiceCorrectionService.rewrite", () => {
  function rewriteResponse(action: "no_change" | "replace", rewritten_text: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_text: JSON.stringify({ action, rewritten_text }) }),
    } as unknown as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the selection and the instruction as separate, labelled blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rewriteResponse("replace", "Is it fixed?"));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new VoiceCorrectionService().rewrite(
      { selectedText: "it is fixed", instruction: " rephrase as a question " },
      BASE_SETTINGS
    );

    expect(outcome).toEqual({ status: "replace", text: "Is it fixed?" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.model).toBe(BASE_SETTINGS.model);
    expect(body.text.format.strict).toBe(true);
    expect(body.input[1].content).toBe(
      "<selection>\nit is fixed\n</selection>\n\n<instruction>\nrephrase as a question\n</instruction>"
    );
  });

  it("keeps the selection's own leading and trailing whitespace around the rewrite", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rewriteResponse("replace", "  Shorter.\n")));

    const outcome = await new VoiceCorrectionService().rewrite(
      { selectedText: " a much longer sentence here.\n\n", instruction: "make it shorter" },
      BASE_SETTINGS
    );

    expect(outcome).toEqual({ status: "replace", text: " Shorter.\n\n" });
  });

  it("rejects a rewrite that changes a reference, flag or backticked span", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(rewriteResponse("replace", "Run the tests on the app."))
    );

    const outcome = await new VoiceCorrectionService().rewrite(
      { selectedText: "run `npm test` on @src/App.tsx", instruction: "make it shorter" },
      BASE_SETTINGS
    );

    expect(outcome).toEqual({ status: "rejected" });
  });

  it("reports no_change when the model declines or returns the selection unchanged", async () => {
    const svc = new VoiceCorrectionService();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(rewriteResponse("no_change", "Something else entirely."))
    );
    expect(
      await svc.rewrite({ selectedText: "keep me", instruction: "hmm" }, BASE_SETTINGS)
    ).toEqual({ status: "no_change" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rewriteResponse("replace", "keep me")));
    expect(
      await svc.rewrite({ selectedText: " keep me ", instruction: "tidy it" }, BASE_SETTINGS)
    ).toEqual({ status: "no_change" });
  });

  it("is unavailable without an API key and makes no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new VoiceCorrectionService().rewrite(
      { selectedText: "text", instruction: "shorter" },
      { ...BASE_SETTINGS, apiKey: "" }
    );

    expect(outcome).toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without logging content on an API error, a cut-off reply or a malformed one", async () => {
    const svc = new VoiceCorrectionService();
    const request = { selectedText: "secret selection", instruction: "secret instruction" };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "server_error" } }),
      })
    );
    expect(await svc.rewrite(request, BASE_SETTINGS)).toEqual({ status: "failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "incomplete",
          output_text: JSON.stringify({ action: "replace", rewritten_text: "secret cut-off" }),
        }),
      })
    );
    expect(await svc.rewrite(request, BASE_SETTINGS)).toEqual({ status: "failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({ action: "rewrite", rewritten_text: "secret rewrite" }),
        }),
      })
    );
    expect(await svc.rewrite(request, BASE_SETTINGS)).toEqual({ status: "failed" });

    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toMatch(/secret/);
  });

  it("is not cancelled by the recording session's signal", async () => {
    const session = new AbortController();
    const svc = new VoiceCorrectionService();
    svc.setSessionSignal(session.signal);
    session.abort();
    const fetchMock = vi.fn().mockResolvedValue(rewriteResponse("replace", "Shorter."));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await svc.rewrite(
      { selectedText: "a long sentence", instruction: "shorter" },
      BASE_SETTINGS
    );

    expect(outcome).toEqual({ status: "replace", text: "Shorter." });
    expect((fetchMock.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(false);
  });
});
