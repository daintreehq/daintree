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

interface SearchBody {
  jql?: string;
  fields?: string[];
  maxResults?: number;
  nextPageToken?: string;
  startAt?: number;
}

function requests(): Array<{ path: string; method: string; body: SearchBody }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    path: String(url).replace(`${SITE}/rest/api/3`, ""),
    method: init.method,
    body: init.body ? JSON.parse(init.body) : undefined,
  }));
}

function searches() {
  return requests().filter((request) => request.path === "/search/jql");
}

/**
 * Answers by path prefix, or by `"METHOD prefix"` to take one method only; a
 * request with no answer fails the test rather than hanging.
 */
function route(answers: Record<string, (body: SearchBody & AssigneeBody) => Response>) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const path = String(url).replace(`${SITE}/rest/api/3`, "");
    const method = init?.method ?? "GET";
    const key = Object.keys(answers).find((pattern) => {
      const [wanted, prefix] = pattern.includes(" ") ? pattern.split(" ") : [method, pattern];
      return wanted === method && path.startsWith(prefix);
    });
    if (!key) throw new Error(`Unexpected request: ${method} ${path}`);
    return answers[key](init?.body ? JSON.parse(String(init.body)) : {});
  });
}

interface AssigneeBody {
  accountId?: string | null;
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
  });

  it("reads the key for the project it was asked about", async () => {
    const reader = vi.fn(async () => "eng");
    setProjectKeyReader(reader);
    await jiraForgeProvider.resolveIssueRepo!("/projects/background");
    expect(reader).toHaveBeenCalledWith("/projects/background");
  });

  it("addresses the project on its site, in the key's canonical case", async () => {
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toMatchObject({
      host: "acme.atlassian.net",
      owner: "acme",
      repo: "ENG",
    });
  });

  it("follows the site setting", async () => {
    settings = { siteUrl: "https://other.atlassian.net", email: "ada@example.com" };
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toMatchObject({
      host: "other.atlassian.net",
    });
  });

  it("never needs Jira, so a network failure can't lose the branch claims", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toMatchObject({ repo: "ENG" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doesn't need a token, so a project can claim branches before signing in", async () => {
    jiraForgeProvider.setCredentials?.(null);
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toMatchObject({ repo: "ENG" });
  });

  it("explains that Jira isn't connected when there's no site", async () => {
    settings = {};
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).rejects.toThrow(/isn't connected/);
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

  it("keeps an issue whose project was renamed", async () => {
    route({
      "/issue/ENG-12": () => json(node("OPS-12")),
      "/search/jql": () => json({ issues: [], isLast: true }),
    });
    const page = await jiraForgeProvider.listIssues(REPO, { search: "ENG-12" });
    expect(page.items.map((issue) => issue.key)).toEqual(["OPS-12"]);
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

  it("accepts the stable id it hands out, and follows a moved issue", async () => {
    route({ "/issue/10042": () => json({ ...node("OPS-3"), id: "10042" }) });
    const issue = await jiraForgeProvider.getIssueById!(REPO, "acme.atlassian.net/10042");
    expect(issue).toMatchObject({ key: "OPS-3", url: `${SITE}/browse/OPS-3` });
    // The id it returns finds the same issue again.
    await expect(jiraForgeProvider.getIssueById!(REPO, issue!.id!)).resolves.toMatchObject({
      key: "OPS-3",
    });
  });

  it("doesn't open another site's issue for a stored id", async () => {
    settings = { siteUrl: "https://other.atlassian.net", email: "ada@example.com" };
    await expect(
      jiraForgeProvider.getIssueById!(REPO, "acme.atlassian.net/10042")
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the full key a claimed branch carries, in any case", async () => {
    route({ "/issue/ENG-12": () => json(node("ENG-12")) });
    await expect(jiraForgeProvider.getIssueById!(REPO, "eng-12")).resolves.toMatchObject({
      key: "ENG-12",
    });
  });

  it.each(["../../myself", "..", "ENG-12/comment", "ENG 12", "", "10042", "acme.atlassian.net/.."])(
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

    settings = { siteUrl: SITE, email: "grace@example.com" };
    await expect(jiraForgeProvider.repoStats!.getRepoStats(REPO)).resolves.toMatchObject({
      source: "network",
    });
  });

  it("doesn't let a count landing after a switch pass for the new connection's", async () => {
    let respond: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (respond = resolve)));
    const stale = jiraForgeProvider.repoStats!.getRepoStats(REPO);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    settings = { siteUrl: "https://other.atlassian.net", email: "ada@example.com" };
    fetchMock.mockImplementation(async () => json({ count: 2 }));
    await jiraForgeProvider.repoStats!.getRepoStats(REPO);

    respond(json({ count: 99 }));
    await stale;

    const current = await jiraForgeProvider.repoStats!.getRepoStats(REPO);
    expect(current.source).toBe("memory-cache");
    expect(current.counts.issueCount).toBe(2);
  });

  it("counts each project separately", async () => {
    await jiraForgeProvider.repoStats!.getRepoStats(REPO);
    await expect(
      jiraForgeProvider.repoStats!.getRepoStats({ ...REPO, repo: "OPS" })
    ).resolves.toMatchObject({ source: "network" });
    expect(requests().at(-1)?.body.jql).toContain('project = "OPS"');
  });

  it("counts as unknown when Jira doesn't say", async () => {
    route({ "/search/approximate-count": () => json({}) });
    const snapshot = await jiraForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
    expect(snapshot.counts.issueCount).toBeNull();
  });
});

describe("when Jira refuses the connection", () => {
  it("stops asking, so polling can't keep failing logins against the account", async () => {
    route({ "/issue/": () => json({}, 401) });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).rejects.toThrow(/rejected/);
    await expect(jiraForgeProvider.getIssue(REPO, 13)).rejects.toThrow(/rejected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("goes out again for a deliberate check, and a good answer resumes everything", async () => {
    route({ "/issue/": () => json({}, 401) });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).rejects.toThrow(/rejected/);

    route({
      "/myself": () => json({ accountId: "abc", displayName: "Ada" }),
      "/issue/": () => json(node("ENG-12")),
    });
    await expect(jiraForgeProvider.validateCredentials()).resolves.toMatchObject({ valid: true });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).resolves.toMatchObject({ key: "ENG-12" });
  });

  it("gives a new token its own chance", async () => {
    route({ "/issue/": () => json({}, 401) });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).rejects.toThrow(/rejected/);

    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "token-2" });
    route({ "/issue/": () => json(node("ENG-12")) });
    await expect(jiraForgeProvider.getIssue(REPO, 12)).resolves.toMatchObject({ key: "ENG-12" });
  });

  it("surfaces Jira's own words for a project key it doesn't know", async () => {
    route({
      "/search/jql": () =>
        json({ errorMessages: ["The value 'ENG' does not exist for the field 'project'."] }, 400),
    });
    await expect(jiraForgeProvider.listIssues(REPO, {})).rejects.toThrow(/does not exist/);
  });
});

