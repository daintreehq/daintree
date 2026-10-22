import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RepoRef } from "../../../../../shared/types/forge.js";
import {
  clearLinearCaches,
  linearForgeProvider,
  normalizeTeamKey,
  setTeamKeyReader,
} from "../forgeProvider.js";
import { LinearApiError, linearGraphQL, setMemoryToken } from "../LinearClient.js";

const REPO: RepoRef = {
  host: "linear.app",
  owner: "acme",
  repo: "ENG",
  rawData: { teamId: "team-uuid" },
};

const VIEWER = {
  id: "user-1",
  name: "Ada Lovelace",
  displayName: "ada",
  avatarUrl: "https://avatars.example/ada.png",
  organization: { urlKey: "acme" },
};

function issueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-uuid-42",
    identifier: "ENG-42",
    number: 42,
    title: "Fix the thing",
    description: "Body",
    url: "https://linear.app/acme/issue/ENG-42/fix-the-thing",
    branchName: "ada/eng-42-fix-the-thing",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    state: { name: "In Progress", type: "started" },
    assignee: null,
    creator: { id: "user-2", name: "Grace", displayName: "grace", avatarUrl: null },
    labels: { nodes: [{ name: "bug", color: "#eb5757" }] },
    ...overrides,
  };
}

function gql(data: unknown, init?: { status?: number; errors?: unknown[] }) {
  return new Response(JSON.stringify(init?.errors ? { errors: init.errors } : { data }), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

function body(callIndex: number): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String((fetchMock().mock.calls[callIndex][1] as RequestInit).body));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  setMemoryToken("lin_api_secret");
  clearLinearCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMemoryToken(null);
  setTeamKeyReader(null);
  clearLinearCaches();
});

describe("linearGraphQL", () => {
  it("sends a personal API key bare, not as a Bearer token", async () => {
    fetchMock().mockResolvedValueOnce(gql({ viewer: VIEWER }));
    await linearGraphQL("query { viewer { id } }");
    const headers = (fetchMock().mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("lin_api_secret");
  });

  it("treats a 200 carrying GraphQL errors as a failure", async () => {
    fetchMock().mockResolvedValueOnce(
      gql(null, { errors: [{ message: "Entity not found", extensions: { code: "NOT_FOUND" } }] })
    );
    await expect(linearGraphQL("query { x }")).rejects.toMatchObject({
      message: "Entity not found",
      kind: "not_found",
      credentialRejected: false,
    });
  });

  it("flags a rejected key so callers can tell it from a failed request", async () => {
    fetchMock().mockResolvedValueOnce(
      gql(null, {
        status: 401,
        errors: [
          { message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } },
        ],
      })
    );
    await expect(linearGraphQL("query { x }")).rejects.toMatchObject({ credentialRejected: true });
  });

  it("names a rate limit", async () => {
    fetchMock().mockResolvedValueOnce(
      gql(null, {
        status: 400,
        errors: [{ message: "Rate limit", extensions: { code: "RATELIMITED" } }],
      })
    );
    await expect(linearGraphQL("query { x }")).rejects.toMatchObject({ kind: "ratelimited" });
  });

  it("refuses to send anything without a key", async () => {
    setMemoryToken(null);
    await expect(linearGraphQL("query { x }")).rejects.toBeInstanceOf(LinearApiError);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("resolveIssueRepo", () => {
  it("returns null until the project names a team", async () => {
    setTeamKeyReader(async () => undefined);
    await expect(linearForgeProvider.resolveIssueRepo!("/projects/app")).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("reads the team key for the project it was asked about", async () => {
    const reader = vi.fn(async () => " eng ");
    setTeamKeyReader(reader);
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }));

    const repo = await linearForgeProvider.resolveIssueRepo!("/projects/app");

    expect(reader).toHaveBeenCalledWith("/projects/app");
    expect(repo).toEqual({
      host: "linear.app",
      owner: "acme",
      repo: "ENG",
      rawData: { teamId: "team-uuid" },
    });
    expect(body(1).variables).toEqual({ key: "ENG" });
  });

  it("says which key is wrong when the workspace has no such team", async () => {
    setTeamKeyReader(async () => "NOPE");
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ teams: { nodes: [] } }));
    await expect(linearForgeProvider.resolveIssueRepo!("/projects/app")).rejects.toThrow(/NOPE/);
  });
});

