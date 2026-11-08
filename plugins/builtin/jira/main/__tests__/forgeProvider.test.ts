import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  claimIssueFromBranch,
  normalizeIssueBranchKeys,
  setIssueBranchClaim,
} from "../../../../../electron/services/issueBranchClaim.js";
import type { RepoRef } from "../../../../../shared/types/forge.js";
import { issueBranchName } from "../../../../../shared/utils/issueBranchName.js";
import {
  clearJiraCaches,
  jiraForgeProvider,
  normalizeProjectKey,
  setConnectionSettingsReader,
  setProjectKeyReader,
} from "../forgeProvider.js";
import { setMemoryToken } from "../JiraClient.js";

const SITE = "https://acme.atlassian.net";
const REPO: RepoRef = {
  host: "acme.atlassian.net",
  owner: "acme",
  repo: "ENG",
  rawData: { projectId: "10000" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function node(key = "ENG-12", overrides: Record<string, unknown> = {}) {
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary: `Summary of ${key}`,
      description: null,
      status: { name: "To Do", statusCategory: { key: "new" } },
      labels: [],
      created: "2026-10-01T00:00:00.000+0000",
      updated: "2026-10-02T00:00:00.000+0000",
      ...overrides,
    },
  };
}

const DONE = { status: { name: "Done", statusCategory: { key: "done" } } };

let fetchMock: Mock;
let settings: { siteUrl?: unknown; email?: unknown };

function requests(): Array<{ path: string; method: string; body: any }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    path: String(url).replace(`${SITE}/rest/api/3`, ""),
    method: init.method,
    body: init.body ? JSON.parse(init.body) : undefined,
  }));
}

function searches() {
  return requests().filter((request) => request.path === "/search/jql");
}

/** Answers by path; a path with no answer fails the test rather than hanging. */
function route(answers: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url).replace(`${SITE}/rest/api/3`, "");
    const key = Object.keys(answers).find((prefix) => path.startsWith(prefix));
    if (!key) throw new Error(`Unexpected request: ${path}`);
    return answers[key]();
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  settings = { siteUrl: SITE, email: "ada@example.com" };
  setConnectionSettingsReader(async () => settings);
  setProjectKeyReader(async () => "eng");
  setMemoryToken("token-1");
  clearJiraCaches();
});

afterEach(() => {
  setMemoryToken(null);
  setConnectionSettingsReader(null);
  setProjectKeyReader(null);
  clearJiraCaches();
  vi.unstubAllGlobals();
});

describe("normalizeProjectKey", () => {
  it("upper-cases a usable key", () => {
    expect(normalizeProjectKey(" eng ")).toBe("ENG");
    expect(normalizeProjectKey("A_B2")).toBe("A_B2");
  });

  it.each(["", "   ", "2ENG", "EN G", "ENG-1", "ABCDEFGHIJKLMNOPQ", undefined, 12])(
    "rejects %s",
    (value) => {
      expect(normalizeProjectKey(value)).toBeNull();
    }
  );
});