describe("what it doesn't do", () => {
  it("sends other writes to Jira itself", async () => {
    await expect(jiraForgeProvider.createIssue(REPO, { title: "x" })).rejects.toThrow(
      /Do it in Jira instead/
    );
    await expect(jiraForgeProvider.addIssueComment(REPO, 12, "hi")).rejects.toThrow(
      /Do it in Jira/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const ADA = {
  accountId: "acc-ada",
  displayName: "Ada Lovelace",
  avatarUrls: { "48x48": "https://avatars.example/ada.png" },
};
const BOB = { accountId: "acc-bob", displayName: "Bob Jones" };
const ADA_USER = {
  login: "Ada Lovelace",
  avatarUrl: "https://avatars.example/ada.png",
  rawData: { accountId: "acc-ada" },
};
const BOB_USER = { login: "Bob Jones", rawData: { accountId: "acc-bob" } };

describe("identity", () => {
  it("answers with the connection's own account, read once", async () => {
    route({ "/myself": () => json(ADA) });
    await expect(jiraForgeProvider.identity?.getCurrentUser()).resolves.toEqual(ADA_USER);
    await expect(jiraForgeProvider.identity?.getCurrentUser()).resolves.toEqual(ADA_USER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads the account again once the connection changes", async () => {
    route({ "/myself": () => json(ADA) });
    await jiraForgeProvider.identity?.getCurrentUser();
    settings = { siteUrl: SITE, email: "bob@example.com" };
    route({ "/myself": () => json(BOB) });
    await expect(jiraForgeProvider.identity?.getCurrentUser()).resolves.toEqual(BOB_USER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is null until connected, without calling Jira", async () => {
    settings = { siteUrl: SITE };
    await expect(jiraForgeProvider.identity?.getCurrentUser()).resolves.toBeNull();
    setMemoryToken(null);
    settings = { siteUrl: SITE, email: "ada@example.com" };
    await expect(jiraForgeProvider.identity?.getCurrentUser()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is null for a refused credential, but lets any other failure through", async () => {
    route({ "/myself": () => json({}, 401) });
    await expect(jiraForgeProvider.identity?.getCurrentUser()).resolves.toBeNull();
    // Replayed from the cooldown, and still read as refused.
    await expect(jiraForgeProvider.identity?.getCurrentUser()).resolves.toBeNull();
    clearJiraCaches();
    route({ "/myself": () => json({ errorMessages: ["Down for maintenance"] }, 503) });
    await expect(jiraForgeProvider.identity?.getCurrentUser()).rejects.toThrow(/maintenance/);
  });
});

describe("assignment", () => {
  let assignee: typeof ADA | typeof BOB | null;
  let failNextWrite: boolean;

  beforeEach(() => {
    assignee = BOB;
    failNextWrite = false;
    route({
      "/myself": () => json(ADA),
      "GET /issue/ENG-12": () => json(node("ENG-12", { assignee })),
      "PUT /issue/id-ENG-12/assignee": (body) => {
        if (failNextWrite) {
          failNextWrite = false;
          return json({ errorMessages: ["Bob Jones cannot be assigned issues."] }, 400);
        }
        assignee = body.accountId === ADA.accountId ? ADA : body.accountId ? BOB : null;
        return new Response(null, { status: 204 });
      },
    });
  });

  function writes() {
    return requests()
      .filter((request) => request.method === "PUT")
      .map((request) => ({ path: request.path, body: request.body }));
  }

  it("assigns the connected account, and Undo hands the issue back to who had it", async () => {
    await expect(jiraForgeProvider.assignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([
      ADA_USER,
    ]);
    expect(assignee).toBe(ADA);
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([
      BOB_USER,
    ]);
    expect(assignee).toBe(BOB);
    expect(writes()).toEqual([
      { path: "/issue/id-ENG-12/assignee", body: { accountId: "acc-ada" } },
      { path: "/issue/id-ENG-12/assignee", body: { accountId: "acc-bob" } },
    ]);
  });

  it("leaves an issue that nobody had unassigned again on Undo", async () => {
    assignee = null;
    await jiraForgeProvider.assignIssue(REPO, 12, "Ada Lovelace");
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([]);
    expect(assignee).toBeNull();
    expect(writes().map((write) => write.body)).toEqual([
      { accountId: "acc-ada" },
      { accountId: null },
    ]);
  });

  it("leaves an issue that was already the viewer's alone, and its Undo too", async () => {
    assignee = ADA;
    await expect(jiraForgeProvider.assignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([
      ADA_USER,
    ]);
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([
      ADA_USER,
    ]);
    expect(assignee).toBe(ADA);
    expect(writes()).toEqual([]);
  });

  it("doesn't undo over someone who has taken the issue since", async () => {
    await jiraForgeProvider.assignIssue(REPO, 12, "Ada Lovelace");
    assignee = BOB;
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([
      BOB_USER,
    ]);
    expect(writes()).toHaveLength(1);
  });

  it("takes the issue off the viewer when there's nobody to hand it back to", async () => {
    assignee = ADA;
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([]);
    expect(assignee).toBeNull();
  });

  it("still knows who to hand the issue back to after a failed Undo", async () => {
    await jiraForgeProvider.assignIssue(REPO, 12, "Ada Lovelace");
    failNextWrite = true;
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).rejects.toThrow(
      /cannot be assigned/
    );
    expect(assignee).toBe(ADA);
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([
      BOB_USER,
    ]);
    expect(assignee).toBe(BOB);
  });

  it("doesn't carry what it remembers over to another connection", async () => {
    await jiraForgeProvider.assignIssue(REPO, 12, "Ada Lovelace");
    jiraForgeProvider.setCredentials({ kind: "bearer", value: "token-2" });
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).resolves.toEqual([]);
    expect(assignee).toBeNull();
  });

  it("knows the viewer by account id too", async () => {
    await expect(jiraForgeProvider.assignIssue(REPO, 12, "acc-ada")).resolves.toEqual([ADA_USER]);
  });

  it("refuses to assign anyone but the connected account", async () => {
    await expect(jiraForgeProvider.assignIssue(REPO, 12, "Bob Jones")).rejects.toThrow(
      /only be assigned to you/
    );
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "acc-bob")).rejects.toThrow(
      /only be assigned to you/
    );
    expect(writes()).toEqual([]);
  });

  it("refuses an issue Jira doesn't have, or one that has moved away", async () => {
    route({ "/myself": () => json(ADA), "/issue/ENG-12": () => json({}, 404) });
    await expect(jiraForgeProvider.assignIssue(REPO, 12, "Ada Lovelace")).rejects.toThrow(
      "Jira issue ENG-12 wasn't found"
    );
    route({ "/myself": () => json(ADA), "/issue/ENG-12": () => json(node("OPS-3")) });
    await expect(jiraForgeProvider.unassignIssue(REPO, 12, "Ada Lovelace")).rejects.toThrow(
      "Jira issue ENG-12 wasn't found"
    );
    expect(writes()).toEqual([]);
  });
});

describe("issue comments", () => {
  function adf(text: string) {
    return {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    };
  }

  function comment(id: string, author: typeof ADA | typeof BOB, text: string, created: string) {
    return { id, author, body: adf(text), created, updated: created };
  }

  const list = (opts = {}) => jiraForgeProvider.issueComments!.listIssueComments(REPO, 12, opts);

  function commentRequests() {
    return requests()
      .filter((request) => request.path.includes("/comment"))
      .map((request) => new URL(request.path, SITE));
  }

  it("lists the thread oldest first, with author, time and readable text", async () => {
    route({
      "/issue/ENG-12": () => json(node("ENG-12")),
      "/issue/id-ENG-12/comment": () =>
        json({
          startAt: 0,
          maxResults: 20,
          total: 2,
          comments: [
            comment("10001", ADA, "Can repro on staging.", "2026-10-03T10:00:00.000+0000"),
            comment("10002", BOB, "Fixed by the retry.", "2026-10-04T09:30:00.000+0000"),
          ],
        }),
    });
    await expect(list()).resolves.toEqual({
      items: [
        {
          id: "10001",
          body: "Can repro on staging.",
          url: `${SITE}/browse/ENG-12?focusedCommentId=10001`,
          author: ADA_USER,
          createdAt: Date.parse("2026-10-03T10:00:00.000Z"),
          rawData: { id: "10001" },
        },
        {
          id: "10002",
          body: "Fixed by the retry.",
          url: `${SITE}/browse/ENG-12?focusedCommentId=10002`,
          author: BOB_USER,
          createdAt: Date.parse("2026-10-04T09:30:00.000Z"),
          rawData: { id: "10002" },
        },
      ],
      nextCursor: null,
      hasMore: false,
      totalCount: 2,
    });
    const [url] = commentRequests();
    expect(url.pathname).toBe("/issue/id-ENG-12/comment");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startAt: "0",
      maxResults: "20",
      orderBy: "created",
    });
  });

  it("pages through a long thread by offset", async () => {
    const all = ["a", "b", "c"].map((text, i) =>
      comment(`1000${i}`, ADA, text, `2026-10-0${i + 1}T00:00:00.000+0000`)
    );
    route({
      "/issue/ENG-12": () => json(node("ENG-12")),
      "/issue/id-ENG-12/comment": () => {
        const url = commentRequests().at(-1)!;
        const startAt = Number(url.searchParams.get("startAt"));
        const max = Number(url.searchParams.get("maxResults"));
        return json({ startAt, total: 3, comments: all.slice(startAt, startAt + max) });
      },
    });
    const first = await list({ perPage: 2 });
    expect(first.items.map((item) => item.body)).toEqual(["a", "b"]);
    expect(first).toMatchObject({ nextCursor: "2", hasMore: true });
    const second = await list({ perPage: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.body)).toEqual(["c"]);
    expect(second).toMatchObject({ nextCursor: null, hasMore: false });
  });

  it("stops at an empty page whatever the total says", async () => {
    route({
      "/issue/ENG-12": () => json(node("ENG-12")),
      "/issue/id-ENG-12/comment": () => json({ startAt: 4, total: 9, comments: [] }),
    });
    await expect(list({ cursor: "4" })).resolves.toMatchObject({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("reads a thread nobody has commented on as an empty page", async () => {
    route({
      "/issue/ENG-12": () => json(node("ENG-12")),
      "/issue/id-ENG-12/comment": () => json({ startAt: 0, total: 0, comments: [] }),
    });
    await expect(list()).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
      totalCount: 0,
    });
  });

  it("bounds the page size", async () => {
    route({
      "/issue/ENG-12": () => json(node("ENG-12")),
      "/issue/id-ENG-12/comment": () => json({ startAt: 0, total: 0, comments: [] }),
    });
    await list({ perPage: 500 });
    await list({ perPage: 0 });
    await list({ perPage: Number.NaN });
    expect(commentRequests().map((url) => url.searchParams.get("maxResults"))).toEqual([
      "100",
      "1",
      "20",
    ]);
  });

  it.each(["-1", "1.5", "1e3", " 2", "abc", "99999999999999999999"])(
    "refuses the cursor %s without calling Jira",
    async (cursor) => {
      await expect(list({ cursor })).rejects.toThrow(/cursor/);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("throws for an issue Jira doesn't have, rather than reading as nobody replied", async () => {
    route({ "/issue/ENG-12": () => json({}, 404) });
    await expect(list()).rejects.toThrow("Jira issue ENG-12 wasn't found");
    expect(commentRequests()).toEqual([]);
  });

  it("refuses an issue that has moved to another project", async () => {
    route({ "/issue/ENG-12": () => json(node("OPS-3")) });
    await expect(list()).rejects.toThrow("Jira issue ENG-12 wasn't found");
    expect(commentRequests()).toEqual([]);
  });

  it("links comments by the key Jira answered with, after a project rename", async () => {
    route({
      "/issue/ENG-12": () => json(node("CORE-12")),
      "/issue/id-CORE-12/comment": () =>
        json({
          startAt: 0,
          total: 1,
          comments: [comment("10009", BOB, "x", "2026-10-03T10:00:00.000+0000")],
        }),
    });
    const page = await list();
    expect(page.items[0].url).toBe(`${SITE}/browse/CORE-12?focusedCommentId=10009`);
  });
});