describe("normalizeTeamKey", () => {
  it.each([
    ["eng", "ENG"],
    [" Eng2 ", "ENG2"],
    ["", null],
    ["ENG-1", null],
    ["1ENG", null],
    [42, null],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeTeamKey(input)).toBe(expected);
  });
});

describe("listIssues", () => {
  it("filters the open set by team and maps Linear's identifiers onto the issue", async () => {
    fetchMock().mockResolvedValueOnce(
      gql({
        issues: { nodes: [issueNode()], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } },
      })
    );

    const page = await linearForgeProvider.listIssues(REPO, { state: "open" });

    const { variables } = body(0);
    expect(variables.filter).toEqual({
      team: { key: { eq: "ENG" } },
      state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    });
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({
      number: 42,
      id: "issue-uuid-42",
      key: "ENG-42",
      branchName: "ada/eng-42-fix-the-thing",
      state: "open",
      rawState: "In Progress",
      labels: [{ name: "bug", color: "eb5757" }],
      author: { login: "grace" },
    });
  });

  it("asks for the closed state types when listing closed issues", async () => {
    fetchMock().mockResolvedValueOnce(
      gql({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
    );
    await linearForgeProvider.listIssues(REPO, { state: "closed" });
    expect(body(0).variables.filter).toMatchObject({
      state: { type: { in: ["completed", "canceled", "duplicate"] } },
    });
  });

  it("matches a search by title, and by number when it reads as one", async () => {
    fetchMock().mockResolvedValueOnce(
      gql({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
    );
    await linearForgeProvider.listIssues(REPO, { state: "all", search: "eng-42" });
    const filter = body(0).variables.filter as Record<string, unknown>;
    expect(filter.state).toBeUndefined();
    expect(filter.or).toEqual([
      { title: { containsIgnoreCase: "eng-42" } },
      { number: { eq: 42 } },
    ]);
  });
});

describe("issue lookups", () => {
  it("finds an issue by team and number", async () => {
    fetchMock().mockResolvedValueOnce(gql({ issues: { nodes: [issueNode()] } }));
    const issue = await linearForgeProvider.getIssue(REPO, 42);
    expect(issue?.key).toBe("ENG-42");
    expect(body(0).variables.filter).toEqual({
      team: { key: { eq: "ENG" } },
      number: { eq: 42 },
    });
  });

  it("answers an unknown id with null rather than an error", async () => {
    fetchMock().mockResolvedValueOnce(
      gql(null, { errors: [{ message: "Entity not found", extensions: { code: "NOT_FOUND" } }] })
    );
    await expect(linearForgeProvider.getIssueById!(REPO, "gone")).resolves.toBeNull();
  });

  it("still surfaces a rejected key from an id lookup", async () => {
    fetchMock().mockResolvedValueOnce(gql(null, { status: 401, errors: [{ message: "nope" }] }));
    await expect(linearForgeProvider.getIssueById!(REPO, "issue-uuid-42")).rejects.toMatchObject({
      credentialRejected: true,
    });
  });

  it("claims branches carrying the project's team key", async () => {
    await expect(linearForgeProvider.getIssueBranchKeys!(REPO)).resolves.toEqual(["ENG"]);
  });
});

describe("URLs", () => {
  it("builds issue and team links in the workspace", () => {
    expect(linearForgeProvider.buildIssueUrl(REPO, 42)).toBe(
      "https://linear.app/acme/issue/ENG-42"
    );
    expect(linearForgeProvider.buildIssuesUrl(REPO)).toBe("https://linear.app/acme/team/ENG/all");
  });
});

describe("assignment", () => {
  it("assigns the viewer by their user id", async () => {
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode()] } }))
      .mockResolvedValueOnce(gql({ issueUpdate: { success: true, issue: { assignee: VIEWER } } }));

    const assignees = await linearForgeProvider.assignIssue(REPO, 42, "ada");

    expect(body(2).variables).toEqual({ id: "issue-uuid-42", input: { assigneeId: "user-1" } });
    expect(assignees).toEqual([
      { login: "ada", avatarUrl: VIEWER.avatarUrl, rawData: { id: "user-1" } },
    ]);
  });

  it("refuses to assign anyone but the viewer", async () => {
    fetchMock().mockResolvedValueOnce(gql({ viewer: VIEWER }));
    await expect(linearForgeProvider.assignIssue(REPO, 42, "someone-else")).rejects.toThrow(
      /only be assigned to you/
    );
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("unassigns the viewer", async () => {
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode({ assignee: VIEWER })] } }))
      .mockResolvedValueOnce(gql({ issueUpdate: { success: true, issue: { assignee: null } } }));

    await expect(linearForgeProvider.unassignIssue(REPO, 42, "ada")).resolves.toEqual([]);
    expect(body(2).variables).toEqual({ id: "issue-uuid-42", input: { assigneeId: null } });
  });

  it("leaves an issue alone when someone else has taken it since", async () => {
    const other = { id: "user-9", name: "Lin", displayName: "lin", avatarUrl: null };
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode({ assignee: other })] } }));

    const assignees = await linearForgeProvider.unassignIssue(REPO, 42, "ada");

    expect(assignees.map((a) => a.login)).toEqual(["lin"]);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });
});

