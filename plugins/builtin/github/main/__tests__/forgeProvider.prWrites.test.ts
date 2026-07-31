import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";

const mockGraphQLClient = vi.fn();

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => "test-token"),
    createClient: vi.fn(() => mockGraphQLClient),
  },
  GITHUB_API_TIMEOUT_MS: 5000,
}));

vi.mock("../GitHubStats.js", () => ({
  fetchActivityProbe: vi.fn(),
}));

vi.mock("../GitHubRateLimitService.js", () => ({
  gitHubRateLimitService: {
    updateFromGraphQL: vi.fn(),
    getState: vi.fn(() => ({ blocked: false })),
    shouldBlockRequest: () => ({ blocked: false, reason: null }),
  },
}));

vi.mock("../GitHubErrors.js", () => ({
  parseGitHubError: (e: unknown) => formatErrorMessage(e, "unknown error"),
}));

import { githubForgeProvider } from "../forgeProvider.js";
import { clearGitHubCaches, forgePRListCache } from "../GitHubCaches.js";
import { GitHubAuth } from "../GitHubAuth.js";
import type { PR, RepoRef } from "../../../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

// REST PR payload shared by create/edit success cases. GitHub REST shapes diverge
// from the GraphQL projection (`body`/`draft`/`merged`/nested `base.ref`).
const restPR = {
  number: 42,
  title: "Add dark mode",
  body: "Body text",
  state: "open",
  draft: false,
  merged: false,
  html_url: "https://github.com/owner/repo/pull/42",
  user: { login: "octocat", avatar_url: "https://avatars/u" },
  base: { ref: "main" },
  head: { ref: "feature" },
  mergeable: true,
  created_at: "2025-01-02T03:04:05Z",
  updated_at: "2025-01-02T03:04:05Z",
  closed_at: null,
  merged_at: null,
};

function mockFetch(response: { ok: boolean; status: number; body?: unknown; text?: string }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: vi.fn().mockResolvedValue(response.body ?? {}),
    text: vi.fn().mockResolvedValue(response.text ?? ""),
  });
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  return fetchMock;
}

beforeEach(() => {
  clearGitHubCaches();
  vi.mocked(GitHubAuth.getToken).mockReturnValue("test-token");
  mockGraphQLClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPR", () => {
  it("POSTs to the pulls endpoint with head/base/title and bearer auth", async () => {
    const fetchMock = mockFetch({ ok: true, status: 201, body: restPR });

    await githubForgeProvider.createPR(repo, {
      head: "feature",
      base: "main",
      title: "Add dark mode",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(JSON.parse(init.body as string)).toEqual({
      head: "feature",
      base: "main",
      title: "Add dark mode",
    });
  });

  it("includes body and draft only when provided", async () => {
    const fetchMock = mockFetch({ ok: true, status: 201, body: restPR });

    await githubForgeProvider.createPR(repo, {
      head: "feature",
      base: "main",
      title: "T",
      body: "Explanation",
      draft: true,
    });

    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      head: "feature",
      base: "main",
      title: "T",
      body: "Explanation",
      draft: true,
    });
  });

  it("normalizes the REST PR response (REST field names → contract PR)", async () => {
    mockFetch({ ok: true, status: 201, body: restPR });

    const pr = await githubForgeProvider.createPR(repo, {
      head: "feature",
      base: "main",
      title: "x",
    });

    expect(pr).toMatchObject({
      number: 42,
      title: "Add dark mode",
      body: "Body text",
      state: "open",
      isDraft: false,
      merged: false,
      url: "https://github.com/owner/repo/pull/42",
      baseRef: "main",
      headRef: "feature",
      mergeable: true,
    });
  });

  it("invalidates the PR list cache after a successful create", async () => {
    mockFetch({ ok: true, status: 201, body: restPR });
    // Seed a stale list so a missing invalidation would surface it on the next
    // listPRs. A successful create must drop it (lesson #9061).
    forgePRListCache.set("owner/repo:open", {
      items: [],
      nextCursor: null,
      hasMore: false,
    } as unknown as import("../../../../../shared/types/forge.js").Page<PR>);
    expect(forgePRListCache.size()).toBeGreaterThan(0);

    await githubForgeProvider.createPR(repo, { head: "feature", base: "main", title: "x" });

    expect(forgePRListCache.size()).toBe(0);
  });

  it("requires head, base and title", async () => {
    mockFetch({ ok: true, status: 201, body: restPR });
    await expect(
      githubForgeProvider.createPR(repo, { head: "", base: "main", title: "x" })
    ).rejects.toThrow(/head branch is required/i);
    await expect(
      githubForgeProvider.createPR(repo, { head: "f", base: " ", title: "x" })
    ).rejects.toThrow(/base branch is required/i);
    await expect(
      githubForgeProvider.createPR(repo, { head: "f", base: "main", title: "  " })
    ).rejects.toThrow(/title is required/i);
  });

  it("throws when no token is configured", async () => {
    vi.mocked(GitHubAuth.getToken).mockReturnValue("");
    await expect(
      githubForgeProvider.createPR(repo, { head: "f", base: "main", title: "x" })
    ).rejects.toThrow(/token not configured/i);
  });

  it("surfaces the GitHub error body on failure (e.g. 422)", async () => {
    mockFetch({ ok: false, status: 422, text: "A pull request already exists" });
    await expect(
      githubForgeProvider.createPR(repo, { head: "f", base: "main", title: "x" })
    ).rejects.toThrow(/HTTP 422 — A pull request already exists/);
  });
});

