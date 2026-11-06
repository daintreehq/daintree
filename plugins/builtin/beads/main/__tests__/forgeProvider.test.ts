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

vi.mock("../issueNumbers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../issueNumbers.js")>();
  return { ...actual, beadNumber: vi.fn(actual.beadNumber) };
});

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
  return json({
    items,
    has_more: Boolean(nextCursor),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return json({ status, title: "Problem", code, request_id: "r", ...extra }, status);
}

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

function call(index: number): {
  url: URL;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
} {
  const [url, init] = fetchMock().mock.calls[index] as [string, RequestInit];
  return {
    url: new URL(url),
    init,
    headers: init.headers as Record<string, string>,
    body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  };
}

/** Binds SERVER the way a project setting does, so the token may go to it. */
async function bind(server = SERVER, projectId = "proj-1") {
  setServerUrlSettingReader(async () => server);
  fetchMock().mockResolvedValueOnce(json({ database: "dfat", project_id: projectId }));
  await beadsForgeProvider.resolveIssueRepo!("/projects/dfat");
  setServerUrlSettingReader(null);
  fetchMock().mockClear();
}

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("BEADS_ACTOR", "ada");
  setMemoryToken("bd-token");
  clearBeadsCaches();
  await bind();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setMemoryToken(null);
  setServerUrlSettingReader(null);
  clearBeadsCaches();
});

describe("requests", () => {
  it("sends the token as a bearer, stamps the workspace, and appends routes under a mount prefix", async () => {
    fetchMock().mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {});
    const { url, init, headers } = call(0);
    expect(url.pathname).toBe("/dfat/v0/beads/issues");
    expect(headers.Authorization).toBe("Bearer bd-token");
    expect(headers["Bd-Project-Id"]).toBe("proj-1");
    expect(init.redirect).toBe("error");
  });

  it("sends no Authorization header when no token is saved", async () => {
    setMemoryToken(null);
    fetchMock().mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {});
    expect(call(0).headers.Authorization).toBeUndefined();
  });

  it("classifies a refused token by status or by code alone", async () => {
    fetchMock().mockResolvedValueOnce(problem(401, "other"));
    await expect(beadsForgeProvider.listIssues(REPO, {})).rejects.toMatchObject({
      credentialRejected: true,
      message: "The Beads server rejected the token",
    });
    fetchMock().mockResolvedValueOnce(problem(403, "unauthenticated"));
    await expect(beadsForgeProvider.listIssues(REPO, {})).rejects.toMatchObject({
      credentialRejected: true,
    });
  });

  it("names a refused Host header, and passes any other 400's detail through", async () => {
    fetchMock().mockResolvedValueOnce(problem(400, "invalid_argument", { param: "Host" }));
    await expect(beadsForgeProvider.listIssues(REPO, {})).rejects.toThrow(/--allowed-host/);
    fetchMock().mockResolvedValueOnce(
      problem(400, "invalid_argument", { param: "q", detail: "bad search" })
    );
    await expect(beadsForgeProvider.listIssues(REPO, {})).rejects.toMatchObject({
      message: "Beads: bad search",
      credentialRejected: false,
    });
  });

  it("reports a success body that isn't JSON as such", async () => {
    fetchMock().mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(beadsForgeProvider.listIssues(REPO, {})).rejects.toThrow(/isn't JSON/);
  });

  it("forgets what it learned from a server that now serves another workspace", async () => {
    fetchMock().mockResolvedValueOnce(page([bead("dfat-1")]));
    await beadsForgeProvider.listIssues(REPO, {});
    fetchMock().mockResolvedValueOnce(
      problem(400, "invalid_argument", { param: "Bd-Project-Id", reason: "project_mismatch" })
    );
    await expect(beadsForgeProvider.getIssue(REPO, beadNumber("dfat-1"))).rejects.toThrow(
      /now serves a different workspace/
    );
    // The number is no longer known, and the stale stamp is gone: the next
    // lookup relists without one.
    fetchMock().mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
    await expect(beadsForgeProvider.getIssue(REPO, beadNumber("dfat-1"))).resolves.toBeNull();
    expect(call(2).url.pathname).toBe("/dfat/v0/beads/issues");
    expect(call(2).headers["Bd-Project-Id"]).toBeUndefined();
  });
});

