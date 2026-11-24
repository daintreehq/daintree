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

  it("rejects on AI rerank API error, so it isn't taken for a miss (does not bypass confidence gate)", async () => {
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
    await expect(
      resolver.resolve({ ...BASE_PAYLOAD, description: "input component" })
    ).rejects.toThrow("AI rerank API error");
  });

  it("rejects when AI rerank fetch rejects (network error)", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const resolver = new VoiceFileLinkResolver();
    await expect(
      resolver.resolve({ ...BASE_PAYLOAD, description: "input component" })
    ).rejects.toThrow("network down");
  });

  it("finds nothing once its caller has aborted the rerank", async () => {
    searchNaturalLanguageMock.mockResolvedValue([
      "src/components/Bar.tsx",
      "src/components/Input.tsx",
    ]);
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      })
    );

    const resolver = new VoiceFileLinkResolver();
    const result = await resolver.resolve({
      ...BASE_PAYLOAD,
      description: "input component",
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });

  it("rejects when AI rerank returns OK but no text content", async () => {
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
    await expect(
      resolver.resolve({ ...BASE_PAYLOAD, description: "input component" })
    ).rejects.toThrow("empty text");
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
    // can't silently inherit gpt-6-luna's "medium" default (issue #11365).
    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.store).toBe(false);
  });

  it("rejects when searchNaturalLanguage throws", async () => {
    searchNaturalLanguageMock.mockRejectedValue(new Error("disk error"));

    const resolver = new VoiceFileLinkResolver();
    await expect(resolver.resolve(BASE_PAYLOAD)).rejects.toThrow("disk error");
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

  describe("same-named files in different directories", () => {
    const TIED = ["app/UserProfile.tsx", "lib/UserProfile.tsx"];
    const rerankReply = (matched: string | null) =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ matched_file: matched }) }),
      } as unknown as Response);
    const pick = (description: string, candidates: string[]) =>
      new VoiceFileLinkResolver().pick({ description, apiKey: "sk-test", candidates });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("does not insert the first of two equally strong matches", async () => {
      searchNaturalLanguageMock.mockResolvedValue(TIED);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const resolver = new VoiceFileLinkResolver();
      const result = await resolver.resolve({ ...BASE_PAYLOAD, description: "user profile" });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sees the tie whichever order the search listed the files in", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["src/Other.tsx", "lib/UserProfile.tsx", "app/UserProfile.tsx"])
      ).resolves.toBeNull();
      await expect(
        pick("user profile", ["app/UserProfile.tsx", "lib/UserProfile.tsx"])
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("takes the file a directory in the description singles out, without asking the reranker", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(pick("app user profile", TIED)).resolves.toBe("app/UserProfile.tsx");
      await expect(pick("user profile in lib", TIED)).resolves.toBe("lib/UserProfile.tsx");
      await expect(pick("lib user profile", [...TIED].reverse())).resolves.toBe(
        "lib/UserProfile.tsx"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sees a tie when the directory words fit both files alike", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("src user profile", ["src/app/UserProfile.tsx", "src/lib/UserProfile.tsx"])
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts a directory word only when it is exactly what was said", async () => {
      // "app" is not "application": both files stay at 2 of 3 tokens, below the
      // confident bar, so the reranker is asked rather than a prefix deciding.
      const fetchMock = rerankReply(null);
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("app user profile", ["application/UserProfile.tsx", "lib/UserProfile.tsx"])
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never selects a file on its directory alone", async () => {
      const fetchMock = rerankReply(null);
      vi.stubGlobal("fetch", fetchMock);

      await expect(pick("user profile", ["user/profile/index.ts"])).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("weighs a name match above a directory match at the same coverage", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(pick("user profile", ["user/Profile.tsx", "src/UserProfile.tsx"])).resolves.toBe(
        "src/UserProfile.tsx"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps preferring a component over its test and stories siblings", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", [
          "src/UserProfile.test.tsx",
          "src/UserProfile.stories.tsx",
          "src/UserProfile.tsx",
        ])
      ).resolves.toBe("src/UserProfile.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("leaves siblings that differ only by extension to the reranker", async () => {
      const fetchMock = rerankReply("src/UserProfile.css");
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["src/UserProfile.tsx", "src/UserProfile.css"])
      ).resolves.toBe("src/UserProfile.css");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("counts the same path listed twice as one match", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["app/UserProfile.tsx", "app/UserProfile.tsx"])
      ).resolves.toBe("app/UserProfile.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("declines a tie the reranker is still asked about, rather than take its pick of the tied files", async () => {
      // "profile page" is a token short of the confident bar, so the reranker
      // sees both files, but it has nothing to tell them apart either.
      const tied = ["app/Profile.tsx", "lib/Profile.tsx"];
      const fetchMock = rerankReply("lib/Profile.tsx");
      vi.stubGlobal("fetch", fetchMock);

      await expect(pick("profile page", tied)).resolves.toBeNull();

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { input: string };
      expect(body.input).toContain("app/Profile.tsx");
      expect(body.input).toContain("lib/Profile.tsx");
    });

    it("takes a rerank pick among differently named files that merely score alike", async () => {
      // One token, so nothing is auto-picked; both names start with it.
      vi.stubGlobal("fetch", rerankReply("src/UserProfile.tsx"));

      await expect(
        pick("userprofile", ["src/UserProvider.tsx", "src/UserProfile.tsx"])
      ).resolves.toBe("src/UserProfile.tsx");
    });

    it("leaves an exact multi-dot name to the reranker, not a tie of its reordered twin", async () => {
      const fetchMock = rerankReply("docs/report.final.pdf");
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("report.final.pdf", ["docs/final.report.pdf", "docs/report.final.pdf"])
      ).resolves.toBe("docs/report.final.pdf");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("takes a rerank pick the description names among files that share a stem", async () => {
      vi.stubGlobal("fetch", rerankReply(".env.local"));

      await expect(pick("env local", [".env.production", ".env.local"])).resolves.toBe(
        ".env.local"
      );
    });

    it("declines a rerank pick whose same-named twin fits as well, even below a stronger match", async () => {
      // ProfileView.test.tsx fits best (2 of 3 tokens) but the reranker passed it over.
      const fetchMock = rerankReply("app/Profile.tsx");
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("profile view implementation", [
          "src/ProfileView.test.tsx",
          "app/Profile.tsx",
          "lib/Profile.tsx",
        ])
      ).resolves.toBeNull();
    });

    it("declines a rerank pick that the description fits worse than its same-named twin", async () => {
      vi.stubGlobal("fetch", rerankReply("app/Profile.tsx"));

      await expect(
        pick("profile page lib", ["app/Profile.tsx", "lib/Profile.tsx"])
      ).resolves.toBeNull();
    });

    it("sees same-named files that differ only by case", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["app/UserProfile.tsx", "lib/features/userProfile.tsx"])
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not count a dropped word like "of" as unsaid, so the fuller name isn\'t beaten for it', async () => {
      const fetchMock = rerankReply("src/TermsOfService.tsx");
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("terms of service component", [
          "src/services/TermsService.ts",
          "src/TermsOfService.tsx",
        ])
      ).resolves.toBe("src/TermsOfService.tsx");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("takes a rerank pick whose same-named twin fits the description worse", async () => {
      vi.stubGlobal("fetch", rerankReply("lib/Profile.tsx"));

      await expect(pick("profile page lib", ["app/Profile.tsx", "lib/Profile.tsx"])).resolves.toBe(
        "lib/Profile.tsx"
      );
    });

    it("takes a spoken extension as the file type, not a folder called the same", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile settings tsx", [
          "packages/tsx/UserProfileSettings.ts",
          "src/UserProfileSettings.tsx",
        ])
      ).resolves.toBe("src/UserProfileSettings.tsx");
      await expect(
        pick("user profile settings tsx", [
          "server/features/UserProfileSettings.ts",
          "ui/UserProfileSettingsPage.tsx",
        ])
      ).resolves.toBe("ui/UserProfileSettingsPage.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still reads a directory name that no candidate has as an extension", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile css", ["src/UserProfile.tsx", "packages/css/UserProfile.tsx"])
      ).resolves.toBe("packages/css/UserProfile.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still takes a rerank pick from outside the tied files", async () => {
      vi.stubGlobal("fetch", rerankReply("src/pages/Settings.tsx"));

      await expect(
        pick("profile page", ["app/Profile.tsx", "lib/Profile.tsx", "src/pages/Settings.tsx"])
      ).resolves.toBe("src/pages/Settings.tsx");
    });

    it("leaves a tie among differently named files to the reranker", async () => {
      const fetchMock = rerankReply("lib/UserProfileView.tsx");
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", [
          "app/UserProfileCard.tsx",
          "src/Profile.tsx",
          "lib/UserProfileView.tsx",
        ])
      ).resolves.toBe("lib/UserProfileView.tsx");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sees the tie when a repeated path comes first", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["app/UserProfile.tsx", "app/UserProfile.tsx", "lib/UserProfile.tsx"])
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reads a directory named in a longer description, at any depth", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("the user profile in lib folder", [
          "src/app/UserProfile.tsx",
          "src/lib/UserProfile.tsx",
        ])
      ).resolves.toBe("src/lib/UserProfile.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts a word once when the name and a directory both carry it", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["user/UserProfile.tsx", "lib/UserProfile.tsx"])
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not credit a longer spoken word for a shorter directory name", async () => {
      const fetchMock = rerankReply(null);
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("application user profile", ["app/UserProfile.tsx", "lib/UserProfile.tsx"])
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("takes a file on one name word and the directory said beside it", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(pick("app profile", ["lib/Profile.tsx", "app/Profile.tsx"])).resolves.toBe(
        "app/Profile.tsx"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lets a fuller cover outrank a fuller name", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("app settings user profile", [
          "lib/UserProfileSettings.tsx",
          "app/settings/UserProfile.tsx",
        ])
      ).resolves.toBe("app/settings/UserProfile.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lets more name words outrank fewer unsaid ones", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["user/Profile.tsx", "src/UserProfile.test.tsx"])
      ).resolves.toBe("src/UserProfile.test.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("prefers a name that is what was said over one that only starts with it", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        pick("user profile", ["src/UserProfiler.tsx", "src/UserProfile.tsx"])
      ).resolves.toBe("src/UserProfile.tsx");
      await expect(
        pick("auth flow", ["src/AuthenticationAuthorizationFlow.tsx", "src/AuthFlowForm.tsx"])
      ).resolves.toBe("src/AuthFlowForm.tsx");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("choosing among candidates a search elsewhere found", () => {
    const { cwd: _cwd, ...request } = BASE_PAYLOAD;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("takes a confident match without searching here or asking the reranker", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const resolver = new VoiceFileLinkResolver();
      const result = await resolver.pick({
        ...request,
        candidates: ["src/components/HybridInputBar.tsx", "src/components/Input.tsx"],
      });

      expect(result).toBe("src/components/HybridInputBar.tsx");
      expect(searchNaturalLanguageMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("asks the reranker to choose only among the candidates given", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ matched_file: "src/components/Input.tsx" }),
        }),
      } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const resolver = new VoiceFileLinkResolver();
      const result = await resolver.pick({
        ...request,
        description: "input component",
        candidates: ["src/components/Bar.tsx", "src/components/Input.tsx"],
      });

      expect(result).toBe("src/components/Input.tsx");
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { input: string };
      expect(body.input).toContain("src/components/Bar.tsx");
      expect(searchNaturalLanguageMock).not.toHaveBeenCalled();
    });

    it("finds nothing among no candidates", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const resolver = new VoiceFileLinkResolver();
      await expect(resolver.pick({ ...request, candidates: [] })).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    const AMBIGUOUS = {
      ...request,
      description: "input component",
      candidates: ["src/components/Bar.tsx", "src/components/Input.tsx"],
    };

    it("finds nothing once its caller has aborted the rerank", async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        })
      );

      const resolver = new VoiceFileLinkResolver();
      await expect(resolver.pick({ ...AMBIGUOUS, signal: controller.signal })).resolves.toBeNull();
    });

    it("rejects when the rerank runs out its own time, though its caller still waits", async () => {
      const caller = new AbortController();
      const rerankClock = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(rerankClock.signal);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
                once: true,
              });
            })
        )
      );

      const resolver = new VoiceFileLinkResolver();
      const picking = resolver.pick({ ...AMBIGUOUS, signal: caller.signal });
      rerankClock.abort(new DOMException("timed out", "TimeoutError"));

      await expect(picking).rejects.toThrow("timed out");
      expect(caller.signal.aborted).toBe(false);
    });

    it("rejects on a rerank reply that isn't the JSON it asked for", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ output_text: "not json" }),
        } as unknown as Response)
      );

      const resolver = new VoiceFileLinkResolver();
      await expect(resolver.pick(AMBIGUOUS)).rejects.toThrow(SyntaxError);
    });
  });
});