describe("credentials", () => {
  it("checks the token with the site and email from settings, naming who signed in", async () => {
    route({ "/myself": () => json({ accountId: "abc", displayName: "Ada Lovelace" }) });
    await expect(jiraForgeProvider.validateToken(" candidate ")).resolves.toEqual({
      valid: true,
      account: "Ada Lovelace",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE}/rest/api/3/myself`);
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("ada@example.com:candidate").toString("base64")}`
    );
  });

  it("falls back to the email when there's no display name", async () => {
    route({ "/myself": () => json({ accountId: "abc", emailAddress: "ada@example.com" }) });
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toMatchObject({
      account: "ada@example.com",
    });
  });

  it("asks for a missing token, site or email without calling Jira", async () => {
    await expect(jiraForgeProvider.validateToken("  ")).resolves.toMatchObject({ valid: false });
    settings = { email: "ada@example.com" };
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toEqual({
      valid: false,
      error: expect.stringContaining("site URL"),
    });
    settings = { siteUrl: SITE };
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toEqual({
      valid: false,
      error: expect.stringContaining("email"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends the token to a site that isn't Jira Cloud", async () => {
    settings = { siteUrl: "https://evil.example", email: "ada@example.com" };
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toMatchObject({
      valid: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a refused token", async () => {
    route({ "/myself": () => json({}, 401) });
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toEqual({
      valid: false,
      error: expect.stringContaining("rejected"),
    });
  });

  it("doesn't take an answer with no account for a sign-in", async () => {
    route({ "/myself": () => json({}) });
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toMatchObject({
      valid: false,
    });
  });

  it("validates the stored token, and says when there's none", async () => {
    route({ "/myself": () => json({ accountId: "abc", displayName: "Ada" }) });
    await expect(jiraForgeProvider.validateCredentials()).resolves.toEqual({
      valid: true,
      account: "Ada",
    });
    jiraForgeProvider.setCredentials?.(null);
    await expect(jiraForgeProvider.validateCredentials()).resolves.toMatchObject({ valid: false });
  });

  it("holds the host's credential in memory", async () => {
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: " token-2 " });
    await expect(jiraForgeProvider.getCredentials()).resolves.toEqual({
      kind: "bearer",
      value: "token-2",
    });
    jiraForgeProvider.setCredentials?.(null);
    await expect(jiraForgeProvider.getCredentials()).resolves.toBeNull();
  });
});

describe("resolveIssueRepo", () => {
  it("is null until the project names a Jira project", async () => {
    setProjectKeyReader(async () => undefined);
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toBeNull();
    setProjectKeyReader(async () => "not a key");
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the key for the project it was asked about", async () => {
    const reader = vi.fn(async () => "eng");
    setProjectKeyReader(reader);
    route({ "/project/": () => json({ id: "10000", key: "ENG" }) });
    await jiraForgeProvider.resolveIssueRepo!("/projects/background");
    expect(reader).toHaveBeenCalledWith("/projects/background");
  });

  it("addresses the project on its site", async () => {
    route({ "/project/ENG": () => json({ id: "10000", key: "ENG" }) });
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toEqual({
      host: "acme.atlassian.net",
      owner: "acme",
      repo: "ENG",
      rawData: { projectId: "10000" },
    });
  });

  it("names the key Jira doesn't know", async () => {
    route({ "/project/": () => json({}, 404) });
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).rejects.toThrow(
      /no project ENG .*Project settings/
    );
  });

  it("explains that Jira isn't connected rather than calling it", async () => {
    settings = {};
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).rejects.toThrow(/isn't connected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the project once per connection", async () => {
    route({ "/project/": () => json({ id: "10000", key: "ENG" }) });
    await jiraForgeProvider.resolveIssueRepo!("/p");
    await jiraForgeProvider.resolveIssueRepo!("/p");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    settings = { siteUrl: "https://other.atlassian.net", email: "ada@example.com" };
    fetchMock.mockImplementation(async () => json({ id: "20000", key: "ENG" }));
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toMatchObject({
      host: "other.atlassian.net",
      rawData: { projectId: "20000" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "token-2" });
    await jiraForgeProvider.resolveIssueRepo!("/p");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("listIssues", () => {
  it("uses the search that replaced the retired endpoint", async () => {
    route({ "/search/jql": () => json({ issues: [node()], isLast: true }) });
    const page = await jiraForgeProvider.listIssues(REPO, { state: "open" });

    const [request] = requests();
    expect(request.path).toBe("/search/jql");
    expect(request.method).toBe("POST");
    expect(request.body).toMatchObject({
      jql: 'project = "ENG" AND statusCategory != "Done" ORDER BY created DESC',
      maxResults: 50,
    });
    expect(request.body.fields).toEqual(expect.arrayContaining(["summary", "description"]));
    expect(request.body.startAt).toBeUndefined();
    expect(page).toMatchObject({ nextCursor: null, hasMore: false });
    expect(page.items[0]).toMatchObject({
      number: 12,
      key: "ENG-12",
      url: `${SITE}/browse/ENG-12`,
      branchName: "ENG-12-summary-of-eng-12",
    });
  });

  it("never touches the legacy search", async () => {
    route({
      "/search/jql": () => json({ issues: [], isLast: true }),
      "/issue/": () => json({}, 404),
    });
    await jiraForgeProvider.listIssues(REPO, { search: "ENG-12" });
    for (const { path } of requests()) {
      expect(path === "/search" || path.startsWith("/search?")).toBe(false);
    }
  });

  it("escapes quotes and backslashes on the way to Jira", async () => {
    route({ "/search/jql": () => json({ issues: [], isLast: true }) });
    await jiraForgeProvider.listIssues(REPO, { search: 'a"b\\c' });
    expect(requests()[0].body.jql).toContain('text ~ "a\\\\\\"b\\\\\\\\c*"');
  });

  it("answers a search with nothing to search for without calling Jira", async () => {
    await expect(jiraForgeProvider.listIssues(REPO, { search: '"' })).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the page token back unchanged and reports no total", async () => {
    route({ "/search/jql": () => json({ issues: [node()], nextPageToken: "tok", isLast: false }) });
    const first = await jiraForgeProvider.listIssues(REPO, {});
    expect(first).toMatchObject({ nextCursor: "tok", hasMore: true });
    expect(first.totalCount).toBeUndefined();

    route({ "/search/jql": () => json({ issues: [], isLast: true }) });
    await jiraForgeProvider.listIssues(REPO, { cursor: "tok" });
    expect(searches().at(-1)?.body.nextPageToken).toBe("tok");
  });

  it("isn't fooled by a token on the last page", async () => {
    route({ "/search/jql": () => json({ issues: [], nextPageToken: "tok", isLast: true }) });
    await expect(jiraForgeProvider.listIssues(REPO, {})).resolves.toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
  });

  it("bounds the page size", async () => {
    route({ "/search/jql": () => json({ issues: [], isLast: true }) });
    await jiraForgeProvider.listIssues(REPO, { perPage: 1000 });
    await jiraForgeProvider.listIssues(REPO, { perPage: 0 });
    expect(searches().map((search) => search.body.maxResults)).toEqual([100, 1]);
  });

  it("refuses a sort it can't serve without calling Jira", async () => {
    await expect(jiraForgeProvider.listIssues(REPO, { sort: "comments" })).rejects.toThrow(
      /can't sort/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds a full key, first, without a key clause that fails for a missing issue", async () => {
    route({
      "/issue/ENG-12": () => json(node("ENG-12")),
      "/search/jql": () =>
        json({ issues: [node("ENG-30"), node("ENG-12"), node("ENG-5")], isLast: true }),
    });
    const page = await jiraForgeProvider.listIssues(REPO, { search: "eng-12" });
    expect(page.items.map((issue) => issue.key)).toEqual(["ENG-12", "ENG-30", "ENG-5"]);
    expect(searches()[0].body.jql).not.toMatch(/\bkey\b/);
  });

  it("finds an issue by its bare number", async () => {
    route({
      "/issue/ENG-12": () => json(node("ENG-12")),
      "/search/jql": () => json({ issues: [], isLast: true }),
    });
    const page = await jiraForgeProvider.listIssues(REPO, { search: "#12" });
    expect(page.items.map((issue) => issue.key)).toEqual(["ENG-12"]);
  });

  it("keeps searching when the key names no issue", async () => {
    route({
      "/issue/ENG-999": () => json({ errorMessages: ["Issue does not exist"] }, 404),
      "/search/jql": () => json({ issues: [node("ENG-5")], isLast: true }),
    });
    const page = await jiraForgeProvider.listIssues(REPO, { search: "ENG-999" });
    expect(page.items.map((issue) => issue.key)).toEqual(["ENG-5"]);
  });

  it("doesn't reach into another project for a key", async () => {
    route({ "/search/jql": () => json({ issues: [], isLast: true }) });
    const page = await jiraForgeProvider.listIssues(REPO, { search: "DES-12" });
    expect(page.items).toEqual([]);
    expect(requests().map((request) => request.path)).toEqual(["/search/jql"]);
  });

  it("leaves out an issue that has moved to another project", async () => {
    route({
      "/issue/ENG-12": () => json(node("OPS-3")),
      "/search/jql": () => json({ issues: [], isLast: true }),
    });
    const page = await jiraForgeProvider.listIssues(REPO, { search: "ENG-12" });
    expect(page.items).toEqual([]);
  });

  it("holds a named issue to the requested state", async () => {
    route({
      "/issue/ENG-12": () => json(node("ENG-12", DONE)),
      "/search/jql": () => json({ issues: [], isLast: true }),
    });
    await expect(
      jiraForgeProvider.listIssues(REPO, { search: "ENG-12", state: "open" })
    ).resolves.toMatchObject({ items: [] });
    const closed = await jiraForgeProvider.listIssues(REPO, { search: "ENG-12", state: "closed" });
    expect(closed.items.map((issue) => issue.key)).toEqual(["ENG-12"]);
    const all = await jiraForgeProvider.listIssues(REPO, { search: "ENG-12", state: "all" });
    expect(all.items.map((issue) => issue.key)).toEqual(["ENG-12"]);
  });

  it("looks a key up only for the first page", async () => {
    route({ "/search/jql": () => json({ issues: [], isLast: true }) });
    await jiraForgeProvider.listIssues(REPO, { search: "ENG-12", cursor: "tok" });
    expect(requests().map((request) => request.path)).toEqual(["/search/jql"]);
  });

  it("lets a rejected credential through rather than reading it as no issues", async () => {
    route({
      "/issue/ENG-12": () => json({}, 401),
      "/search/jql": () => json({ issues: [], isLast: true }),
    });
    await expect(jiraForgeProvider.listIssues(REPO, { search: "ENG-12" })).rejects.toThrow(
      /rejected/
    );
  });
});

describe("issue lookup", () => {
  it("reads an issue by its number in the project", async () => {
    route({ "/issue/ENG-12": () => json(node("ENG-12")) });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).resolves.toMatchObject({ key: "ENG-12" });
  });

  it("is null for an issue Jira doesn't have", async () => {
    route({ "/issue/": () => json({}, 404) });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).resolves.toBeNull();
  });

  it("is null for a number that now belongs to a moved issue", async () => {
    route({ "/issue/ENG-12": () => json(node("OPS-3")) });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).resolves.toBeNull();
  });

  it("accepts the stable id a link stores, and follows a moved issue", async () => {
    route({ "/issue/10042": () => json(node("OPS-3")) });
    await expect(jiraForgeProvider.getIssueById!(REPO, "10042")).resolves.toMatchObject({
      key: "OPS-3",
      url: `${SITE}/browse/OPS-3`,
    });
  });

  it("accepts the full key a claimed branch carries, in any case", async () => {
    route({ "/issue/ENG-12": () => json(node("ENG-12")) });
    await expect(jiraForgeProvider.getIssueById!(REPO, "eng-12")).resolves.toMatchObject({
      key: "ENG-12",
    });
  });

  it.each(["../../myself", "..", "ENG-12/comment", "ENG 12", ""])(
    "won't send %s to Jira as an issue id",
    async (id) => {
      await expect(jiraForgeProvider.getIssueById!(REPO, id)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("claims branches by the project's key", async () => {
    await expect(jiraForgeProvider.getIssueBranchKeys!(REPO)).resolves.toEqual(["ENG"]);
  });
});

describe("through the host's own branch handling", () => {
  afterEach(() => {
    setIssueBranchClaim(null);
  });

  it("creates a branch from an issue that the same provider then claims", async () => {
    route({ "/search/jql": () => json({ issues: [node("ENG-12")], isLast: true }) });
    const { items } = await jiraForgeProvider.listIssues(REPO, {});

    const branch = issueBranchName(items[0], "feature/issue-12");
    expect(branch).toBe("ENG-12-summary-of-eng-12");

    const keys = normalizeIssueBranchKeys(await jiraForgeProvider.getIssueBranchKeys!(REPO));
    setIssueBranchClaim({ providerId: "daintree.jira.jira", keys });
    expect(claimIssueFromBranch(branch)).toMatchObject({
      issueProviderId: "daintree.jira.jira",
      issueKey: "ENG-12",
      number: 12,
    });
    // A branch made by hand claims the same issue, whatever its case or prefix.
    expect(claimIssueFromBranch("jo/eng-12-fix")).toMatchObject({ issueKey: "ENG-12" });
  });

  it("looks a claimed branch's key back up", async () => {
    setIssueBranchClaim({ providerId: "daintree.jira.jira", keys: ["ENG"] });
    const claim = claimIssueFromBranch("eng-12-fix");
    route({ "/issue/ENG-12": () => json(node("ENG-12")) });
    await expect(jiraForgeProvider.getIssueById!(REPO, claim!.issueKey)).resolves.toMatchObject({
      url: `${SITE}/browse/ENG-12`,
    });
  });
});

describe("links", () => {
  it("links back to the issue on its site", () => {
    expect(jiraForgeProvider.buildIssueUrl(REPO, 12)).toBe(`${SITE}/browse/ENG-12`);
  });

  it("opens the project's open issues", () => {
    const url = new URL(jiraForgeProvider.buildIssuesUrl(REPO));
    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe("/issues/");
    expect(url.searchParams.get("jql")).toBe('project = "ENG" AND statusCategory != "Done"');
  });

  it("carries a state and query, escaped", () => {
    const url = new URL(jiraForgeProvider.buildIssuesUrl(REPO, { query: 'a"b', state: "all" }));
    expect(url.searchParams.get("jql")).toBe('project = "ENG" AND text ~ "a\\\\\\"b*"');
  });
});

describe("repoStats", () => {
  beforeEach(() => {
    route({ "/search/approximate-count": () => json({ count: 7 }) });
  });

  it("counts the project's open issues with the approximate count", async () => {
    const snapshot = await jiraForgeProvider.repoStats!.getRepoStats(REPO);
    expect(snapshot.counts).toMatchObject({ issueCount: 7, prCount: null });
    expect(snapshot.source).toBe("network");
    expect(requests()[0].body).toEqual({
      jql: 'project = "ENG" AND statusCategory != "Done"',
    });
  });

  it("reuses a count until asked for a fresh one", async () => {
    await jiraForgeProvider.repoStats!.getRepoStats(REPO);
    const cached = await jiraForgeProvider.repoStats!.getRepoStats(REPO);
    expect(cached.source).toBe("memory-cache");
    expect(cached.counts.issueCount).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jiraForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't serve one connection's count to another", async () => {
    await jiraForgeProvider.repoStats!.getRepoStats(REPO);
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "token-2" });
    await expect(jiraForgeProvider.repoStats!.getRepoStats(REPO)).resolves.toMatchObject({
      source: "network",
    });
  });

  it("counts as unknown when Jira doesn't say", async () => {
    route({ "/search/approximate-count": () => json({}) });
    const snapshot = await jiraForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
    expect(snapshot.counts.issueCount).toBeNull();
  });
});

describe("what it doesn't do", () => {
  it("sends writes to Jira itself", async () => {
    await expect(jiraForgeProvider.createIssue(REPO, { title: "x" })).rejects.toThrow(
      /Do it in Jira instead/
    );
    await expect(jiraForgeProvider.assignIssue(REPO, 12, "ada")).rejects.toThrow(/Do it in Jira/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no current user, so the host offers no Assign to me", () => {
    expect(jiraForgeProvider.identity).toBeUndefined();
  });
});
