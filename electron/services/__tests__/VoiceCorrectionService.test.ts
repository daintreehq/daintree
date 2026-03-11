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
    expect(body.prompt_cache_key).toContain("voice-correction-v3");
  });
});
