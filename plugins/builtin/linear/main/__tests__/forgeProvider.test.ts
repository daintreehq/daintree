import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ListOptions, RepoRef } from "../../../../../shared/types/forge.js";
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

  describe("ordering", () => {
    // Created order is 3, 2, 1 and updated order is 1, 3, 2, so a page in the
    // wrong order can't pass for the right one.
    const ISSUES = [
      issueNode({
        id: "i1",
        number: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
      }),
      issueNode({
        id: "i2",
        number: 2,
        createdAt: "2026-10-05T00:00:00.000Z",
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      issueNode({
        id: "i3",
        number: 3,
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
    ];

    /** Answers like Linear: the whole collection ordered by `orderBy`, newest first, cursor-paged. */
    function serveOrderedIssues(): void {
      fetchMock().mockImplementation(async (_url: string, init: RequestInit) => {
        const { variables } = JSON.parse(String(init.body)) as {
          variables: { first: number; after: string | null; orderBy: "createdAt" | "updatedAt" };
        };
        const ordered = [...ISSUES].sort((a, b) =>
          String(b[variables.orderBy]).localeCompare(String(a[variables.orderBy]))
        );
        let start = 0;
        if (variables.after !== null) {
          const at = ordered.findIndex((n) => `cursor:${n.id}` === variables.after);
          if (at < 0) return gql(null, { errors: [{ message: "Invalid cursor" }] });
          start = at + 1;
        }
        const nodes = ordered.slice(start, start + variables.first);
        const hasNextPage = start + variables.first < ordered.length;
        const endCursor = nodes.length > 0 ? `cursor:${nodes[nodes.length - 1].id}` : null;
        return gql({ issues: { nodes, pageInfo: { hasNextPage, endCursor } } });
      });
    }

    async function listTwoPages(opts: Pick<ListOptions, "sort" | "direction">) {
      const first = await linearForgeProvider.listIssues(REPO, { ...opts, perPage: 2 });
      expect(first.hasMore).toBe(true);
      const second = await linearForgeProvider.listIssues(REPO, {
        ...opts,
        perPage: 2,
        cursor: first.nextCursor,
      });
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
      return [...first.items, ...second.items].map((issue) => issue.number);
    }

    it("orders the whole collection by creation for sort created", async () => {
      serveOrderedIssues();
      expect(await listTwoPages({ sort: "created", direction: "desc" })).toEqual([3, 2, 1]);
      // The mock orders and pages by the variables, so the query has to actually apply them.
      expect(body(0).query).toMatch(/\$orderBy: PaginationOrderBy!/);
      expect(body(0).query).toMatch(/orderBy: \$orderBy\b/);
      expect(body(0).query).toMatch(/after: \$after\b/);
      expect(body(0).variables).toMatchObject({ orderBy: "createdAt", after: null });
      expect(body(1).variables).toMatchObject({ orderBy: "createdAt", after: "cursor:i2" });
    });

    it("orders the whole collection by last update for sort updated", async () => {
      serveOrderedIssues();
      expect(await listTwoPages({ sort: "updated" })).toEqual([1, 3, 2]);
      expect(body(0).variables.orderBy).toBe("updatedAt");
      expect(body(1).variables).toMatchObject({ orderBy: "updatedAt", after: "cursor:i3" });
    });

    it("orders by creation when no sort is given, as the action documents", async () => {
      serveOrderedIssues();
      expect(await listTwoPages({})).toEqual([3, 2, 1]);
      expect(body(0).variables.orderBy).toBe("createdAt");
    });

    it.each(["asc", "sideways"])(
      "refuses direction %j by name instead of answering newest first",
      async (direction) => {
        serveOrderedIssues();
        await expect(
          linearForgeProvider.listIssues(REPO, {
            sort: "created",
            direction: direction as ListOptions["direction"],
          })
        ).rejects.toThrow(`direction "${direction}"`);
        expect(fetchMock()).not.toHaveBeenCalled();
      }
    );

    it("refuses a sort field Linear can't order by", async () => {
      serveOrderedIssues();
      await expect(linearForgeProvider.listIssues(REPO, { sort: "comments" })).rejects.toThrow(
        /sort issues by "comments"/
      );
      expect(fetchMock()).not.toHaveBeenCalled();
    });
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

  describe("concurrent counts", () => {
    /** Each request waits until the test answers it, in the order they were sent. */
    function heldPages() {
      const pending: Array<(response: Response) => void> = [];
      fetchMock().mockImplementation(
        () => new Promise<Response>((resolve) => pending.push(resolve))
      );
      return {
        async answer(index: number, response: Response) {
          await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
          pending[index](response);
        },
      };
    }

    it("shares one page sequence between simultaneous reads of one team", async () => {
      const pages = heldPages();
      const reads = Array.from({ length: 8 }, () =>
        linearForgeProvider.repoStats!.getRepoStats(REPO)
      );
      await pages.answer(0, idPage(250, true, "c1"));
      await pages.answer(1, idPage(4, false));

      const snapshots = await Promise.all(reads);

      expect(snapshots.map((s) => s.counts.issueCount)).toEqual(Array(8).fill(254));
      expect(fetchMock()).toHaveBeenCalledTimes(2);
      expect(body(1).variables).toMatchObject({ after: "c1" });
    });

    it("counts each team on its own", async () => {
      fetchMock().mockImplementation(async () => idPage(3, false));
      await Promise.all([
        linearForgeProvider.repoStats!.getRepoStats(REPO),
        linearForgeProvider.repoStats!.getRepoStats({ ...REPO, repo: "DES" }),
      ]);
      expect(fetchMock()).toHaveBeenCalledTimes(2);
      const teamOf = (i: number) =>
        (body(i).variables.filter as { team: { key: { eq: string } } }).team.key.eq;
      expect([teamOf(0), teamOf(1)].sort()).toEqual(["DES", "ENG"]);
    });

    it("doesn't hand a new key's read the old key's count", async () => {
      const pages = heldPages();
      const oldRead = linearForgeProvider.repoStats!.getRepoStats(REPO);
      await vi.waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
      linearForgeProvider.setCredentials!({ kind: "bearer", value: "lin_api_other" });
      const newRead = linearForgeProvider.repoStats!.getRepoStats(REPO);

      await pages.answer(1, idPage(9, false));
      await pages.answer(0, idPage(2, false));

      expect((await newRead).counts.issueCount).toBe(9);
      expect((await oldRead).counts.issueCount).toBe(2);
      const headers = (i: number) =>
        (fetchMock().mock.calls[i][1] as RequestInit).headers as Record<string, string>;
      expect(headers(1).Authorization).toBe("lin_api_other");
      const cached = await linearForgeProvider.repoStats!.getRepoStats(REPO);
      expect(cached).toMatchObject({ source: "memory-cache", counts: { issueCount: 9 } });
    });

    it("fails every read sharing a failed count, and counts afresh on the next", async () => {
      const pages = heldPages();
      const reads = [
        linearForgeProvider.repoStats!.getRepoStats(REPO),
        linearForgeProvider.repoStats!.getRepoStats(REPO),
      ];
      await pages.answer(0, gql(null, { errors: [{ message: "Linear is down" }] }));
      for (const read of reads) await expect(read).rejects.toThrow("Linear is down");
      expect(fetchMock()).toHaveBeenCalledTimes(1);

      fetchMock().mockImplementation(async () => idPage(6, false));
      const retried = await linearForgeProvider.repoStats!.getRepoStats(REPO);
      expect(retried).toMatchObject({ source: "network", counts: { issueCount: 6 } });
      expect(fetchMock()).toHaveBeenCalledTimes(2);
    });

    it("starts a fresh count for a bypassing read even while one is under way", async () => {
      const pages = heldPages();
      const first = linearForgeProvider.repoStats!.getRepoStats(REPO);
      await vi.waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
      const refreshed = linearForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });

      await pages.answer(1, idPage(5, false));
      expect((await refreshed).counts.issueCount).toBe(5);
      await pages.answer(0, idPage(3, false));
      expect((await first).counts.issueCount).toBe(3);

      const cached = await linearForgeProvider.repoStats!.getRepoStats(REPO);
      expect(cached).toMatchObject({ source: "memory-cache", counts: { issueCount: 5 } });
      expect(fetchMock()).toHaveBeenCalledTimes(2);
    });

    it("joins a read to the refresh under way rather than the older count", async () => {
      const pages = heldPages();
      const first = linearForgeProvider.repoStats!.getRepoStats(REPO);
      await vi.waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
      const refreshed = linearForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
      await vi.waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
      const joined = linearForgeProvider.repoStats!.getRepoStats(REPO);

      await pages.answer(0, idPage(3, false));
      await pages.answer(1, idPage(5, false));

      expect((await first).counts.issueCount).toBe(3);
      expect((await refreshed).counts.issueCount).toBe(5);
      expect((await joined).counts.issueCount).toBe(5);
      expect(fetchMock()).toHaveBeenCalledTimes(2);
    });
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

describe("assignment Undo history", () => {
  const GRACE = { id: "user-2", name: "Grace", displayName: "grace", avatarUrl: null };
  const LIN = { id: "user-9", name: "Lin", displayName: "lin", avatarUrl: null };
  const CAROL = { id: "user-3", name: "Carol", displayName: "carol", avatarUrl: null };
  const USERS = [VIEWER, GRACE, LIN, CAROL];

  type User = { id: string; name: string; displayName: string; avatarUrl: string | null };
  type WriteFailure = "unavailable" | "refused" | "unsuccessful";
  const WRITE_FAILURES: WriteFailure[] = ["unavailable", "refused", "unsuccessful"];
  const WRITE_FAILURE_MESSAGES: Record<WriteFailure, RegExp> = {
    unavailable: /HTTP 503/,
    refused: /Assignee can't be set/,
    unsuccessful: /didn't update the issue's assignee/,
  };

  /** Each issue's assignee in Linear, by number. */
  let assignees: Record<number, User | null>;
  let failNextWrite: WriteFailure | null;
  /** Holds an issue's writes, by number, until the promise settles. */
  let writeGates: Record<number, Promise<void>>;
  /** Releases every gate a test opened, so a failed assertion can't leave the next test queued. */
  let releaseAll: Array<() => void>;
  let beforeRead: (() => void) | null;
  let reads: number[];
  let writes: Array<string | null>;

  function failedWrite(failure: WriteFailure): Response {
    if (failure === "unavailable") return new Response("", { status: 503 });
    if (failure === "refused") {
      return gql(null, {
        errors: [{ message: "Assignee can't be set", extensions: { code: "INVALID_INPUT" } }],
      });
    }
    return gql({ issueUpdate: { success: false, issue: null } });
  }

  beforeEach(() => {
    assignees = { 42: GRACE, 43: LIN };
    failNextWrite = null;
    writeGates = {};
    releaseAll = [];
    beforeRead = null;
    reads = [];
    writes = [];
    fetchMock().mockImplementation(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (query.includes("viewer {")) return gql({ viewer: VIEWER });
      if (query.includes("issueUpdate")) {
        const number = Number(String(variables.id).replace("issue-uuid-", ""));
        const assigneeId = (variables.input as { assigneeId: string | null }).assigneeId;
        const assignee = assigneeId === null ? null : USERS.find((user) => user.id === assigneeId);
        if (assignee === undefined) throw new Error(`Unknown assignee ${String(assigneeId)}`);
        writes.push(assigneeId);
        const gate = writeGates[number];
        if (gate) await gate;
        if (failNextWrite) {
          const failure = failNextWrite;
          failNextWrite = null;
          return failedWrite(failure);
        }
        assignees[number] = assignee;
        return gql({ issueUpdate: { success: true, issue: { assignee } } });
      }
      if (query.includes("issues(filter")) {
        const filter = variables.filter as { team: unknown; number: { eq: number } };
        expect(filter.team).toEqual({ key: { eq: "ENG" } });
        const number = filter.number.eq;
        reads.push(number);
        beforeRead?.();
        return gql({
          issues: {
            nodes: [
              issueNode({
                id: `issue-uuid-${number}`,
                identifier: `ENG-${number}`,
                number,
                assignee: assignees[number] ?? null,
              }),
            ],
          },
        });
      }
      throw new Error(`Unexpected query: ${query}`);
    });
  });

  const assign = (number = 42) => linearForgeProvider.assignIssue(REPO, number, "ada");
  const undo = async (number = 42) =>
    (await linearForgeProvider.unassignIssue(REPO, number, "ada")).map((user) => user.login);
  const rotateKey = () =>
    linearForgeProvider.setCredentials!({ kind: "bearer", value: "lin_api_other" });
  function hold(number = 42): () => void {
    let release: () => void = () => undefined;
    writeGates[number] = new Promise((resolve) => (release = resolve));
    const releaseGate = () => {
      delete writeGates[number];
      release();
    };
    releaseAll.push(releaseGate);
    return releaseGate;
  }

  afterEach(async () => {
    for (const release of releaseAll) release();
    // Let what they held finish while fetch is still the fake.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it.each(WRITE_FAILURES)(
    "still knows who to hand the issue back to after an Undo that came back %s",
    async (failure) => {
      await assign();
      failNextWrite = failure;
      await expect(undo()).rejects.toThrow(WRITE_FAILURE_MESSAGES[failure]);
      expect(assignees[42]).toBe(VIEWER);
      await expect(undo()).resolves.toEqual(["grace"]);
      expect(assignees[42]).toBe(GRACE);
      expect(writes).toEqual(["user-1", "user-2", "user-2"]);
      // That Undo is used up: taking the issue later only takes it off the viewer.
      assignees[42] = VIEWER;
      await expect(undo()).resolves.toEqual([]);
      expect(writes.at(-1)).toBeNull();
    }
  );

  it("leaves an issue someone took between a failed Undo and its retry", async () => {
    await assign();
    failNextWrite = "unavailable";
    await expect(undo()).rejects.toThrow(/HTTP 503/);
    assignees[42] = LIN;
    await expect(undo()).resolves.toEqual(["lin"]);
    expect(writes).toEqual(["user-1", "user-2"]);
  });

  it("keeps each worktree's Undo when two are made from one issue", async () => {
    await assign();
    // The second finds the issue already the viewer's.
    await assign();
    await expect(undo()).resolves.toEqual(["ada"]);
    expect(assignees[42]).toBe(VIEWER);
    await expect(undo()).resolves.toEqual(["grace"]);
    expect(assignees[42]).toBe(GRACE);
    expect(writes).toEqual(["user-1", "user-2"]);
  });

  it("leaves a later reassignment alone through every Undo", async () => {
    await assign();
    await assign();
    assignees[42] = LIN;
    await expect(undo()).resolves.toEqual(["lin"]);
    await expect(undo()).resolves.toEqual(["lin"]);
    expect(assignees[42]).toBe(LIN);
    expect(writes).toEqual(["user-1"]);
  });

  it("uses up only its own record when someone else has the issue", async () => {
    await assign();
    await assign();
    assignees[42] = LIN;
    await expect(undo()).resolves.toEqual(["lin"]);
    // Back with the viewer: the other worktree's Undo still knows who had it first.
    assignees[42] = VIEWER;
    await expect(undo()).resolves.toEqual(["grace"]);
    expect(assignees[42]).toBe(GRACE);
  });

  it("lets one assignment to an issue finish before another reads it", async () => {
    const release = hold();
    const first = assign();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const second = assign();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual([42]);
    release();
    await Promise.all([first, second]);
    expect(reads).toEqual([42, 42]);
    // The second found the issue already the viewer's, so its Undo writes nothing.
    await expect(undo()).resolves.toEqual(["ada"]);
    await expect(undo()).resolves.toEqual(["grace"]);
  });

  it("holds an Undo behind its issue's assignment, but not another issue's", async () => {
    const release = hold();
    const assigning = assign();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const undoing = undo();
    await assign(43);
    expect(reads).toEqual([42, 43]);
    release();
    await assigning;
    await expect(undoing).resolves.toEqual(["grace"]);
    expect(assignees).toEqual({ 42: GRACE, 43: VIEWER });
  });

  it("runs an Undo queued behind a failing one", async () => {
    await assign();
    const release = hold();
    failNextWrite = "unavailable";
    const failing = undo();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    const retry = undo();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual([42, 42]);
    release();
    await expect(failing).rejects.toThrow(/HTTP 503/);
    await expect(retry).resolves.toEqual(["grace"]);
  });

  it("keeps every Undo of many assignments, handing the issue back only at the last", async () => {
    for (let i = 0; i < 12; i++) await assign();
    for (let i = 0; i < 11; i++) await expect(undo()).resolves.toEqual(["ada"]);
    await expect(undo()).resolves.toEqual(["grace"]);
    expect(writes).toEqual(["user-1", "user-2"]);
  });

  it("goes back to who had the issue first after it changes hands many times", async () => {
    // Each round the viewer takes the issue and someone else takes it back.
    for (let i = 0; i < 12; i++) {
      await assign();
      assignees[42] = i % 2 ? CAROL : LIN;
    }
    const undone: string[][] = [];
    for (let i = 0; i < 10; i++) {
      assignees[42] = VIEWER;
      undone.push(await undo());
    }
    // Only the latest hand-overs are kept, and the first: Grace had it.
    expect(undone).toEqual([
      ...Array.from({ length: 9 }, (_, i) => (i % 2 ? ["carol"] : ["lin"])),
      ["grace"],
    ]);
    expect(assignees[42]).toBe(GRACE);
  });

  it.each(WRITE_FAILURES)(
    "remembers nothing from an assignment that came back %s",
    async (failure) => {
      failNextWrite = failure;
      await expect(assign()).rejects.toThrow(WRITE_FAILURE_MESSAGES[failure]);
      expect(assignees[42]).toBe(GRACE);
      // Assigned in Linear instead: an unassign now only takes it off the viewer.
      assignees[42] = VIEWER;
      await expect(undo()).resolves.toEqual([]);
      expect(assignees[42]).toBeNull();
    }
  );

  it("remembers each issue's previous assignee separately", async () => {
    await assign(42);
    await assign(43);
    await expect(undo(42)).resolves.toEqual(["grace"]);
    await expect(undo(43)).resolves.toEqual(["lin"]);
    expect(assignees).toEqual({ 42: GRACE, 43: LIN });
  });

  it("doesn't carry what it remembers over to a new key", async () => {
    await assign();
    rotateKey();
    await expect(undo()).resolves.toEqual([]);
    expect(assignees[42]).toBeNull();
  });

  it("refuses an Undo whose key changed under it rather than clearing the issue", async () => {
    await assign();
    beforeRead = () => {
      beforeRead = null;
      rotateKey();
    };
    await expect(undo()).rejects.toThrow(/key changed/);
    expect(assignees[42]).toBe(VIEWER);
    expect(writes).toEqual(["user-1"]);
  });

  it("lets an old key's Undo land before a new key's assignment reads the issue", async () => {
    await assign();
    const release = hold();
    const undoing = undo();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    rotateKey();
    await linearForgeProvider.identity!.getCurrentUser();
    const assigning = assign();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual([42, 42]);
    release();
    await expect(undoing).resolves.toEqual(["grace"]);
    await assigning;
    expect(assignees[42]).toBe(VIEWER);
    await expect(undo()).resolves.toEqual(["grace"]);
  });

  it("keeps no record from an old key's assignment that could push out the new key's", async () => {
    const release = hold(100);
    assignees[100] = GRACE;
    const stale = assign(100);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    rotateKey();
    for (let number = 1; number <= 50; number++) {
      assignees[number] = GRACE;
      await assign(number);
    }
    release();
    await stale;
    await expect(undo(1)).resolves.toEqual(["grace"]);
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
