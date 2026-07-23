import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchNaturalLanguageMock = vi.hoisted(() =>
  vi.fn<(payload: { cwd: string; description: string; limit?: number }) => Promise<string[]>>()
);

vi.mock("../FileSearchService.js", () => ({
  fileSearchService: {
    searchNaturalLanguage: searchNaturalLanguageMock,
  },
}));

import { VoiceFileLinkResolver } from "../VoiceFileLinkResolver.js";

const BASE_PAYLOAD = {
  cwd: "/project",
  description: "hybrid input bar",
  apiKey: "sk-test",
};

describe("VoiceFileLinkResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns top candidate when pre-filter score is high", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/HybridInputBar.tsx",
      "src/components/Input.tsx",
    ]);

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve(BASE_PAYLOAD);

    expect(result).toBe("src/components/HybridInputBar.tsx");
  });

  it("returns null when no candidates found", async () => {
    searchNaturalLanguageMock.mockResolvedValue([]);

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve(BASE_PAYLOAD);

    expect(result).toBeNull();
  });

  it("returns null for empty cwd", async () => {
    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({ ...BASE_PAYLOAD, cwd: "" });

    expect(result).toBeNull();
    expect(searchNaturalLanguageMock).not.toHaveBeenCalled();
  });

  it("returns null for empty description", async () => {
    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({ ...BASE_PAYLOAD, description: "  " });

    expect(result).toBeNull();
    expect(searchNaturalLanguageMock).not.toHaveBeenCalled();
  });

  it("falls back to AI rerank when pre-filter score is ambiguous", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ matched_file: "src/components/Input.tsx" }),
        }),
      } as unknown as Response)
    );

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
    });

    expect(result).toBe("src/components/Input.tsx");
  });

  it("returns null on AI rerank API error (does not bypass confidence gate)", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response)
    );

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
    });

    expect(result).toBeNull();
  });

  it("returns null when AI rerank fetch rejects (network error)", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
    });

    expect(result).toBeNull();
  });

  it("returns null when AI rerank returns OK but no text content", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as unknown as Response)
    );

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
    });

    expect(result).toBeNull();
  });

  it("returns null when AI rerank picks a path not in candidates", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ matched_file: "src/invented/Fake.tsx" }),
        }),
      } as unknown as Response)
    );

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
    });

    expect(result).toBeNull();
  });

  it("sends the shared voice model and explicit none reasoning in the rerank body", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({ matched_file: "src/components/Input.tsx" }),
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const resolver = new VoiceFileLinkResolver();
    await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.prompt_cache_key).toBe("voice-file-rerank-v1");
    // Rerank shares the single voice model and pinned low-latency effort so it
    // can't silently inherit gpt-5.6-luna's "medium" default (issue #11365).
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("handles searchNaturalLanguage throwing", async () => {
    searchNaturalLanguageMock.mockRejectedValue(new Error("disk error"));

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve(BASE_PAYLOAD);

    expect(result).toBeNull();
  });

  it("does not high-confidence-match short tokens against longer words", async () => {
    // Before the >=3 length gate, "us ef" prefix-matched both "use" and "effect"
    // in useEffect.tsx → score 1.0, returned directly. After the gate, neither
    // 2-char token matches → falls through to AI rerank.
    searchNaturalLanguageMock.mockResolvedValue(["src/useEffect.tsx"]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ matched_file: null }) }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const resolver = new VoiceFileLinkResolver();
    await resolver.resolve({ ...BASE_PAYLOAD, description: "us ef" });

    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns null silently on abort during AI rerank", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")));

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
      signal: new AbortController().signal,
    });

    expect(result).toBeNull();
  });
});