describe("closePR / reopenPR", () => {
  it("closePR PATCHes state=closed", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: restPR });
    await githubForgeProvider.closePR(repo, 42);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/42");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ state: "closed" });
  });

  it("closePR returns the updated PR normalized from the response (#11546)", async () => {
    mockFetch({ ok: true, status: 200, body: { ...restPR, state: "closed", closed_at: "2025-02-03T04:05:06Z" } });

    const pr = await githubForgeProvider.closePR(repo, 42);

    // Assert on fields the request never carried: a synthesized result built
    // from {repo, prNumber, "closed"} could satisfy state/number/url alone.
    expect(pr.state).toBe("closed");
    expect(pr.title).toBe(restPR.title);
    expect(pr.headRef).toBe(restPR.head.ref);
    expect(pr.baseRef).toBe(restPR.base.ref);
  });

  it("reopenPR returns the updated PR", async () => {
    mockFetch({ ok: true, status: 200, body: { ...restPR, state: "open" } });

    const pr = await githubForgeProvider.reopenPR(repo, 42);

    expect(pr.state).toBe("open");
    expect(pr.number).toBe(restPR.number);
  });

  it("rejects a 2xx close whose body carries no PR number", async () => {
    mockFetch({ ok: true, status: 200, body: { html_url: "https://example.test" } });

    await expect(githubForgeProvider.closePR(repo, 42)).rejects.toThrow(
      /missing PR number or URL/i
    );
  });

  it("still drops the PR caches when the response body can't even be read", async () => {
    // The PATCH landed even though the body is unreadable — a cache left intact
    // would keep serving the pre-close state. A rejecting json() (not merely a
    // wrong-shaped one) is what pins the invalidation ahead of the parse: any
    // ordering that reads the body first would leave the cache populated.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
      text: vi.fn().mockResolvedValue(""),
    });
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    forgePRListCache.set("owner/repo:open", {
      items: [],
      nextCursor: null,
      hasMore: false,
    } as unknown as import("../../../../../shared/types/forge.js").Page<PR>);
    expect(forgePRListCache.size()).toBeGreaterThan(0);

    await expect(githubForgeProvider.closePR(repo, 42)).rejects.toThrow();

    expect(forgePRListCache.size()).toBe(0);
  });

  it("rejects a top-level array body instead of reading every field as undefined", async () => {
    mockFetch({ ok: true, status: 200, body: [] });

    await expect(githubForgeProvider.closePR(repo, 42)).rejects.toThrow(
      /missing pull request payload/i
    );
  });

  it("reopenPR PATCHes state=open", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: restPR });
    await githubForgeProvider.reopenPR(repo, 42);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      state: "open",
    });
  });

  it("closePR surfaces a close-specific error message", async () => {
    mockFetch({ ok: false, status: 500, text: "boom" });
    await expect(githubForgeProvider.closePR(repo, 42)).rejects.toThrow(
      /Failed to close pull request #42/
    );
  });
});

