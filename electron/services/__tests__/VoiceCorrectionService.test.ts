import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const BASE_SETTINGS = {
  model: "gpt-5-nano",
  apiKey: "sk-test",
  customDictionary: [] as string[],
};

function makeFetchResponse(content: string, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => ({
      choices: [{ message: { content } }],
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse("React is great.")));

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("react is great", BASE_SETTINGS);
    expect(result).toBe("React is great.");
  });

  it("falls back to raw text on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse("", false, 500)));

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("react is great", BASE_SETTINGS);
    expect(result).toBe("react is great");
  });

  it("falls back to raw text on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("react is great", BASE_SETTINGS);
    expect(result).toBe("react is great");
  });

  it("falls back to raw text when API returns empty content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse("")));

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("react is great", BASE_SETTINGS);
    expect(result).toBe("react is great");
  });

  it("falls back to raw text on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(makeFetchResponse("Corrected.")), 30000)
            )
        )
    );

    const svc = new VoiceCorrectionService();
    const resultPromise = svc.correct("react is great", BASE_SETTINGS);
    vi.advanceTimersByTime(16000);
    const result = await resultPromise;
    expect(result).toBe("react is great");
  });

  it("returns raw text unchanged when input is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("", BASE_SETTINGS);
    expect(result).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes custom dictionary in the system message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Canopy is great."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("canopy is great", {
      ...BASE_SETTINGS,
      customDictionary: ["Canopy", "Worktree"],
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain("Canopy");
    expect(systemMessage).toContain("Worktree");
  });

  it("includes project name in the system message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("test sentence", {
      ...BASE_SETTINGS,
      projectName: "my-project",
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain("my-project");
  });

  it("includes custom instructions in the system message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("test sentence", {
      ...BASE_SETTINGS,
      customInstructions: "Always capitalize ProductName.",
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain("Always capitalize ProductName.");
  });

  it("maintains a sliding history window of 3 paragraphs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected sentence."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();

    await svc.correct("sentence one", BASE_SETTINGS);
    await svc.correct("sentence two", BASE_SETTINGS);
    await svc.correct("sentence three", BASE_SETTINGS);
    await svc.correct("sentence four", BASE_SETTINGS);

    // The 4th call should have history with sentences 2-4 (window of 3, so sentence 1 dropped)
    const lastBody = JSON.parse(
      (fetchMock.mock.calls[3] as [string, RequestInit])[1].body as string
    );
    const userMessage = lastBody.messages[1].content as string;
    expect(userMessage).not.toContain("sentence one");
    expect(userMessage).toContain("Corrected sentence.");
  });

  it("resets history on resetHistory()", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("sentence one", BASE_SETTINGS);
    svc.resetHistory();
    await svc.correct("sentence two", BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).not.toContain("sentence one");
  });

  it("formats current input with <input> XML tags", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("test input text", BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toContain("<input>");
    expect(userMessage).toContain("test input text");
    expect(userMessage).toContain("</input>");
  });

  it("formats history with <history> XML tags when history is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("sentence one", BASE_SETTINGS);
    await svc.correct("sentence two", BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toContain("<history>");
    expect(userMessage).toContain("</history>");
    expect(userMessage).toContain("Corrected.");
  });

  it("omits <history> section on first call when no history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("first input", BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).not.toContain("<history>");
    expect(userMessage).toContain("<input>");
  });

  it("always includes guardrail suffix in the system prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("test", BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain("plain text only");
    expect(systemMessage).toContain("Begin immediately");
  });

  it("includes core prompt in the system message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("test", BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain("speech-to-text correction engine");
  });

  it("uses reasoning model parameters for gpt-5-nano with low effort", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("test", BASE_SETTINGS);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].role).toBe("developer");
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it("uses reasoning model parameters for gpt-5-mini with medium effort", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse("Corrected."));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new VoiceCorrectionService();
    await svc.correct("test", { ...BASE_SETTINGS, model: "gpt-5-mini" });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].role).toBe("developer");
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning_effort).toBe("medium");
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it("falls back to raw text when API returns whitespace-only content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse("   \n  ")));

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("react is great", BASE_SETTINGS);
    expect(result).toBe("react is great");
  });

  it("falls back to raw text when API response has no choices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [] }),
      } as unknown as Response)
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("react is great", BASE_SETTINGS);
    expect(result).toBe("react is great");
  });

  it("falls back to raw text when API response has null message content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: null } }] }),
      } as unknown as Response)
    );

    const svc = new VoiceCorrectionService();
    const result = await svc.correct("react is great", BASE_SETTINGS);
    expect(result).toBe("react is great");
  });
});