describe("listIssues", () => {
  it("maps beads with the id as key, a bead/ branch, an empty url and their own status", async () => {
    const node = bead("dfat-39kl", { assignee: "ada", status: "hooked" });
    fetchMock().mockResolvedValueOnce(page([node], "c2"));
    const result = await beadsForgeProvider.listIssues(REPO, {});
    const issue = result.items[0];
    expect(issue).toMatchObject({
      number: 4065058022750427,
      id: "dfat-39kl",
      key: "dfat-39kl",
      branchName: "bead/dfat-39kl",
      url: "",
      title: "Bead dfat-39kl",
      body: "Body",
      state: "open",
      rawState: "hooked",
      commentCount: 3,
      labels: [{ name: "backend" }],
      assignees: [{ login: "ada" }],
      author: { login: "grace" },
      createdAt: Date.parse("2026-10-01T00:00:00Z"),
      closedAt: null,
    });
    expect(issue.rawData).toEqual(node);
    expect(result).toMatchObject({ nextCursor: "c2", hasMore: true });
  });

  it("ends paging on the last page", async () => {
    fetchMock().mockResolvedValueOnce(page([bead("dfat-1")]));
    await expect(beadsForgeProvider.listIssues(REPO, {})).resolves.toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
  });

  it("reads the open set as bd list's default, and passes filters and search natively", async () => {
    fetchMock().mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {
      search: " dfat-39kl ",
      labels: ["a", "b"],
      assignee: "ada",
      perPage: 30,
      cursor: "c1",
    });
    const params = call(0).url.searchParams;
    expect(params.has("status")).toBe(false);
    expect(params.has("all")).toBe(false);
    expect(params.get("q")).toBe("dfat-39kl");
    expect(params.getAll("label")).toEqual(["a", "b"]);
    expect(params.get("assignee")).toBe("ada");
    expect(params.get("limit")).toBe("30");
    expect(params.get("cursor")).toBe("c1");
  });

  it("clamps the page size into what one request should carry", async () => {
    fetchMock().mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, { perPage: 5000 });
    await beadsForgeProvider.listIssues(REPO, { perPage: 0 });
    const big = Number(call(0).url.searchParams.get("limit"));
    expect(big).toBeLessThan(5000);
    expect(big).toBeGreaterThan(0);
    expect(call(1).url.searchParams.get("limit")).toBe("1");
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

  it("looks in the open set first, then every status, for a number it hasn't seen", async () => {
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-aaaa")]))
      .mockResolvedValueOnce(page([bead("dfat-bbbb")], "next"))
      .mockResolvedValueOnce(page([bead("dfat-39kl", { status: "closed" })]))
      .mockResolvedValueOnce(json(bead("dfat-39kl", { status: "closed" })));
    const issue = await beadsForgeProvider.getIssue(REPO, beadNumber("dfat-39kl"));
    expect(issue).toMatchObject({ key: "dfat-39kl", state: "closed" });
    expect(call(0).url.searchParams.has("all")).toBe(false);
    expect(call(1).url.searchParams.get("all")).toBe("true");
    expect(call(2).url.searchParams.get("all")).toBe("true");
    expect(call(2).url.searchParams.get("cursor")).toBe("next");
    expect(call(3).url.pathname).toBe("/dfat/v0/beads/issues/dfat-39kl");
  });

  it("stops looking as soon as the number turns up", async () => {
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-39kl")], "more"))
      .mockResolvedValueOnce(json(bead("dfat-39kl")));
    await beadsForgeProvider.getIssue(REPO, beadNumber("dfat-39kl"));
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("answers null for a number no bead on the server has", async () => {
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-aaaa")]))
      .mockResolvedValueOnce(page([]));
    await expect(beadsForgeProvider.getIssue(REPO, 12345)).resolves.toBeNull();
  });

  it("gives up with an error, not a false not-found, when the budget runs out", async () => {
    let n = 0;
    fetchMock().mockImplementation(async () => page([bead(`dfat-x${n++}`)], `c${n}`));
    await expect(beadsForgeProvider.getIssue(REPO, 12345)).rejects.toThrow(/within the first/);
    const calls = fetchMock().mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(1000);
  });

  it("refuses a number two beads share, while each stays reachable by id", async () => {
    vi.mocked(beadNumber).mockImplementation(() => 7);
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-1"), bead("dfat-2")]))
      .mockResolvedValueOnce(json(bead("dfat-2")));
    await beadsForgeProvider.listIssues(REPO, {});
    await expect(beadsForgeProvider.getIssue(REPO, 7)).rejects.toThrow(/share issue number 7/);
    await expect(beadsForgeProvider.addIssueLabel(REPO, 7, "x")).rejects.toThrow(/share/);
    await expect(beadsForgeProvider.getIssueById!(REPO, "dfat-2")).resolves.toMatchObject({
      key: "dfat-2",
    });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    vi.mocked(beadNumber).mockRestore();
  });

  it("keeps numbers apart per server", async () => {
    const other: RepoRef = { ...REPO, owner: "https://other.example.com" };
    fetchMock()
      .mockResolvedValueOnce(page([bead("dfat-39kl")]))
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([]));
    await beadsForgeProvider.listIssues(REPO, {});
    await expect(beadsForgeProvider.getIssue(other, beadNumber("dfat-39kl"))).resolves.toBeNull();
    expect(call(1).url.host).toBe("other.example.com");
  });
});

describe("getIssueById", () => {
  it("answers a 404 with null and encodes the id as one path segment", async () => {
    fetchMock().mockResolvedValueOnce(problem(404, "not_found"));
    await expect(beadsForgeProvider.getIssueById!(REPO, "dfat:1.2")).resolves.toBeNull();
    expect(call(0).url.pathname).toBe("/dfat/v0/beads/issues/dfat%3A1.2");
  });

  it("never sends something that isn't a bead id into the path", async () => {
    for (const id of ["../config", "a b", "a\u0001b", "a?b", ""]) {
      await expect(beadsForgeProvider.getIssueById!(REPO, id)).resolves.toBeNull();
    }
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
    clearBeadsCaches();
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  async function writeTarget(content: unknown) {
    await mkdir(path.join(projectPath, ".beads"), { recursive: true });
    await writeFile(
      path.join(projectPath, ".beads", "http_target.json"),
      typeof content === "string" ? content : JSON.stringify(content)
    );
  }

  it("is not set up when there is neither a setting nor a bd connect target", async () => {
    setServerUrlSettingReader(async () => undefined);
    await expect(beadsForgeProvider.resolveIssueRepo!(projectPath)).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("is not set up when the recorded target isn't usable", async () => {
    setServerUrlSettingReader(async () => undefined);
    for (const content of ["{not json", { api: "v0" }, { url: "file:///etc" }]) {
      await writeTarget(content);
      await expect(beadsForgeProvider.resolveIssueRepo!(projectPath)).resolves.toBeNull();
    }
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("reads a loopback address bd connect recorded, sends it the token, and names the database", async () => {
    await writeTarget({ url: "http://127.0.0.1:7357/", api: "v0" });
    setServerUrlSettingReader(async () => "");
    fetchMock().mockResolvedValueOnce(json({ database: "dfat", project_id: "proj-1" }));
    const repo = await beadsForgeProvider.resolveIssueRepo!(projectPath);
    expect(repo).toMatchObject({
      host: "127.0.0.1:7357",
      owner: "http://127.0.0.1:7357",
      repo: "dfat",
    });
    expect(call(0).url.pathname).toBe("/v0/beads/context");
    expect(call(0).headers.Authorization).toBe("Bearer bd-token");
  });

  it("never sends the token to a remote address only the repository named", async () => {
    await writeTarget({ url: "https://evil.example.com" });
    setServerUrlSettingReader(async () => undefined);
    fetchMock().mockResolvedValueOnce(problem(401, "unauthenticated"));
    await expect(beadsForgeProvider.resolveIssueRepo!(projectPath)).rejects.toThrow(
      /Project settings to use the token/
    );
    expect(call(0).headers.Authorization).toBeUndefined();
  });

  it("prefers the project setting over the recorded target, and trusts it with the token", async () => {
    await writeTarget({ url: "http://127.0.0.1:7357" });
    setServerUrlSettingReader(async () => "https://beads.example.com/dfat/");
    fetchMock().mockResolvedValueOnce(json({ database: "dfat", project_id: "p" }));
    const repo = await beadsForgeProvider.resolveIssueRepo!(projectPath);
    expect(repo?.owner).toBe(SERVER);
    expect(call(0).url.host).toBe("beads.example.com");
    expect(call(0).headers.Authorization).toBe("Bearer bd-token");
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

  it("doesn't let a request started before a reset refill the caches", async () => {
    setServerUrlSettingReader(async () => SERVER);
    let answer!: (r: Response) => void;
    fetchMock().mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));
    const pending = beadsForgeProvider.resolveIssueRepo!(projectPath);
    await vi.waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    clearBeadsCaches();
    answer(json({ database: "old", project_id: "p" }));
    await pending;
    fetchMock().mockResolvedValueOnce(json({ database: "new", project_id: "p" }));
    expect((await beadsForgeProvider.resolveIssueRepo!(projectPath))?.repo).toBe("new");
  });
});

describe("mutations", () => {
  async function seen(...ids: string[]) {
    fetchMock().mockResolvedValueOnce(page(ids.map((id) => bead(id))));
    await beadsForgeProvider.listIssues(REPO, {});
    fetchMock().mockClear();
  }

  function patched(id: string, overrides: Record<string, unknown> = {}) {
    return json({ issue: bead(id, overrides), changed: true, revision: "9" });
  }

  it("assigns as the bd actor, fenced on the revision read, and Undo hands the bead back", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "grace", revision: "r1" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "ada" }));
    await expect(beadsForgeProvider.assignIssue(REPO, n, "ada")).resolves.toEqual([
      expect.objectContaining({ login: "ada" }),
    ]);
    expect(call(1).init.method).toBe("PATCH");
    expect(call(1).url.pathname).toBe("/dfat/v0/beads/issues/dfat-1");
    expect(call(1).body).toEqual({
      actor: "ada",
      patch: { assignee: "ada" },
      expected_version: "r1",
    });

    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "grace" }));
    await expect(beadsForgeProvider.unassignIssue(REPO, n, "ada")).resolves.toEqual([
      expect.objectContaining({ login: "grace" }),
    ]);
    expect(call(3).init.method).toBe("PATCH");
    expect(call(3).body).toEqual({
      actor: "ada",
      patch: { assignee: "grace" },
      expected_assignee: "ada",
    });
  });

  it("rereads and retries once when the bead changed between the read and the assign", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "grace", revision: "r1" })))
      .mockResolvedValueOnce(problem(409, "precondition_failed"))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "linus", revision: "r2" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "ada" }));
    await beadsForgeProvider.assignIssue(REPO, n, "ada");
    expect(call(3).body).toMatchObject({ expected_version: "r2" });

    // Undo restores whoever the successful write replaced.
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "linus" }));
    await beadsForgeProvider.unassignIssue(REPO, n, "ada");
    expect(call(5).body).toMatchObject({ patch: { assignee: "linus" } });
  });

  it("leaves a bead that was already the user's alone on Undo", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock().mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })));
    await beadsForgeProvider.assignIssue(REPO, n, "ada");
    fetchMock().mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })));
    await beadsForgeProvider.unassignIssue(REPO, n, "ada");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(
      fetchMock().mock.calls.every(([, init]) => ((init as RequestInit).method ?? "GET") === "GET")
    ).toBe(true);
  });

  it("keeps an assignment's Undo through a repeated assign", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "grace" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "ada" }))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "grace" }));
    await beadsForgeProvider.assignIssue(REPO, n, "ada");
    await beadsForgeProvider.assignIssue(REPO, n, "ada");
    await beadsForgeProvider.unassignIssue(REPO, n, "ada");
    expect(call(4).body).toMatchObject({ patch: { assignee: "grace" } });
  });

  it("keeps Undo apart for the same bead id on two servers", async () => {
    const other: RepoRef = { ...REPO, owner: "https://other.example.com" };
    await bind("https://other.example.com", "proj-2");
    await seen("dfat-1");
    fetchMock().mockResolvedValueOnce(page([bead("dfat-1")]));
    await beadsForgeProvider.listIssues(other, {});
    fetchMock().mockClear();
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "grace" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "ada" }))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "linus" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "ada" }))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "grace" }));
    await beadsForgeProvider.assignIssue(REPO, n, "ada");
    await beadsForgeProvider.assignIssue(other, n, "ada");
    await beadsForgeProvider.unassignIssue(REPO, n, "ada");
    expect(call(5).url.host).toBe("beads.example.com");
    expect(call(5).body).toMatchObject({ patch: { assignee: "grace" } });
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

  it("still knows whom to restore when an Undo fails and is retried", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "grace" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "ada" }))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(problem(503, "unavailable"))
      .mockResolvedValueOnce(json(bead("dfat-1", { assignee: "ada" })))
      .mockResolvedValueOnce(patched("dfat-1", { assignee: "grace" }));
    await beadsForgeProvider.assignIssue(REPO, n, "ada");
    await expect(beadsForgeProvider.unassignIssue(REPO, n, "ada")).rejects.toThrow();
    await beadsForgeProvider.unassignIssue(REPO, n, "ada");
    expect(call(5).body).toMatchObject({ patch: { assignee: "grace" } });
  });

  it("closes with the reason in words, reopens, and comments as author and text", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(
        json({
          issue: bead("dfat-1", { status: "closed", closed_at: "2026-10-03T00:00:00Z" }),
          already_closed: false,
          open_children: [],
          revision: "4",
        })
      )
      .mockResolvedValueOnce(json({ issue: bead("dfat-1"), already_open: false, revision: "5" }))
      .mockResolvedValueOnce(
        json({
          id: "c1",
          issue_id: "dfat-1",
          author: "ada",
          text: "Done",
          created_at: "2026-10-03T00:00:00Z",
        })
      );
    await expect(beadsForgeProvider.closeIssue(REPO, n, "not_planned")).resolves.toMatchObject({
      state: "closed",
      closedAt: Date.parse("2026-10-03T00:00:00Z"),
    });
    expect(call(0).init.method).toBe("POST");
    expect(call(0).url.pathname).toBe("/dfat/v0/beads/issues/dfat-1:close");
    expect(call(0).body).toEqual({ actor: "ada", reason: "Not planned" });
    await expect(beadsForgeProvider.reopenIssue(REPO, n)).resolves.toMatchObject({
      state: "open",
    });
    expect(call(1).url.pathname).toBe("/dfat/v0/beads/issues/dfat-1:reopen");
    expect(call(1).body).toEqual({ actor: "ada" });
    await expect(beadsForgeProvider.addIssueComment(REPO, n, "Done")).resolves.toEqual({
      id: "c1",
      body: "Done",
      url: "",
      author: expect.objectContaining({ login: "ada" }),
      createdAt: Date.parse("2026-10-03T00:00:00Z"),
      rawData: expect.objectContaining({ issue_id: "dfat-1" }),
    });
    expect(call(2).init.method).toBe("POST");
    expect(call(2).url.pathname).toBe("/dfat/v0/beads/issues/dfat-1/comments");
    expect(call(2).body).toEqual({ author: "ada", text: "Done" });
  });

  it("creates a bead whose number then resolves without a relist", async () => {
    fetchMock().mockResolvedValueOnce(json(bead("dfat-new")));
    const issue = await beadsForgeProvider.createIssue(REPO, {
      title: "New",
      body: "B",
      labels: ["x"],
    });
    expect(call(0).init.method).toBe("POST");
    expect(call(0).url.pathname).toBe("/dfat/v0/beads/issues");
    expect(call(0).body).toMatchObject({
      actor: "ada",
      title: "New",
      description: "B",
      labels: ["x"],
      issue_type: "task",
    });
    fetchMock().mockResolvedValueOnce(json(bead("dfat-new")));
    await beadsForgeProvider.getIssue(REPO, issue.number);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("adds and removes labels one at a time, and refuses to remove one that isn't there", async () => {
    await seen("dfat-1");
    const n = beadNumber("dfat-1");
    fetchMock()
      .mockResolvedValueOnce(patched("dfat-1", { labels: ["backend", "ui"] }))
      .mockResolvedValueOnce(json(bead("dfat-1", { labels: ["backend", "ui"] })))
      .mockResolvedValueOnce(patched("dfat-1", { labels: ["backend"] }))
      .mockResolvedValueOnce(json(bead("dfat-1", { labels: ["backend"] })));
    await expect(beadsForgeProvider.addIssueLabel(REPO, n, "ui")).resolves.toEqual([
      { name: "backend" },
      { name: "ui" },
    ]);
    expect(call(0).body).toEqual({ actor: "ada", patch: { add_labels: ["ui"] } });
    await expect(beadsForgeProvider.removeIssueLabel(REPO, n, "ui")).resolves.toEqual([
      { name: "backend" },
    ]);
    expect(call(2).body).toEqual({ actor: "ada", patch: { remove_labels: ["ui"] } });
    await expect(beadsForgeProvider.removeIssueLabel(REPO, n, "frontend")).rejects.toThrow(
      /no label "frontend"/
    );
    expect(fetchMock()).toHaveBeenCalledTimes(4);
  });

  it("edits title and body as title and description, and refuses an empty edit", async () => {
    await seen("dfat-1");
    fetchMock().mockResolvedValueOnce(patched("dfat-1", { title: "T2" }));
    await beadsForgeProvider.editIssue(REPO, beadNumber("dfat-1"), { title: "T2", body: "" });
    expect(call(0).init.method).toBe("PATCH");
    expect(call(0).body).toEqual({ actor: "ada", patch: { title: "T2", description: "" } });
    await expect(beadsForgeProvider.editIssue(REPO, beadNumber("dfat-1"), {})).rejects.toThrow(
      "Nothing to edit"
    );
  });
});

