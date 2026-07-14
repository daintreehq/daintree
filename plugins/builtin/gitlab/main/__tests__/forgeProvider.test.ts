import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RepoRef } from "../../../../../shared/types/forge.js";
import { gitlabForgeProvider } from "../forgeProvider.js";
import { resetAuthStateForTests, setInstanceUrlReader } from "../GitLabAuth.js";
import { resetLastRateLimitInfo } from "../GitLabClient.js";
import { clearGitLabCaches } from "../readOps.js";

const REPO: RepoRef = { host: "gitlab.com", owner: "group", repo: "project", rawData: null };
const SELF_HOSTED_REPO: RepoRef = {
  host: "gitlab.internal.example",
  owner: "team",
  repo: "app",
  rawData: null,
};

function jsonResponse(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

function requestUrl(call: unknown[]): string {
  return String(call[0]);
}

function requestHeaders(call: unknown[]): Record<string, string> {
  return ((call[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
}

function requestBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? "{}")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  resetAuthStateForTests();
  clearGitLabCaches();
  resetLastRateLimitInfo();
});

afterEach(() => {
  setInstanceUrlReader(null);
  vi.unstubAllGlobals();
});

describe("token attachment", () => {
  it("attaches the token to the configured instance host only", async () => {
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-secret" });
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBe("Bearer glpat-secret");

    await gitlabForgeProvider.listIssues(SELF_HOSTED_REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[1]).Authorization).toBeUndefined();
  });

  it("follows the instanceUrl setting for self-hosted tokens", async () => {
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.internal.example"));
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-internal" });
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(SELF_HOSTED_REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBe("Bearer glpat-internal");

    await gitlabForgeProvider.listIssues(REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[1]).Authorization).toBeUndefined();
  });
});

describe("parseRemote", () => {
  it("parses any GitLab-shaped host, deriving identity from the URL", () => {
    const ref = gitlabForgeProvider.parseRemote("git@gitlab.internal.example:team/sub/app.git");
    expect(ref).toMatchObject({ host: "gitlab.internal.example", owner: "team/sub", repo: "app" });
  });

  it("returns null for unparsable remotes", () => {
    expect(gitlabForgeProvider.parseRemote("not-a-remote")).toBeNull();
  });
});

describe("listPRs", () => {
  it("maps GitLab offset pagination onto the cursor contract", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse([{ iid: 1, title: "One", state: "opened" }], {
        headers: { "x-next-page": "2", "x-total": "55" },
      })
    );

    const page = await gitlabForgeProvider.listPRs(REPO, { state: "open", perPage: 20 });

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toContain("/api/v4/projects/group%2Fproject/merge_requests");
    expect(url).toContain("state=opened");
    expect(url).toContain("per_page=20");
    expect(page.items[0].number).toBe(1);
    expect(page.nextCursor).toBe("2");
    expect(page.hasMore).toBe(true);
    expect(page.totalCount).toBe(55);
  });

  it("requests the cursor's page number", async () => {
    fetchMock().mockResolvedValue(jsonResponse([]));
    await gitlabForgeProvider.listPRs(REPO, { cursor: "3" });
    expect(requestUrl(fetchMock().mock.calls[0])).toContain("page=3");
  });
});

describe("getIssue", () => {
  it("returns null on 404", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "404 Not Found" }, { status: 404 }));
    await expect(gitlabForgeProvider.getIssue(REPO, 999)).resolves.toBeNull();
  });

  it("propagates non-404 failures", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "boom" }, { status: 500 }));
    await expect(gitlabForgeProvider.getIssue(REPO, 1)).rejects.toThrow("boom");
  });
});

describe("findPRByBranch", () => {
  it("queries by source branch, newest first, any state", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse([{ iid: 8, title: "MR", state: "merged", source_branch: "feature/x" }])
    );

    const pr = await gitlabForgeProvider.findPRByBranch(REPO, "feature/x");

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toContain("source_branch=feature%2Fx");
    expect(url).toContain("order_by=created_at");
    expect(url).not.toContain("state=");
    expect(pr?.number).toBe(8);
    expect(pr?.state).toBe("merged");
  });

  it("returns null when no MR matches", async () => {
    fetchMock().mockResolvedValue(jsonResponse([]));
    await expect(gitlabForgeProvider.findPRByBranch(REPO, "feature/none")).resolves.toBeNull();
  });
});

