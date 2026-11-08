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
const CAROL = { accountId: "acc-carol", displayName: "Carol Diaz" };
const ADA_USER = {
  login: "Ada Lovelace",
  avatarUrl: "https://avatars.example/ada.png",
  rawData: { accountId: "acc-ada" },
};
const BOB_USER = { login: "Bob Jones", rawData: { accountId: "acc-bob" } };
const CAROL_USER = { login: "Carol Diaz", rawData: { accountId: "acc-carol" } };

type Person = typeof ADA | typeof BOB | typeof CAROL;

describe("identity", () => {
  const current = () => jiraForgeProvider.identity!.getCurrentUser();

  it("answers with the connection's own account, read once", async () => {
    route({ "/myself": () => json(ADA) });
    await expect(current()).resolves.toEqual(ADA_USER);
    await expect(current()).resolves.toEqual(ADA_USER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads the account again once the connection changes", async () => {
    route({ "/myself": () => json(ADA) });
    await current();
    settings = { siteUrl: SITE, email: "bob@example.com" };
    route({ "/myself": () => json(BOB) });
    await expect(current()).resolves.toEqual(BOB_USER);
    settings = { siteUrl: "https://other.atlassian.net", email: "bob@example.com" };
    fetchMock.mockImplementation(async () => json(CAROL));
    await expect(current()).resolves.toEqual(CAROL_USER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is null until connected, without calling Jira", async () => {
    settings = { siteUrl: SITE };
    await expect(current()).resolves.toBeNull();
    setMemoryToken(null);
    settings = { siteUrl: SITE, email: "ada@example.com" };
    await expect(current()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is null for a refused credential", async () => {
    route({ "/myself": () => json({}, 401) });
    await expect(current()).resolves.toBeNull();
    // Replayed from the cooldown, and still read as refused.
    await expect(current()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is null for a credential Jira served as anonymous", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "X-Seraph-LoginReason": "AUTHENTICATED_FAILED" },
        })
    );
    await expect(current()).resolves.toBeNull();
    await expect(current()).resolves.toBeNull();
  });

  it.each([
    [403, /No permission/],
    [429, /rate limit/],
    [503, /maintenance/],
  ])("lets a %s through rather than reading it as signed out", async (status, message) => {
    const errorMessages = [status === 403 ? "No permission" : "Down for maintenance"];
    route({ "/myself": () => json({ errorMessages }, status) });
    await expect(current()).rejects.toThrow(message);
  });

  it("doesn't take an answer with no account for a user", async () => {
    route({ "/myself": () => json({ displayName: "Ada Lovelace" }) });
    await expect(current()).rejects.toThrow(/didn't recognize this account/);
  });
});

describe("assignment", () => {
  const PEOPLE: Person[] = [ADA, BOB, CAROL];
  let assignees: Record<string, Person | null>;
  let failNextWrite: boolean;

  function routeIssues(viewer: unknown = ADA) {
    const answers: Parameters<typeof route>[0] = { "GET /myself": () => json(viewer) };
    for (const key of Object.keys(assignees)) {
      answers[`GET /issue/${key}`] = () => json(node(key, { assignee: assignees[key] }));
      answers[`PUT /issue/id-${key}/assignee`] = (body) => {
        if (failNextWrite) {
          failNextWrite = false;
          return json({ errorMessages: ["That person cannot be assigned issues."] }, 400);
        }
        assignees[key] = PEOPLE.find((person) => person.accountId === body.accountId) ?? null;
        return new Response(null, { status: 204 });
      };
    }
    route(answers);
  }

  beforeEach(() => {
    assignees = { "ENG-12": BOB, "ENG-13": CAROL };
    failNextWrite = false;
    routeIssues();
  });

  const assign = (number = 12, username = "Ada Lovelace") =>
    jiraForgeProvider.assignIssue(REPO, number, username);
  const undo = (number = 12, username = "Ada Lovelace") =>
    jiraForgeProvider.unassignIssue(REPO, number, username);

  function writes() {
    return requests()
      .filter((request) => request.method === "PUT")
      .map((request) => ({ path: request.path, body: request.body }));
  }

  it("assigns the connected account, and Undo hands the issue back to who had it", async () => {
    await expect(assign()).resolves.toEqual([ADA_USER]);
    expect(assignees["ENG-12"]).toBe(ADA);
    await expect(undo()).resolves.toEqual([BOB_USER]);
    expect(assignees["ENG-12"]).toBe(BOB);
    expect(writes()).toEqual([
      { path: "/issue/id-ENG-12/assignee", body: { accountId: "acc-ada" } },
      { path: "/issue/id-ENG-12/assignee", body: { accountId: "acc-bob" } },
    ]);
  });

  it("leaves an issue that nobody had unassigned again on Undo", async () => {
    assignees["ENG-12"] = null;
    await assign();
    await expect(undo()).resolves.toEqual([]);
    expect(assignees["ENG-12"]).toBeNull();
    expect(writes().map((write) => write.body)).toEqual([
      { accountId: "acc-ada" },
      { accountId: null },
    ]);
  });

  it("leaves an issue that was already the viewer's alone, and its Undo too", async () => {
    assignees["ENG-12"] = ADA;
    await expect(assign()).resolves.toEqual([ADA_USER]);
    await expect(undo()).resolves.toEqual([ADA_USER]);
    expect(assignees["ENG-12"]).toBe(ADA);
    expect(writes()).toEqual([]);
  });

  it("keeps each worktree's Undo when two are made from one issue", async () => {
    await assign();
    // The second finds the issue already the viewer's.
    await assign();
    await expect(undo()).resolves.toEqual([ADA_USER]);
    expect(assignees["ENG-12"]).toBe(ADA);
    await expect(undo()).resolves.toEqual([BOB_USER]);
    expect(assignees["ENG-12"]).toBe(BOB);
    expect(writes().map((write) => write.body)).toEqual([
      { accountId: "acc-ada" },
      { accountId: "acc-bob" },
    ]);
  });

  it("remembers each issue's previous assignee separately", async () => {
    await assign(12);
    await assign(13);
    await expect(undo(12)).resolves.toEqual([BOB_USER]);
    await expect(undo(13)).resolves.toEqual([CAROL_USER]);
    expect(assignees).toEqual({ "ENG-12": BOB, "ENG-13": CAROL });
  });

  it("doesn't undo over someone who has taken the issue since", async () => {
    await assign();
    assignees["ENG-12"] = CAROL;
    await expect(undo()).resolves.toEqual([CAROL_USER]);
    expect(assignees["ENG-12"]).toBe(CAROL);
    expect(writes()).toHaveLength(1);
  });

  it("takes the issue off the viewer when there's nobody to hand it back to", async () => {
    assignees["ENG-12"] = ADA;
    await expect(undo()).resolves.toEqual([]);
    expect(assignees["ENG-12"]).toBeNull();
  });

  it("remembers nothing from an assignment Jira refused", async () => {
    failNextWrite = true;
    await expect(assign()).rejects.toThrow(/cannot be assigned/);
    expect(assignees["ENG-12"]).toBe(BOB);
    // Assigned in Jira instead: an unassign now only takes it off the viewer.
    assignees["ENG-12"] = ADA;
    await expect(undo()).resolves.toEqual([]);
    expect(assignees["ENG-12"]).toBeNull();
  });

  it("still knows who to hand the issue back to after a failed Undo", async () => {
    await assign();
    failNextWrite = true;
    await expect(undo()).rejects.toThrow(/cannot be assigned/);
    expect(assignees["ENG-12"]).toBe(ADA);
    await expect(undo()).resolves.toEqual([BOB_USER]);
    expect(assignees["ENG-12"]).toBe(BOB);
  });

  it("doesn't carry what it remembers over to a new token", async () => {
    await assign();
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "token-2" });
    await expect(undo()).resolves.toEqual([]);
    expect(assignees["ENG-12"]).toBeNull();
  });

  it("doesn't carry what it remembers over to another site or email", async () => {
    await assign();
    // Nothing is cleared: only the connection the history was kept for changes.
    settings = { siteUrl: SITE, email: "ada@work.example" };
    await expect(undo()).resolves.toEqual([]);
    expect(assignees["ENG-12"]).toBeNull();
  });

  it("knows the viewer by account id too", async () => {
    await expect(assign(12, "acc-ada")).resolves.toEqual([ADA_USER]);
  });

  it("refuses to assign anyone but the connected account", async () => {
    await expect(assign(12, "Bob Jones")).rejects.toThrow(/only be assigned to you/);
    await expect(undo(12, "acc-bob")).rejects.toThrow(/only be assigned to you/);
    expect(writes()).toEqual([]);
  });

  it("assigns nobody when Jira names no account", async () => {
    routeIssues({ displayName: "Ada Lovelace" });
    await expect(assign()).rejects.toThrow(/didn't recognize this account/);
    expect(writes()).toEqual([]);
  });

  it("refuses an issue Jira doesn't have, or one that has moved away", async () => {
    route({ "GET /myself": () => json(ADA), "GET /issue/ENG-12": () => json({}, 404) });
    await expect(assign()).rejects.toThrow("Jira issue ENG-12 wasn't found");
    route({ "GET /myself": () => json(ADA), "GET /issue/ENG-12": () => json(node("OPS-3")) });
    await expect(undo()).rejects.toThrow("Jira issue ENG-12 wasn't found");
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

  function comment(id: string, author: Person, text: string, created: string) {
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
      "GET /issue/ENG-12": () => json(node("ENG-12")),
      "GET /issue/id-ENG-12/comment": () =>
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
      "GET /issue/ENG-12": () => json(node("ENG-12")),
      "GET /issue/id-ENG-12/comment": () => {
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

  it("moves on from where Jira says the page started, by what it returned", async () => {
    route({
      "GET /issue/ENG-12": () => json(node("ENG-12")),
      "GET /issue/id-ENG-12/comment": () =>
        json({
          startAt: 5,
          total: 50,
          comments: [
            comment("10005", ADA, "f", "2026-10-03T10:00:00.000+0000"),
            comment("10006", BOB, "g", "2026-10-03T11:00:00.000+0000"),
          ],
        }),
    });
    await expect(list()).resolves.toMatchObject({ nextCursor: "7", hasMore: true });
  });

  it("goes by the page size Jira used when it gives no total", async () => {
    const page = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        comment(`2${i}`, ADA, `c${i}`, "2026-10-03T10:00:00.000+0000")
      );
    let answer: unknown;
    route({
      "GET /issue/ENG-12": () => json(node("ENG-12")),
      "GET /issue/id-ENG-12/comment": () => json(answer),
    });
    // Asked for 100, given Jira's own 50: a full page of its size means more.
    answer = { startAt: 0, maxResults: 50, comments: page(50) };
    await expect(list({ perPage: 100 })).resolves.toMatchObject({
      nextCursor: "50",
      hasMore: true,
    });
    answer = { startAt: 50, maxResults: 50, comments: page(10) };
    await expect(list({ perPage: 100, cursor: "50" })).resolves.toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    // Nothing about the page at all: the request is all there is to go by.
    answer = { comments: page(3) };
    await expect(list({ perPage: 3, cursor: "6" })).resolves.toMatchObject({
      nextCursor: "9",
      hasMore: true,
    });
    answer = {};
    await expect(list({ cursor: "9" })).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("stops at an empty page whatever the total says", async () => {
    route({
      "GET /issue/ENG-12": () => json(node("ENG-12")),
      "GET /issue/id-ENG-12/comment": () => json({ startAt: 4, total: 9, comments: [] }),
    });
    await expect(list({ cursor: "4" })).resolves.toMatchObject({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("reads a thread nobody has commented on as an empty page", async () => {
    route({
      "GET /issue/ENG-12": () => json(node("ENG-12")),
      "GET /issue/id-ENG-12/comment": () => json({ startAt: 0, total: 0, comments: [] }),
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
      "GET /issue/ENG-12": () => json(node("ENG-12")),
      "GET /issue/id-ENG-12/comment": () => json({ startAt: 0, total: 0, comments: [] }),
    });
    for (const perPage of [500, 0, 2.9, Number.NaN, Infinity, -Infinity]) {
      await list({ perPage });
    }
    expect(commentRequests().map((url) => url.searchParams.get("maxResults"))).toEqual([
      "100",
      "1",
      "2",
      "20",
      "20",
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
    route({ "GET /issue/ENG-12": () => json({}, 404) });
    await expect(list()).rejects.toThrow("Jira issue ENG-12 wasn't found");
    expect(commentRequests()).toEqual([]);
  });

  it("refuses an issue that has moved to another project", async () => {
    route({ "GET /issue/ENG-12": () => json(node("OPS-3")) });
    await expect(list()).rejects.toThrow("Jira issue ENG-12 wasn't found");
    expect(commentRequests()).toEqual([]);
  });

  it("links comments by the key Jira answered with, after a project rename", async () => {
    route({
      "GET /issue/ENG-12": () => json(node("CORE-12")),
      "GET /issue/id-CORE-12/comment": () =>
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
