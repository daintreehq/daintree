import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoRef } from "../../../../../shared/types/forge.js";
import {
  GitHubAuth,
  rateLimitAwareFetch,
  _resetGithubFetchSemaphoreForTests,
} from "../GitHubAuth.js";
import { _resetEnterpriseHostForTests, setEnterpriseHost } from "../GitHubHost.js";
import { _resetForgeQueryCachesForTests, clearGitHubCaches } from "../GitHubCaches.js";
import { gitHubRateLimitService, rateLimitServiceForHost } from "../GitHubRateLimitService.js";
import { githubForgeProvider } from "../forgeProvider.js";

const GHES = "github.example.com";
const GITHUB_COM_REPO: RepoRef = { host: "github.com", owner: "team", repo: "app", rawData: null };
const GHES_REPO: RepoRef = { host: GHES, owner: "team", repo: "app", rawData: null };

interface SeenRequest {
  url: string;
  authorization: string | null;
}

let seen: SeenRequest[] = [];

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

function stubFetch(respond: (url: string) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, authorization: headerOf(init, "authorization") });
    return new Response(JSON.stringify(respond(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function metadataFor(url: string) {
  const branch = url.startsWith(`https://${GHES}/`) ? "trunk" : "main";
  return { data: { repository: { defaultBranchRef: { name: branch } } } };
}

beforeEach(() => {
  seen = [];
  GitHubAuth._resetSessionsForTests();
  _resetEnterpriseHostForTests();
  _resetGithubFetchSemaphoreForTests();
  _resetForgeQueryCachesForTests();
  clearGitHubCaches();
  gitHubRateLimitService._resetForTests();
  setEnterpriseHost(GHES);
  GitHubAuth.setMemoryToken("github-com-token");
  GitHubAuth.setMemoryToken("enterprise-token", GHES);
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetEnterpriseHostForTests();
  GitHubAuth._resetSessionsForTests();
});

describe("GitHub requests by repository host (#17324)", () => {
  it("sends GraphQL reads to each repository's own host with that host's token", async () => {
    stubFetch(metadataFor);

    const github = await githubForgeProvider.getRepoMetadata(GITHUB_COM_REPO);
    const enterprise = await githubForgeProvider.getRepoMetadata(GHES_REPO);

    expect(seen).toEqual([
      { url: "https://api.github.com/graphql", authorization: "Bearer github-com-token" },
      { url: `https://${GHES}/api/graphql`, authorization: "Bearer enterprise-token" },
    ]);
    // The same owner/repo on two hosts is two repositories: no shared cache entry.
    expect(github.defaultBranch).toBe("main");
    expect(enterprise.defaultBranch).toBe("trunk");
  });

  it("sends REST writes to the Enterprise Server's /api/v3 with its token", async () => {
    stubFetch(() => ({
      number: 7,
      html_url: `https://${GHES}/team/app/issues/7`,
      title: "Broken build",
      state: "open",
      user: { login: "octocat" },
      labels: [],
      assignees: [],
      created_at: "2026-11-17T00:00:00Z",
      updated_at: "2026-11-17T00:00:00Z",
    }));

    await githubForgeProvider.createIssue!(GHES_REPO, { title: "Broken build" });

    expect(seen).toEqual([
      {
        url: `https://${GHES}/api/v3/repos/team/app/issues`,
        authorization: "Bearer enterprise-token",
      },
    ]);
  });

  it("never falls back to github.com's token for an Enterprise Server repository", async () => {
    const fetchMock = stubFetch(metadataFor);
    GitHubAuth.setMemoryToken(null, GHES);

    await expect(githubForgeProvider.getRepoMetadata(GHES_REPO)).rejects.toThrow(
      `No GitHub token for ${GHES}`
    );
    await expect(githubForgeProvider.createIssue!(GHES_REPO, { title: "x" })).rejects.toThrow(
      `No GitHub token for ${GHES}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops using a host's token once that host is no longer configured", () => {
    setEnterpriseHost("");

    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
    expect(githubForgeProvider.parseRemote(`https://${GHES}/team/app.git`)).toBeNull();
    expect(GitHubAuth.getToken()).toBe("github-com-token");
  });

  it("refuses to send one host's token to the other", async () => {
    const fetchMock = stubFetch(() => ({}));

    await expect(
      rateLimitAwareFetch(`https://${GHES}/api/v3/user`, {
        headers: { Authorization: "Bearer github-com-token" },
      })
    ).rejects.toThrow(/github\.com GitHub token/);
    await expect(
      rateLimitAwareFetch("https://api.github.com/user", {
        headers: { Authorization: "Bearer enterprise-token" },
      })
    ).rejects.toThrow(new RegExp(GHES.replace(/\./g, "\\.")));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["another server", "https://evil.example/api/v3/user", "github-com-token"],
    ["a lookalike port", `https://${GHES}:8443/api/v3/user`, "enterprise-token"],
    ["a non-API path", `https://${GHES}/login`, "enterprise-token"],
    ["github.com's web origin", "https://github.com/user", "github-com-token"],
  ])("refuses a held token bound for %s", async (_label, url, token) => {
    const fetchMock = stubFetch(() => ({}));

    await expect(
      rateLimitAwareFetch(url, { headers: { Authorization: `Bearer ${token}` } })
    ).rejects.toThrow(/Refused to send/);
    await expect(
      rateLimitAwareFetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }))
    ).rejects.toThrow(/Refused to send/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a credential when only the Enterprise Server has a token", async () => {
    GitHubAuth.setMemoryToken(null);

    await expect(githubForgeProvider.getCredentials()).resolves.toEqual({
      kind: "bearer",
      value: "enterprise-token",
    });
  });

  it("names each host's own account as the viewer", async () => {
    GitHubAuth.setValidatedUserInfo("octocat", undefined, ["repo"], undefined);
    GitHubAuth.setValidatedUserInfo("mona", undefined, ["repo"], undefined, GHES);

    await expect(githubForgeProvider.identity!.getCurrentUser(GHES_REPO)).resolves.toMatchObject({
      login: "mona",
    });
    await expect(
      githubForgeProvider.identity!.getCurrentUser(GITHUB_COM_REPO)
    ).resolves.toMatchObject({ login: "octocat" });
  });

  it("builds web URLs on the repository's host", () => {
    expect(githubForgeProvider.buildPRUrl(GHES_REPO, 5)).toBe(`https://${GHES}/team/app/pull/5`);
    expect(githubForgeProvider.buildPRUrl(GITHUB_COM_REPO, 5)).toBe(
      "https://github.com/team/app/pull/5"
    );
    expect(githubForgeProvider.parseRemote(`git@${GHES}:team/app.git`)?.host).toBe(GHES);
  });

  it("keeps an Enterprise Server rate-limit block off github.com's requests", async () => {
    stubFetch(metadataFor);
    rateLimitServiceForHost(GHES).update(
      new Headers({ "retry-after": "60" }),
      429,
      undefined,
      undefined
    );

    await expect(githubForgeProvider.getRepoMetadata(GHES_REPO)).rejects.toThrow(/rate limit/i);
    expect(seen.some((request) => request.url.startsWith(`https://${GHES}/`))).toBe(false);
    await expect(githubForgeProvider.getRepoMetadata(GITHUB_COM_REPO)).resolves.toMatchObject({
      defaultBranch: "main",
    });
  });

  it("keeps a github.com rate-limit block off Enterprise Server batch lookups", async () => {
    stubFetch(() => ({ data: { repository: { pr1: null }, rateLimit: null } }));
    gitHubRateLimitService.update(new Headers({ "retry-after": "60" }), 429, undefined, undefined);

    await githubForgeProvider.batchLookups!.findPRsByNumbers!(GHES_REPO, [1]);

    expect(seen.map((request) => request.url)).toEqual([`https://${GHES}/api/graphql`]);
  });

  it("never sends an Enterprise Server author's email to github.com's user search", async () => {
    const fetchMock = stubFetch(() => ({ items: [] }));

    await expect(
      githubForgeProvider.avatars!.resolveAuthorAvatar("dev@corp.example", GHES_REPO)
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
