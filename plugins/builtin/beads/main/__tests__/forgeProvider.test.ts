import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RepoRef } from "../../../../../shared/types/forge.js";
import { setMemoryToken } from "../BeadsClient.js";
import {
  beadsForgeProvider,
  clearBeadsCaches,
  setServerUrlSettingReader,
} from "../forgeProvider.js";
import { beadNumber } from "../issueNumbers.js";

const SERVER = "https://beads.example.com/dfat";

const REPO: RepoRef = {
  host: "beads.example.com",
  owner: SERVER,
  repo: "dfat",
  rawData: { serverUrl: SERVER, projectId: "proj-1" },
};

function bead(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Bead ${id}`,
    description: "Body",
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: "",
    created_by: "grace",
    labels: ["backend"],
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    dependency_count: 1,
    dependent_count: 0,
    comment_count: 3,
    ...overrides,
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

function page(items: unknown[], nextCursor?: string) {
  return json({ items, has_more: Boolean(nextCursor), ...(nextCursor ? { next_cursor: nextCursor } : {}) });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return json({ status, title: "Problem", code, request_id: "r", ...extra }, status);
}

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

function call(index: number): { url: URL; init: RequestInit; body: Record<string, unknown> | null } {
  const [url, init] = fetchMock().mock.calls[index] as [string, RequestInit];
  return {
    url: new URL(url),
    init,
    body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("BEADS_ACTOR", "ada");
  setMemoryToken("bd-token");
  clearBeadsCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setMemoryToken(null);
  setServerUrlSettingReader(null);
  clearBeadsCaches();
});

describe("requests", () => {
  it("sends the token as a bearer and appends routes under a mount prefix", async () => {
    fetchMock().mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {});
    const { url, init } = call(0);
    expect(url.pathname).toBe("/dfat/v0/beads/issues");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer bd-token");
    expect(init.redirect).toBe("error");
  });

  it("sends no Authorization header when no token is saved", async () => {
    setMemoryToken(null);
    fetchMock().mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {});
    expect((call(0).init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("names a refused token, and a refused Host header, by their Problem codes", async () => {
    fetchMock().mockResolvedValueOnce(problem(401, "unauthenticated"));
    await expect(beadsForgeProvider.listIssues(REPO, {})).rejects.toMatchObject({
      credentialRejected: true,
      message: "The Beads server rejected the token",
    });
    fetchMock().mockResolvedValueOnce(problem(400, "invalid_argument", { param: "Host" }));
    await expect(beadsForgeProvider.listIssues(REPO, {})).rejects.toThrow(/--allowed-host/);
  });
});

describe("listIssues", () => {
  it("maps beads with the id as key, a bead/ branch, an empty url and a derived number", async () => {
    fetchMock().mockResolvedValueOnce(page([bead("dfat-39kl", { assignee: "ada" })], "c2"));
    const result = await beadsForgeProvider.listIssues(REPO, {});
    const issue = result.items[0];
    expect(issue).toMatchObject({
      number: beadNumber("dfat-39kl"),
      id: "dfat-39kl",
      key: "dfat-39kl",
      branchName: "bead/dfat-39kl",
      url: "",
      state: "open",
      rawState: "open",
      commentCount: 3,
      labels: [{ name: "backend" }],
      assignees: [{ login: "ada" }],
      author: { login: "grace" },
    });
    expect((issue.rawData as { priority: number }).priority).toBe(2);
    expect(result).toMatchObject({ nextCursor: "c2", hasMore: true });
  });

  it("reads the open set as bd list's default, and passes filters and search natively", async () => {
    fetchMock().mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {
      search: " dfat-39kl ",
      labels: ["a", "b"],
      assignee: "ada",
      perPage: 500,
      cursor: "c1",
    });
    const params = call(0).url.searchParams;
    expect(params.has("status")).toBe(false);
    expect(params.has("all")).toBe(false);
    expect(params.get("q")).toBe("dfat-39kl");
    expect(params.getAll("label")).toEqual(["a", "b"]);
    expect(params.get("assignee")).toBe("ada");
    expect(params.get("limit")).toBe("100");
    expect(params.get("cursor")).toBe("c1");
  });

  it("asks for closed and all states by their own parameters", async () => {
    fetchMock().mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, { state: "closed" });
    await beadsForgeProvider.listIssues(REPO, { state: "all" });
    expect(call(0).url.searchParams.get("status")).toBe("closed");
    expect(call(1).url.searchParams.get("all")).toBe("true");
  });

  it("refuses orders bd serve can't page in, without a request", async () => {
    await expect(beadsForgeProvider.listIssues(REPO, { sort: "updated" })).rejects.toThrow(
      /can't sort issues by "updated"/
    );
    await expect(beadsForgeProvider.listIssues(REPO, { direction: "asc" })).rejects.toThrow(
      /newest first only/
    );
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("numbers", () => {
  it("resolves a number seen in a list straight to its bead", async () => {
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-39kl")]))
      .mockResolvedValueOnce(json(bead("dfat-39kl", { revision: "r1" })));
    await beadsForgeProvider.listIssues(REPO, {});
    const issue = await beadsForgeProvider.getIssue(REPO, beadNumber("dfat-39kl"));
    expect(issue?.key).toBe("dfat-39kl");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(call(1).url.pathname).toBe("/dfat/v0/beads/issues/dfat-39kl");
  });

  it("relists every status, page by page, for a number it hasn't seen", async () => {
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-aaaa")], "next"))
      .mockResolvedValueOnce(page([bead("dfat-39kl", { status: "closed" })]))
      .mockResolvedValueOnce(json(bead("dfat-39kl", { status: "closed" })));
    const issue = await beadsForgeProvider.getIssue(REPO, beadNumber("dfat-39kl"));
    expect(issue?.state).toBe("closed");
    expect(call(0).url.searchParams.get("all")).toBe("true");
    expect(call(1).url.searchParams.get("cursor")).toBe("next");
  });

  it("answers null for a number no bead on the server has", async () => {
    fetchMock().mockResolvedValueOnce(page([bead("dfat-aaaa")]));
    await expect(beadsForgeProvider.getIssue(REPO, 12345)).resolves.toBeNull();
  });

  it("keeps numbers apart per server", async () => {
    const other: RepoRef = { ...REPO, owner: "https://other.example.com" };
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-39kl")]))
      .mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {});
    await expect(beadsForgeProvider.getIssue(other, beadNumber("dfat-39kl"))).resolves.toBeNull();
    expect(call(1).url.host).toBe("other.example.com");
  });
});

describe("getIssueById", () => {
  it("answers a 404 with null and encodes the id as one path segment", async () => {
    fetchMock().mockResolvedValueOnce(problem(404, "not_found"));
    await expect(beadsForgeProvider.getIssueById!(REPO, "dfat-1.2")).resolves.toBeNull();
    expect(call(0).url.pathname).toBe("/dfat/v0/beads/issues/dfat-1.2");
  });

  it("never sends something that isn't a bead id into the path", async () => {
    await expect(beadsForgeProvider.getIssueById!(REPO, "../config")).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("lets every other failure through", async () => {
    fetchMock().mockResolvedValueOnce(problem(503, "unavailable", { detail: "database down" }));
    await expect(beadsForgeProvider.getIssueById!(REPO, "dfat-1")).rejects.toThrow("database down");
  });
});

describe("resolveIssueRepo", () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(path.join(tmpdir(), "beads-project-"));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  async function writeTarget(content: unknown) {
    await mkdir(path.join(projectPath, ".beads"), { recursive: true });
    await writeFile(path.join(projectPath, ".beads", "http_target.json"), JSON.stringify(content));
  }

  it("is not set up when there is neither a setting nor a bd connect target", async () => {
    setServerUrlSettingReader(async () => undefined);
    await expect(beadsForgeProvider.resolveIssueRepo!(projectPath)).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("reads the address bd connect recorded, and names the served database", async () => {
    await writeTarget({ url: "http://127.0.0.1:7357/", api: "v0" });
    setServerUrlSettingReader(async () => "");
    fetchMock().mockResolvedValueOnce(json({ database: "dfat", project_id: "proj-1" }));
    const repo = await beadsForgeProvider.resolveIssueRepo!(projectPath);
    expect(repo).toMatchObject({ host: "127.0.0.1:7357", owner: "http://127.0.0.1:7357", repo: "dfat" });
    expect(call(0).url.pathname).toBe("/v0/beads/context");
  });

  it("prefers the project setting over the recorded target", async () => {
    await writeTarget({ url: "http://127.0.0.1:7357" });
    setServerUrlSettingReader(async () => "https://beads.example.com/dfat/");
    fetchMock().mockResolvedValueOnce(json({ database: "dfat", project_id: "p" }));
    const repo = await beadsForgeProvider.resolveIssueRepo!(projectPath);
    expect(repo?.owner).toBe(SERVER);
  });

  it("refuses a setting that isn't an address rather than falling back to the file", async () => {
    await writeTarget({ url: "http://127.0.0.1:7357" });
    setServerUrlSettingReader(async () => "beads.example.com");
    await expect(beadsForgeProvider.resolveIssueRepo!(projectPath)).rejects.toThrow(
      /isn't an http\(s\) address/
    );
  });

  it("switches a project to a new server when its setting changes", async () => {
    let setting = "https://one.example.com";
    setServerUrlSettingReader(async () => setting);
    fetchMock()
      .mockResolvedValueOnce(json({ database: "one", project_id: "1" }))
      .mockResolvedValueOnce(json({ database: "two", project_id: "2" }));
    expect((await beadsForgeProvider.resolveIssueRepo!(projectPath))?.repo).toBe("one");
    setting = "https://two.example.com";
    expect((await beadsForgeProvider.resolveIssueRepo!(projectPath))?.repo).toBe("two");
  });
});

describe("mutations", () => {
  async function seen(...ids: string[]) {
    fetchMock().mockResolvedValueOnce(page(ids.map((id) => bead(id))));
    await beadsForgeProvider.listIssues(REPO, {});
    fetchMock().mockClear();
  }

  it("assigns as the bd actor, and Undo hands the bead back with a compare-and-set", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "grace" })))
      .mockResolvedValueOnce(json({ issue: bead("dfat-1", { assignee: "ada" }), changed: true, revision: "2" }));
    await expect(beadsForgeProvider.assignIssue(REPO, n, "ada")).resolves.toEqual([
      expect.objectContaining({ login: "ada" }),
    ]);
    expect(call(1).init.method).toBe("PATCH");
    expect(call(1).body).toEqual({ actor: "ada", patch: { assignee: "ada" } });

    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(json({ issue: bead("dfat-1", { assignee: "grace" }), changed: true, revision: "3" }));
    await beadsForgeProvider.unassignIssue(REPO, n, "ada");
    expect(call(3).body).toEqual({
      actor: "ada",
      patch: { assignee: "grace" },
      expected_assignee: "ada",
    });
  });

  it("leaves a bead that was already the user's alone on Undo", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock().mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })));
    await beadsForgeProvider.assignIssue(REPO, n, "ada");
    fetchMock().mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })));
    await beadsForgeProvider.unassignIssue(REPO, n, "ada");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(fetchMock().mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true);
  });

  it("reads the bead back when someone else took it before Undo landed", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(problem(409, "precondition_failed"))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "linus" })));
    await expect(beadsForgeProvider.unassignIssue(REPO, n, "ada")).resolves.toEqual([
      expect.objectContaining({ login: "linus" }),
    ]);
  });

  it("closes with the reason in words, and comments as author and text", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json({ issue: bead("dfat-1", { status: "closed" }), already_closed: false, open_children: [], revision: "4" }))
      .mockResolvedValueOnce(json({ id: "c1", issue_id: "dfat-1", author: "ada", text: "Done", created_at: "2026-10-03T00:00:00Z" }));
    await expect(beadsForgeProvider.closeIssue(REPO, n, "not_planned")).resolves.toMatchObject({
      state: "closed",
    });
    expect(call(0).url.pathname).toBe("/dfat/v0/beads/issues/dfat-1:close");
    expect(call(0).body).toEqual({ actor: "ada", reason: "Not planned" });
    await expect(beadsForgeProvider.addIssueComment(REPO, n, "Done")).resolves.toMatchObject({
      id: "c1",
      body: "Done",
      author: { login: "ada" },
    });
    expect(call(1).body).toEqual({ author: "ada", text: "Done" });
  });

  it("creates a task with an explicit type and priority", async () => {
    fetchMock().mockResolvedValueOnce(json(bead("dfat-new")));
    const issue = await beadsForgeProvider.createIssue(REPO, { title: "New", body: "B", labels: ["x"] });
    expect(call(0).body).toEqual({
      actor: "ada",
      title: "New",
      description: "B",
      labels: ["x"],
      issue_type: "task",
      priority: 2,
    });
    // The created bead's number resolves without a relist.
    fetchMock().mockResolvedValueOnce(json(bead("dfat-new")));
    await beadsForgeProvider.getIssue(REPO, issue.number);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("refuses to remove a label the bead doesn't carry, as the host contract requires", async () => {
    await seen("dfat-1");
    fetchMock().mockResolvedValueOnce(json(bead("dfat-1", { labels: ["backend"] })));
    await expect(
      beadsForgeProvider.removeIssueLabel(REPO, beadNumber("dfat-1"), "frontend")
    ).rejects.toThrow(/no label "frontend"/);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("edits title and body as title and description", async () => {
    await seen("dfat-1");
    fetchMock().mockResolvedValueOnce(json({ issue: bead("dfat-1", { title: "T2" }), changed: true, revision: "5" }));
    await beadsForgeProvider.editIssue(REPO, beadNumber("dfat-1"), { title: "T2", body: "" });
    expect(call(0).body).toEqual({ actor: "ada", patch: { title: "T2", description: "" } });
  });
});

describe("credentials and identity", () => {
  it("accepts any well-formed token, since the server is per project", async () => {
    await expect(beadsForgeProvider.validateToken(" tok ")).resolves.toEqual({ valid: true });
    await expect(beadsForgeProvider.validateToken("a b")).resolves.toMatchObject({ valid: false });
    await expect(beadsForgeProvider.validateToken("  ")).resolves.toMatchObject({ valid: false });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("is the actor bd itself would record", async () => {
    await expect(beadsForgeProvider.identity!.getCurrentUser()).resolves.toMatchObject({
      login: "ada",
    });
  });

  it("drops cached server identity when the token changes", async () => {
    setServerUrlSettingReader(async () => SERVER);
    fetchMock()
      .mockResolvedValueOnce(json({ database: "dfat", project_id: "p" }))
      .mockResolvedValueOnce(json({ database: "dfat", project_id: "p" }));
    await beadsForgeProvider.resolveIssueRepo!("/p");
    await beadsForgeProvider.resolveIssueRepo!("/p");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    beadsForgeProvider.setCredentials!({ kind: "bearer", value: "other" });
    await beadsForgeProvider.resolveIssueRepo!("/p");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });
});

describe("repoStats", () => {
  it("counts the picker's open set across pages and reuses it until asked for fresh", async () => {
    fetchMock()
      .mockResolvedValueOnce(page([bead("a"), bead("b")], "n"))
      .mockResolvedValueOnce(page([bead("c")]));
    const first = await beadsForgeProvider.repoStats!.getRepoStats(REPO);
    expect(first.counts.issueCount).toBe(3);
    expect(call(0).url.searchParams.has("all")).toBe(false);
    const second = await beadsForgeProvider.repoStats!.getRepoStats(REPO);
    expect(second.source).toBe("memory-cache");
    fetchMock().mockResolvedValueOnce(page([]));
    const fresh = await beadsForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
    expect(fresh.counts.issueCount).toBe(0);
  });
});