describe("mergePR", () => {
  // GitHub's merge endpoint answers with exactly this and nothing else — no
  // resulting PR state.
  const mergedBody = {
    sha: "9fceb02aabbccddee",
    merged: true,
    message: "Pull Request successfully merged",
  };

  it("returns the merge acknowledgement from a single request (#11546)", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: mergedBody });

    const result = await githubForgeProvider.mergePR(repo, 42);

    expect(result).toEqual({
      prNumber: 42,
      sha: mergedBody.sha,
      merged: true,
      message: mergedBody.message,
    });
    // No follow-up GET for the resulting PR: the merge has already landed, so a
    // failing second read would report a completed merge as a failure. Both
    // transports are pinned — a GraphQL enrichment would be just as wrong.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGraphQLClient).not.toHaveBeenCalled();
  });

  it("reports sha as null when the forge omits one", async () => {
    mockFetch({ ok: true, status: 200, body: { merged: true, message: "Merged" } });

    const result = await githubForgeProvider.mergePR(repo, 42);

    expect(result.sha).toBeNull();
    expect(result.merged).toBe(true);
  });

  it("honours an explicit merged:false rather than inventing success", async () => {
    mockFetch({ ok: true, status: 200, body: { sha: null, merged: false, message: "Not merged" } });

    const result = await githubForgeProvider.mergePR(repo, 42);

    expect(result.merged).toBe(false);
  });

  it.each([[null], ["false"], [0]])(
    "treats a non-boolean merged flag (%p) as merged, trusting the 2xx status",
    async (merged) => {
      // Only an explicit boolean false denies the merge. A malformed flag must
      // not silently downgrade a merge the status code says landed.
      mockFetch({ ok: true, status: 200, body: { sha: "abc123", merged } });

      expect((await githubForgeProvider.mergePR(repo, 42)).merged).toBe(true);
    }
  );

  it("still reports merged when a 2xx body omits the flag", async () => {
    // GitHub answers 405 for unmergeable and 409 for a stale head, so reaching
    // here at all means the merge landed — reporting `merged: false` would send
    // an agent back to retry a merge that already happened.
    mockFetch({ ok: true, status: 200, body: { sha: "abc123" } });

    const result = await githubForgeProvider.mergePR(repo, 42);

    expect(result.merged).toBe(true);
  });

  it("PUTs to the merge endpoint with the chosen strategy", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: mergedBody });
    await githubForgeProvider.mergePR(repo, 42, { mergeMethod: "squash" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/42/merge");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ merge_method: "squash" });
  });

  it("forwards commit title/message as snake_case fields", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: mergedBody });
    await githubForgeProvider.mergePR(repo, 42, {
      mergeMethod: "merge",
      commitTitle: "Custom title",
      commitMessage: "Custom message",
    });
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      merge_method: "merge",
      commit_title: "Custom title",
      commit_message: "Custom message",
    });
  });

  it("classifies HTTP 405 as not-mergeable", async () => {
    mockFetch({ ok: false, status: 405, text: "Pull Request is not mergeable" });
    await expect(githubForgeProvider.mergePR(repo, 42)).rejects.toThrow(/not mergeable/i);
  });

  it("classifies HTTP 409 as a head-branch race", async () => {
    mockFetch({ ok: false, status: 409, text: "Head branch was modified" });
    await expect(githubForgeProvider.mergePR(repo, 42)).rejects.toThrow(/head branch changed/i);
  });

  it("falls back to a generic message for other statuses", async () => {
    mockFetch({ ok: false, status: 500, text: "server error" });
    await expect(githubForgeProvider.mergePR(repo, 42)).rejects.toThrow(/HTTP 500/);
  });
});

describe("convertPRToDraft / markPRReadyForReview (GraphQL)", () => {
  it("convertPRToDraft resolves the node id then runs the GraphQL mutation", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_node_42" } } })
      .mockResolvedValueOnce({
        convertPullRequestToDraft: { pullRequest: { id: "PR_node_42", isDraft: true } },
      });

    await githubForgeProvider.convertPRToDraft(repo, 42);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    // First call resolves the node id; second runs the draft mutation with it.
    const secondVars = mockGraphQLClient.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(secondVars.id).toBe("PR_node_42");
  });

  it("markPRReadyForReview resolves the node id then runs the ready mutation", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_node_7" } } })
      .mockResolvedValueOnce({
        markPullRequestReadyForReview: { pullRequest: { id: "PR_node_7", isDraft: false } },
      });

    await githubForgeProvider.markPRReadyForReview(repo, 7);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    expect((mockGraphQLClient.mock.calls[1]?.[1] as Record<string, unknown>).id).toBe("PR_node_7");
  });

  it("returns the draft state GitHub reported, not the one requested (#11546)", async () => {
    // GitHub is the authority here: if it says the PR is still a draft after a
    // ready-for-review call, the caller must see that, not an assumed `false`.
    mockGraphQLClient
      .mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_node_7" } } })
      .mockResolvedValueOnce({
        markPullRequestReadyForReview: { pullRequest: { id: "PR_node_7", isDraft: true } },
      });

    const result = await githubForgeProvider.markPRReadyForReview(repo, 7);

    expect(result).toEqual({ prNumber: 7, isDraft: true });
  });

  it("falls back to the requested state when the ack omits isDraft", async () => {
    // The mutation already succeeded — a thin ack must not fail the write.
    mockGraphQLClient
      .mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_node_42" } } })
      .mockResolvedValueOnce({ convertPullRequestToDraft: { pullRequest: { id: "PR_node_42" } } });

    const result = await githubForgeProvider.convertPRToDraft(repo, 42);

    expect(result).toEqual({ prNumber: 42, isDraft: true });
  });

  it("throws when the PR node id can't be resolved", async () => {
    mockGraphQLClient.mockResolvedValueOnce({ repository: { pullRequest: null } });
    await expect(githubForgeProvider.convertPRToDraft(repo, 999)).rejects.toThrow(/not found/i);
  });

  it("propagates a mutation failure after the node id resolves", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_node_42" } } })
      .mockRejectedValueOnce(new Error("GraphQL: draft not allowed on this plan"));
    await expect(githubForgeProvider.convertPRToDraft(repo, 42)).rejects.toThrow(
      /draft not allowed/i
    );
  });
});