describe("unsupported writes", () => {
  it.each([
    ["createIssue", () => linearForgeProvider.createIssue(REPO, { title: "x" })],
    ["closeIssue", () => linearForgeProvider.closeIssue(REPO, 42)],
    ["reopenIssue", () => linearForgeProvider.reopenIssue(REPO, 42)],
    ["editIssue", () => linearForgeProvider.editIssue(REPO, 42, { title: "x" })],
    ["addIssueComment", () => linearForgeProvider.addIssueComment(REPO, 42, "x")],
    ["addIssueLabel", () => linearForgeProvider.addIssueLabel(REPO, 42, "x")],
    ["removeIssueLabel", () => linearForgeProvider.removeIssueLabel(REPO, 42, "x")],
  ])("%s rejects with a clear error and never calls Linear", async (_name, call) => {
    await expect(call()).rejects.toThrow(/isn't supported for Linear issues yet/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("credentials", () => {
  it("validates a freshly entered key against that key, not the stored one", async () => {
    fetchMock().mockResolvedValueOnce(gql({ viewer: VIEWER }));
    await expect(linearForgeProvider.validateToken(" lin_api_new ")).resolves.toEqual({
      valid: true,
      account: "ada",
    });
    const headers = (fetchMock().mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("lin_api_new");
  });

  it("reports a rejected key as invalid instead of throwing", async () => {
    fetchMock().mockResolvedValueOnce(gql(null, { status: 401, errors: [{ message: "nope" }] }));
    await expect(linearForgeProvider.validateCredentials()).resolves.toMatchObject({
      valid: false,
    });
  });

  it("drops the cached viewer when the key changes", async () => {
    fetchMock().mockImplementation(async () => gql({ viewer: VIEWER }));
    await linearForgeProvider.identity!.getCurrentUser();
    await linearForgeProvider.identity!.getCurrentUser();
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    linearForgeProvider.setCredentials!({ kind: "bearer", value: "lin_api_other" });
    await linearForgeProvider.identity!.getCurrentUser();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("has no identity without a key", async () => {
    linearForgeProvider.setCredentials!(null);
    await expect(linearForgeProvider.identity!.getCurrentUser()).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("repoStats", () => {
  function idPage(count: number, hasNextPage: boolean, endCursor: string | null = null) {
    return gql({
      issues: {
        nodes: Array.from({ length: count }, (_, i) => ({ id: `id-${i}` })),
        pageInfo: { hasNextPage, endCursor },
      },
    });
  }

  it("counts the open set across pages rather than reporting a page length", async () => {
    fetchMock()
      .mockResolvedValueOnce(idPage(250, true, "c1"))
      .mockResolvedValueOnce(idPage(17, false));

    const snapshot = await linearForgeProvider.repoStats!.getRepoStats(REPO);

    expect(snapshot.counts.issueCount).toBe(267);
    expect(snapshot.counts.prCount).toBeNull();
    expect(snapshot.source).toBe("network");
    expect(body(1).variables).toMatchObject({ after: "c1", first: 250 });
    expect(body(0).variables.filter).toMatchObject({
      state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    });
  });

  it("reports an unknown count for a team too large to page through", async () => {
    fetchMock().mockImplementation(async () => idPage(250, true, "next"));
    const snapshot = await linearForgeProvider.repoStats!.getRepoStats(REPO);
    expect(snapshot.counts.issueCount).toBeNull();
    expect(fetchMock()).toHaveBeenCalledTimes(8);
  });

  it("serves a recent count from memory until asked to bypass it", async () => {
    fetchMock().mockImplementation(async () => idPage(3, false));
    await linearForgeProvider.repoStats!.getRepoStats(REPO);
    const cached = await linearForgeProvider.repoStats!.getRepoStats(REPO);
    expect(cached).toMatchObject({ source: "memory-cache", counts: { issueCount: 3 } });
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    await linearForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("counts again once the key changes", async () => {
    fetchMock().mockImplementation(async () => idPage(3, false));
    await linearForgeProvider.repoStats!.getRepoStats(REPO);
    linearForgeProvider.setCredentials!({ kind: "bearer", value: "lin_api_other" });
    await linearForgeProvider.repoStats!.getRepoStats(REPO);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });
});

describe("assignment Undo", () => {
  const GRACE = { id: "user-2", name: "Grace", displayName: "grace", avatarUrl: null };

  it("hands an issue back to whoever 'Assign to me' took it from", async () => {
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode({ assignee: GRACE })] } }))
      .mockResolvedValueOnce(gql({ issueUpdate: { success: true, issue: { assignee: VIEWER } } }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode({ assignee: VIEWER })] } }))
      .mockResolvedValueOnce(gql({ issueUpdate: { success: true, issue: { assignee: GRACE } } }));

    await linearForgeProvider.assignIssue(REPO, 42, "ada");
    const assignees = await linearForgeProvider.unassignIssue(REPO, 42, "ada");

    expect(body(4).variables).toEqual({ id: "issue-uuid-42", input: { assigneeId: "user-2" } });
    expect(assignees.map((a) => a.login)).toEqual(["grace"]);
  });

  it("doesn't rewrite an issue the viewer already holds", async () => {
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode({ assignee: VIEWER })] } }));
    const assignees = await linearForgeProvider.assignIssue(REPO, 42, "ada");
    expect(assignees.map((a) => a.login)).toEqual(["ada"]);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("leaves an issue the viewer already held when that no-op assignment is undone", async () => {
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode({ assignee: VIEWER })] } }))
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode({ assignee: VIEWER })] } }));

    await linearForgeProvider.assignIssue(REPO, 42, "ada");
    const assignees = await linearForgeProvider.unassignIssue(REPO, 42, "ada");

    expect(assignees.map((a) => a.login)).toEqual(["ada"]);
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });

  it("keeps every request of one assignment on the key it started with", async () => {
    fetchMock()
      .mockImplementationOnce(async () => {
        // The key changes while the operation is under way.
        linearForgeProvider.setCredentials!({ kind: "bearer", value: "lin_api_other" });
        return gql({ viewer: VIEWER });
      })
      .mockResolvedValueOnce(gql({ issues: { nodes: [issueNode()] } }))
      .mockResolvedValueOnce(gql({ issueUpdate: { success: true, issue: { assignee: VIEWER } } }));

    await linearForgeProvider.assignIssue(REPO, 42, "ada");

    const keys = fetchMock().mock.calls.map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>).Authorization
    );
    expect(keys).toEqual(["lin_api_secret", "lin_api_secret", "lin_api_secret"]);
  });
});

describe("search scoping", () => {
  it("doesn't read another team's key as this team's number", async () => {
    fetchMock().mockResolvedValueOnce(
      gql({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
    );
    await linearForgeProvider.listIssues(REPO, { search: "DES-42" });
    expect((body(0).variables.filter as Record<string, unknown>).or).toEqual([
      { title: { containsIgnoreCase: "DES-42" } },
    ]);
  });
});

describe("team resolution", () => {
  it("looks the team up once per key", async () => {
    setTeamKeyReader(async () => "ENG");
    fetchMock()
      .mockResolvedValueOnce(gql({ viewer: VIEWER }))
      .mockResolvedValueOnce(gql({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }));
    await linearForgeProvider.resolveIssueRepo!("/projects/app");
    await linearForgeProvider.resolveIssueRepo!("/projects/app");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });
});