describe("findPRsByBranches", () => {
  it("confirms absent branches as null and picks the newest MR per branch", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        data: {
          project: {
            mergeRequests: {
              nodes: [
                {
                  iid: "12",
                  title: "Newest",
                  state: "opened",
                  sourceBranch: "feature/a",
                  targetBranch: "main",
                  webUrl: "https://gitlab.com/group/project/-/merge_requests/12",
                  createdAt: "2026-07-02T00:00:00Z",
                  updatedAt: "2026-07-02T00:00:00Z",
                },
                {
                  iid: "5",
                  title: "Older",
                  state: "closed",
                  sourceBranch: "feature/a",
                  targetBranch: "main",
                  webUrl: "https://gitlab.com/group/project/-/merge_requests/5",
                  createdAt: "2026-06-01T00:00:00Z",
                  updatedAt: "2026-06-01T00:00:00Z",
                },
              ],
            },
          },
        },
      })
    );

    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a", "feature/b"]);

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toBe("https://gitlab.com/api/graphql");
    expect(result?.get("feature/a")?.number).toBe(12);
    expect(result?.has("feature/b")).toBe(true);
    expect(result?.get("feature/b")).toBeNull();
  });

  it("omits branches when the query fails so the host falls back", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "unauthorized" }, { status: 401 }));
    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a"]);
    expect(result?.size).toBe(0);
  });

  it("omits branches when the project is inaccessible (null project)", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ data: { project: null } }));
    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a"]);
    expect(result?.size).toBe(0);
  });

  it("omits unmatched branches when the result window truncated", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        data: {
          project: {
            mergeRequests: {
              pageInfo: { hasNextPage: true },
              nodes: [
                {
                  iid: "12",
                  title: "Found",
                  state: "opened",
                  sourceBranch: "feature/a",
                  targetBranch: "main",
                  webUrl: "https://gitlab.com/group/project/-/merge_requests/12",
                  createdAt: "2026-07-02T00:00:00Z",
                  updatedAt: "2026-07-02T00:00:00Z",
                },
              ],
            },
          },
        },
      })
    );

    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a", "feature/b"]);

    // feature/a resolved inside the window; feature/b's newest MR may lie
    // beyond it, so it must be OMITTED (fallback), not confirmed absent.
    expect(result?.get("feature/a")?.number).toBe(12);
    expect(result?.has("feature/b")).toBe(false);
  });
});

describe("getCIStatus", () => {
  it("projects the head pipeline status", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ iid: 3, state: "opened", head_pipeline: { status: "running" } })
    );
    const status = await gitlabForgeProvider.getCIStatus(REPO, 3);
    expect(status?.state).toBe("pending");
    expect(status?.pending).toBe(1);
  });

  it("returns null when the MR has no pipeline", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 3, state: "opened", head_pipeline: null }));
    await expect(gitlabForgeProvider.getCIStatus(REPO, 3)).resolves.toBeNull();
  });
});

