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

  it("returns top candidate on AI rerank API error", async () => {
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

    expect(result).toBe("src/components/Bar.tsx");
  });

  it("handles searchNaturalLanguage throwing", async () => {
    searchNaturalLanguageMock.mockRejectedValue(new Error("disk error"));

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve(BASE_PAYLOAD);

    expect(result).toBeNull();
  });
});