describe("commentOnPR", () => {
  const restComment = {
    id: 55501,
    body: "Looks good",
    html_url: "https://github.com/owner/repo/pull/42#issuecomment-55501",
    user: { login: "octocat", avatar_url: "https://avatars/octocat" },
    created_at: "2025-04-05T06:07:08Z",
  };

  it("returns the created comment normalized from the response (#11546)", async () => {
    mockFetch({ ok: true, status: 201, body: restComment });

    const comment = await githubForgeProvider.commentOnPR(repo, 42, "Looks good");

    expect(comment.id).toBe(String(restComment.id));
    expect(comment.url).toBe(restComment.html_url);
    expect(comment.createdAt).toBe(Date.parse(restComment.created_at));
    expect(comment.author?.login).toBe(restComment.user.login);
  });

  it("rejects a 2xx body missing the comment id or URL", async () => {
    mockFetch({ ok: true, status: 201, body: { body: "Looks good" } });

    await expect(githubForgeProvider.commentOnPR(repo, 42, "Looks good")).rejects.toThrow(
      /missing comment id or URL/i
    );
  });

  it("POSTs to the issues/{n}/comments endpoint with the body", async () => {
    const fetchMock = mockFetch({ ok: true, status: 201, body: restComment });
    await githubForgeProvider.commentOnPR(repo, 42, "Looks good");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues/42/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ body: "Looks good" });
  });

  it("requires a non-empty body", async () => {
    mockFetch({ ok: true, status: 201, body: restComment });
    await expect(githubForgeProvider.commentOnPR(repo, 42, "   ")).rejects.toThrow(
      /body is required/i
    );
  });

  it("posts the body verbatim (does not trim user Markdown)", async () => {
    const fetchMock = mockFetch({ ok: true, status: 201, body: restComment });
    // Leading indentation matters inside fenced code blocks — must survive.
    await githubForgeProvider.commentOnPR(repo, 42, "    npm test\n");
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      body: "    npm test\n",
    });
  });

  it("invalidates the PR list cache after a successful comment", async () => {
    mockFetch({ ok: true, status: 201, body: restComment });
    forgePRListCache.set("owner/repo:open", {
      items: [],
      nextCursor: null,
      hasMore: false,
    } as unknown as import("../../../../../shared/types/forge.js").Page<PR>);
    expect(forgePRListCache.size()).toBeGreaterThan(0);

    await githubForgeProvider.commentOnPR(repo, 42, "Looks good");

    expect(forgePRListCache.size()).toBe(0);
  });
});

describe("editPR", () => {
  it("PATCHes only the provided fields and normalizes the response", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: { ...restPR, title: "New title" } });
    const pr = await githubForgeProvider.editPR(repo, 42, { title: "New title" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/42");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ title: "New title" });
    expect(pr.title).toBe("New title");
  });

  it("rejects an edit with no fields", async () => {
    mockFetch({ ok: true, status: 200, body: restPR });
    await expect(githubForgeProvider.editPR(repo, 42, {})).rejects.toThrow(/title or body/i);
  });

  it("rejects a blank title", async () => {
    mockFetch({ ok: true, status: 200, body: restPR });
    await expect(githubForgeProvider.editPR(repo, 42, { title: "  " })).rejects.toThrow(
      /title cannot be empty/i
    );
  });
});