describe("mutations", () => {
  it("creates an MR with a Draft: prefix for draft input", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ iid: 20, title: "Draft: New", state: "opened", draft: true })
    );
    const pr = await gitlabForgeProvider.createPR(REPO, {
      head: "feature/x",
      base: "main",
      title: "New",
      draft: true,
    });
    const body = requestBody(fetchMock().mock.calls[0]);
    expect(body.title).toBe("Draft: New");
    expect(body.source_branch).toBe("feature/x");
    expect(pr.isDraft).toBe(true);
  });

  it("rejects rebase merges as unsupported", async () => {
    await expect(gitlabForgeProvider.mergePR(REPO, 5, { mergeMethod: "rebase" })).rejects.toThrow(
      "Not supported"
    );
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("passes squash and the squash commit message on squash merges", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 5, state: "merged" }));
    await gitlabForgeProvider.mergePR(REPO, 5, {
      mergeMethod: "squash",
      commitTitle: "feat: squashed",
    });
    const body = requestBody(fetchMock().mock.calls[0]);
    expect(body.squash).toBe(true);
    expect(body.squash_commit_message).toBe("feat: squashed");
  });

  it("translates unmergeable 405s into an actionable error", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "Method Not Allowed" }, { status: 405 }));
    await expect(gitlabForgeProvider.mergePR(REPO, 5)).rejects.toThrow(
      /draft, have conflicts, or failing pipelines/
    );
  });

  it("converts to draft by prefixing the title", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Feature", state: "opened" }))
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Draft: Feature", state: "opened" }));
    await gitlabForgeProvider.convertPRToDraft(REPO, 6);
    const body = requestBody(fetchMock().mock.calls[1]);
    expect(body.title).toBe("Draft: Feature");
  });

  it("skips the write when the MR is already a draft", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ iid: 6, title: "Draft: Feature", state: "opened", draft: true })
    );
    await gitlabForgeProvider.convertPRToDraft(REPO, 6);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("marks ready for review by stripping draft prefixes", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ iid: 6, title: "Draft: WIP: Feature", state: "opened", draft: true })
      )
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Feature", state: "opened" }));
    await gitlabForgeProvider.markPRReadyForReview(REPO, 6);
    const body = requestBody(fetchMock().mock.calls[1]);
    expect(body.title).toBe("Feature");
  });

  it("closes issues via state_event", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 9, state: "closed" }));
    const issue = await gitlabForgeProvider.closeIssue(REPO, 9, "completed");
    expect(requestBody(fetchMock().mock.calls[0]).state_event).toBe("close");
    expect(issue.state).toBe("closed");
  });

  it("refuses to remove a label that is not on the issue", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ iid: 9, state: "opened", labels: ["bug"] }));
    await expect(gitlabForgeProvider.removeIssueLabel(REPO, 9, "ux")).rejects.toThrow(
      'Label "ux" is not on issue #9'
    );
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("assigns additively via resolved user ids", async () => {
    fetchMock().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/users?")) {
        return jsonResponse([{ id: 77, username: "fixer" }]);
      }
      if (url.endsWith("/issues/9") && !url.includes("?")) {
        return jsonResponse({
          iid: 9,
          state: "opened",
          assignees: [{ id: 3, username: "existing" }],
        });
      }
      return jsonResponse({ iid: 9, state: "opened" });
    });

    await gitlabForgeProvider.assignIssue(REPO, 9, "fixer");

    const putCall = fetchMock().mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT"
    );
    expect(putCall).toBeDefined();
    // New user first: GitLab Free applies only the first id, so leading with
    // the requested user replaces instead of silently no-oping.
    expect(requestBody(putCall as unknown[]).assignee_ids).toEqual([77, 3]);
  });

  it("pins squash false on an explicit merge method", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 5, state: "merged" }));
    await gitlabForgeProvider.mergePR(REPO, 5, { mergeMethod: "merge" });
    expect(requestBody(fetchMock().mock.calls[0]).squash).toBe(false);
  });

  it("preserves the draft prefix when editing a draft MR's title", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ iid: 6, title: "Draft: Old", state: "opened", draft: true })
      )
      .mockResolvedValueOnce(
        jsonResponse({ iid: 6, title: "Draft: New title", state: "opened", draft: true })
      );
    const pr = await gitlabForgeProvider.editPR(REPO, 6, { title: "New title" });
    const body = requestBody(fetchMock().mock.calls[1]);
    expect(body.title).toBe("Draft: New title");
    expect(pr.isDraft).toBe(true);
  });

  it("builds the issue-comment URL without a second issue fetch", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ id: 501, body: "Hello", created_at: "2026-07-01T00:00:00Z" })
    );
    const comment = await gitlabForgeProvider.addIssueComment(REPO, 9, "Hello");
    expect(comment.url).toBe("https://gitlab.com/group/project/-/issues/9#note_501");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });
});