describe("credentials", () => {
  it("accepts any well-formed token, since the server is per project", async () => {
    await expect(beadsForgeProvider.validateToken(" tok ")).resolves.toEqual({ valid: true });
    for (const bad of ["a b", "a\u0001b", "a\u007fb", "  "]) {
      await expect(beadsForgeProvider.validateToken(bad)).resolves.toMatchObject({ valid: false });
    }
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("asks the server again under a new token", async () => {
    setServerUrlSettingReader(async () => SERVER);
    await beadsForgeProvider.resolveIssueRepo!("/p");
    expect(fetchMock()).not.toHaveBeenCalled();
    beadsForgeProvider.setCredentials!({ kind: "bearer", value: "other" });
    fetchMock().mockResolvedValueOnce(json({ database: "dfat", project_id: "proj-1" }));
    await beadsForgeProvider.resolveIssueRepo!("/p");
    expect(call(0).headers.Authorization).toBe("Bearer other");
  });
});

describe("repoStats", () => {
  it("counts the picker's open set across pages and reuses it until asked for fresh", async () => {
    fetchMock()
      .mockResolvedValueOnce(page([bead("a"), bead("b")], "n"))
      .mockResolvedValueOnce(page([bead("c")]));
    const first = await beadsForgeProvider.repoStats!.getRepoStats(REPO);
    expect(first.counts.issueCount).toBe(3);
    for (const i of [0, 1]) {
      expect(call(i).url.searchParams.has("all")).toBe(false);
      expect(call(i).url.searchParams.has("status")).toBe(false);
    }
    expect(call(1).url.searchParams.get("cursor")).toBe("n");
    const second = await beadsForgeProvider.repoStats!.getRepoStats(REPO);
    expect(second).toMatchObject({ source: "memory-cache", counts: { issueCount: 3 } });
    fetchMock().mockResolvedValueOnce(page([]));
    const fresh = await beadsForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
    expect(fresh.counts.issueCount).toBe(0);
  });

  it("reads as unknown past its page budget", async () => {
    let n = 0;
    fetchMock().mockImplementation(async () => page([bead(`x${n++}`)], `c${n}`));
    const stats = await beadsForgeProvider.repoStats!.getRepoStats(REPO);
    expect(stats.counts.issueCount).toBeNull();
  });
});