describe("validateToken", () => {
  it("rejects empty tokens without a request", async () => {
    const result = await gitlabForgeProvider.validateToken("   ");
    expect(result.valid).toBe(false);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("returns user identity and PAT scopes on success", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ username: "dev", avatar_url: "https://gitlab.com/a.png" })
      )
      .mockResolvedValueOnce(jsonResponse({ scopes: ["api"], expires_at: "2027-01-01" }));

    const result = await gitlabForgeProvider.validateToken("glpat-good");

    expect(requestUrl(fetchMock().mock.calls[0])).toBe("https://gitlab.com/api/v4/user");
    expect(result.valid).toBe(true);
    expect(result.scopes).toEqual(["api"]);
    expect(result.expiresAt).toBe(Date.parse("2027-01-01"));
  });

  it("maps 401 to a rejected-token error", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "401 Unauthorized" }, { status: 401 }));
    const result = await gitlabForgeProvider.validateToken("glpat-bad");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("401");
  });

  it("rejects non-JSON answers (SSO gateways, wrong URLs)", async () => {
    fetchMock().mockResolvedValue(
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    const result = await gitlabForgeProvider.validateToken("glpat-good");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("JSON");
  });

  it("validates against the configured self-hosted instance", async () => {
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.internal.example"));
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ username: "dev" }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }));

    const result = await gitlabForgeProvider.validateToken("glpat-internal");

    expect(requestUrl(fetchMock().mock.calls[0])).toBe(
      "https://gitlab.internal.example/api/v4/user"
    );
    expect(result.valid).toBe(true);
  });
});

describe("URL builders", () => {
  const repo: RepoRef = { host: "gitlab.com", owner: "group/sub", repo: "project", rawData: null };

  it("builds issue, MR, and commit URLs with the /-/ route prefix", () => {
    expect(gitlabForgeProvider.buildIssueUrl(repo, 7)).toBe(
      "https://gitlab.com/group/sub/project/-/issues/7"
    );
    expect(gitlabForgeProvider.buildPRUrl(repo, 7)).toBe(
      "https://gitlab.com/group/sub/project/-/merge_requests/7"
    );
    expect(gitlabForgeProvider.buildCommitsUrl(repo, "feature/x")).toBe(
      "https://gitlab.com/group/sub/project/-/commits/feature%2Fx"
    );
  });

  it("maps the open state to GitLab's 'opened' in list URLs", () => {
    expect(gitlabForgeProvider.buildIssuesUrl(repo, { state: "open" })).toContain("state=opened");
    expect(gitlabForgeProvider.buildPRsUrl(repo, { query: "search term" })).toContain(
      "search=search+term"
    );
    expect(gitlabForgeProvider.buildIssuesUrl(repo, { state: "all" })).not.toContain("state=");
  });
});

describe("self-hosted base URL", () => {
  it("preserves the configured scheme, port, and path prefix for API calls", async () => {
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.internal.example:8443/gitlab"));
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-internal" });
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(SELF_HOSTED_REPO, {});

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toContain("https://gitlab.internal.example:8443/gitlab/api/v4/projects/");
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBe("Bearer glpat-internal");
  });

  it("withholds the token when the settings read fails (fail closed)", async () => {
    setInstanceUrlReader(() => Promise.reject(new Error("settings store unavailable")));
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-secret" });
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(REPO, {});

    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBeUndefined();
  });
});

describe("repoStats", () => {
  it("derives counts from x-total headers alongside first pages", async () => {
    fetchMock().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/issues")) {
        return jsonResponse([{ iid: 1, title: "I", state: "opened" }], {
          headers: { "x-total": "12" },
        });
      }
      return jsonResponse([{ iid: 2, title: "M", state: "opened" }], {
        headers: { "x-total": "4" },
      });
    });

    const stats = await gitlabForgeProvider.repoStats?.getRepoStats(REPO, { bypassCache: true });

    expect(stats?.counts.issueCount).toBe(12);
    expect(stats?.counts.prCount).toBe(4);
    expect(stats?.issues?.items[0].number).toBe(1);
    expect(stats?.prs?.items[0].number).toBe(2);
    expect(stats?.source).toBe("network");
  });

  it("reports the error without counts when the fetch fails cold", async () => {
    fetchMock().mockImplementation(async () => jsonResponse({ message: "boom" }, { status: 500 }));
    const stats = await gitlabForgeProvider.repoStats?.getRepoStats(REPO, { bypassCache: true });
    expect(stats?.counts.issueCount).toBeNull();
    expect(stats?.counts.error).toContain("boom");
  });
});
