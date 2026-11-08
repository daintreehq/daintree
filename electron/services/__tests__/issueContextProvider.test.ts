import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  resolveForCwd: vi.fn(),
  checkRateLimit: vi.fn(),
  auditForgeCall: vi.fn(),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: { getProjectById: boundary.getProjectById },
}));
vi.mock("../../ipc/handlers/forgeResolution.js", () => ({
  resolveForCwd: boundary.resolveForCwd,
}));
vi.mock("../../ipc/utils.js", () => ({ checkRateLimit: boundary.checkRateLimit }));
vi.mock("../forge/forgeAuditService.js", () => ({ auditForgeCall: boundary.auditForgeCall }));

import {
  ISSUE_CONTEXT_PLUGIN_ID,
  createIssueContextProvider,
  formatIssueContext,
  resetIssueContextProviderForTests,
  withHostContextProviders,
  type IssueContextDeps,
  type IssueSource,
} from "../issueContextProvider.js";
import { arbitrateContextProviders } from "../contextProviderRegistry.js";
import type {
  ForgeIssueProviderImpl,
  Issue,
  IssueComment,
  Page,
  RepoRef,
} from "../../../shared/types/forge.js";
import { AGENT_CONTEXT_MAX_TEXT_LENGTH } from "../../../shared/utils/agentContextDrag.js";
import { sanitizeContextProviderContent } from "../../../shared/utils/pluginContextSanitize.js";

const REPO: RepoRef = { host: "example.test", owner: "acme", repo: "app", rawData: null };

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 12,
    title: "Fix login",
    body: "Steps to reproduce",
    state: "open",
    rawState: "OPEN",
    url: "https://example.test/acme/app/issues/12",
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    rawData: null,
    ...overrides,
  };
}

function comment(n: number, body = `comment ${n}`): IssueComment {
  return {
    id: String(n),
    body,
    url: "",
    author: { login: `user${n}`, rawData: null },
    createdAt: Date.UTC(2026, 10, 1, 12, n % 60),
    rawData: null,
  };
}

function page<T>(items: T[], nextCursor: string | null = null): Page<T> {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

function provider(overrides: Partial<ForgeIssueProviderImpl> = {}): ForgeIssueProviderImpl {
  return {
    listIssues: vi.fn(async () => page<Issue>([])),
    getIssue: vi.fn(async () => null),
    ...overrides,
  } as unknown as ForgeIssueProviderImpl;
}

function deps(impl: ForgeIssueProviderImpl, overrides: Partial<IssueContextDeps> = {}) {
  const source: IssueSource = { impl, repo: REPO, namespaceId: "acme.forge" };
  return {
    resolveSource: vi.fn(async () => source),
    checkRateLimit: vi.fn(async () => {}),
    audit: vi.fn(async (_meta: unknown, run: () => Promise<unknown>) => run()),
    now: () => Date.now(),
    ...overrides,
  } as IssueContextDeps & {
    resolveSource: ReturnType<typeof vi.fn>;
    checkRateLimit: ReturnType<typeof vi.fn>;
  };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  resetIssueContextProviderForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withHostContextProviders (#16382)", () => {
  const plugin = (pluginId: string, prefix: string) => ({
    pluginId,
    pluginName: pluginId,
    contribution: { id: "p", prefix, label: "Things" },
  });

  it("holds `issue` ahead of any plugin that claims it, naming itself as the holder", () => {
    const entries = arbitrateContextProviders(
      withHostContextProviders(
        [plugin("acme.tracker", "issue"), plugin("acme.wiki", "page")],
        "p1"
      ),
      () => false
    );
    expect(entries.map((e) => [e.pluginId, e.prefix, e.status, e.scope])).toEqual([
      [ISSUE_CONTEXT_PLUGIN_ID, "issue", "active", "global"],
      ["acme.tracker", "issue", "refused", "global"],
      ["acme.wiki", "page", "active", "global"],
    ]);
    expect(entries[1]?.heldBy).toEqual({
      pluginId: ISSUE_CONTEXT_PLUGIN_ID,
      pluginName: "Daintree",
    });
  });

  it("hands `issue` to the next plugin in line when switched off", () => {
    const entries = arbitrateContextProviders(
      withHostContextProviders([plugin("acme.tracker", "issue")], "p1"),
      (id) => id === ISSUE_CONTEXT_PLUGIN_ID
    );
    expect(entries.map((e) => e.status)).toEqual(["off", "active"]);
  });

  it("adds nothing of its own to a view with no project, keeping the plugins' entries", () => {
    const visible = [plugin("acme.wiki", "page")];
    expect(withHostContextProviders(visible, null)).toEqual(visible);
  });
});

describe("issue search (#16382)", () => {
  async function search(
    provider: ReturnType<typeof createIssueContextProvider>,
    query: string,
    abort = signal()
  ) {
    const pending = provider.search(query, { signal: abort });
    // Observed now: a search that fails does so while the timers advance.
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(250);
    return pending;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("browses open issues by number on a forge that numbers them", async () => {
    const impl = provider({
      listIssues: vi.fn(async () =>
        page([issue(), issue({ number: 7, title: "Crash\non save", state: "closed" })])
      ),
    });
    const d = deps(impl);
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    expect(await search(p, "")).toEqual([
      { id: "12", label: "#12 Fix login", description: "Open issue" },
      { id: "7", label: "#7 Crash on save", description: "Closed issue" },
    ]);
    expect(d.resolveSource).toHaveBeenCalledWith("p1");
    expect(d.checkRateLimit).toHaveBeenCalledWith("search");
    expect(impl.listIssues).toHaveBeenCalledWith(REPO, { state: "open", perPage: 50 });
    expect(impl.getIssue).not.toHaveBeenCalled();
  });

  it("puts the exact number first, as the forge read it, and searches every state", async () => {
    const impl = provider({
      getIssue: vi.fn(async () => issue({ number: 123, title: "Old one", state: "closed" })),
      listIssues: vi.fn(async () =>
        page([issue(), issue({ number: 123, title: "Listed copy", state: "open" })])
      ),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    expect(await search(p, "#123")).toEqual([
      { id: "123", label: "#123 Old one", description: "Closed issue" },
      { id: "12", label: "#12 Fix login", description: "Open issue" },
    ]);
    expect(impl.getIssue).toHaveBeenCalledWith(REPO, 123);
    expect(impl.listIssues).toHaveBeenCalledWith(REPO, {
      state: "all",
      perPage: 50,
      search: "123",
    });
  });

  it("addresses a keyed tracker's issues by key, looking an exact key up directly", async () => {
    const eng = issue({ number: 5, key: "ENG-5", title: "Ship it" });
    const impl = provider({
      getIssueById: vi.fn(async () => eng),
      listIssues: vi.fn(async () => page([issue({ number: 9, key: "ENG-9" }), eng])),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const rows = await search(p, "ENG-5");
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ["ENG-5", "ENG-5 Ship it"],
      ["ENG-9", "ENG-9 Fix login"],
    ]);
    expect(impl.getIssueById).toHaveBeenCalledWith(REPO, "ENG-5");
    expect(impl.getIssue).not.toHaveBeenCalled();
  });

  it("addresses a key made only of digits by number, which is how it reads back", async () => {
    const impl = provider({
      getIssueById: vi.fn(async () => null),
      listIssues: vi.fn(async () => page([issue({ number: 88, key: "123", title: "Bead" })])),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    expect((await search(p, "")).map((r) => r.id)).toEqual(["88"]);
  });

  it("answers only the newest search typed in a view, without reaching the forge for the rest", async () => {
    const impl = provider({ listIssues: vi.fn(async () => page([issue()])) });
    const d = deps(impl);
    const view = (projectId: string, requester: string) =>
      createIssueContextProvider(projectId, { deadlineAt: Infinity, requester, deps: d });
    const first = view("p1", "1").search("f", { signal: signal() });
    const second = view("p1", "1").search("fi", { signal: signal() });
    const otherView = view("p1", "2").search("x", { signal: signal() });
    const otherProject = view("p2", "1").search("y", { signal: signal() });
    await vi.advanceTimersByTimeAsync(249);
    expect(d.resolveSource).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual([]);
    expect(await second).toHaveLength(1);
    expect(await otherView).toHaveLength(1);
    expect(await otherProject).toHaveLength(1);
    expect(d.resolveSource.mock.calls).toEqual([["p1"], ["p1"], ["p2"]]);
  });

  it("keeps whichever read answered when the other fails or stalls past its cutoff", async () => {
    const failingList = provider({
      getIssue: vi.fn(async () => issue({ number: 4 })),
      listIssues: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(failingList) });
    expect((await search(p, "4")).map((r) => r.id)).toEqual(["4"]);

    const stalledList = provider({
      getIssue: vi.fn(async () => issue({ number: 4 })),
      listIssues: vi.fn(() => new Promise<never>(() => {})),
    });
    const deadlineAt = Date.now() + 3_000;
    const q = createIssueContextProvider("p1", { deadlineAt, deps: deps(stalledList) });
    const pending = q.search("4", { signal: signal() });
    await vi.advanceTimersByTimeAsync(2_700);
    expect((await pending).map((r) => r.id)).toEqual(["4"]);

    const failingLookup = provider({
      getIssue: vi.fn(async () => {
        throw new Error("lookup failed");
      }),
      listIssues: vi.fn(async () => page([issue({ number: 40 })])),
    });
    const r = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(failingLookup) });
    expect((await search(r, "4")).map((row) => row.id)).toEqual(["40"]);
  });

  it("fails with the list's error when neither read answers", async () => {
    const impl = provider({
      getIssue: vi.fn(async () => {
        throw new Error("lookup failed");
      }),
      listIssues: vi.fn(async () => {
        throw new Error("list failed");
      }),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    await expect(search(p, "4")).rejects.toThrow("list failed");
  });

  it("stops when the host stops waiting, leaving nothing scheduled", async () => {
    const d = deps(provider());
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    const controller = new AbortController();
    const pending = p.search("x", { signal: controller.signal });
    controller.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow("timed out");
    expect(vi.getTimerCount()).toBe(0);
    expect(d.resolveSource).not.toHaveBeenCalled();

    const aborted = new AbortController();
    aborted.abort(new Error("gone"));
    await expect(p.search("x", { signal: aborted.signal })).rejects.toThrow("gone");
  });
});

describe("issue resolve (#16382)", () => {
  it("reads an issue by number, with its whole discussion when it fits", async () => {
    const listIssueComments = vi.fn(async () => page([comment(1), comment(2)]));
    const impl = provider({
      getIssue: vi.fn(async () => issue({ commentCount: 2 })),
      issueComments: { listIssueComments },
    });
    const d = deps(impl);
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    const content = await p.resolve("12", { signal: signal() });
    expect(impl.getIssue).toHaveBeenCalledWith(REPO, 12);
    expect(listIssueComments).toHaveBeenCalledWith(REPO, 12, { perPage: 100 });
    expect(d.checkRateLimit.mock.calls).toEqual([["read"], ["comments"]]);
    expect(content?.title).toBe("#12 Fix login");
    const text = content!.text;
    expect(text.split("\n")[0]).toMatch(/untrusted/i);
    expect(text).toContain("Issue: #12 Fix login");
    expect(text).toContain("Link: https://example.test/acme/app/issues/12");
    expect(text).toContain("State: open");
    expect(text).toContain("Description:\nSteps to reproduce");
    expect(text).toContain("Comments (all 2):");
    expect(text).toContain("--- user1 · 2026-11-01 12:01 UTC\ncomment 1");
    expect(text).toContain("--- user2 · 2026-11-01 12:02 UTC\ncomment 2");
    expect(text.indexOf("comment 1")).toBeLessThan(text.indexOf("comment 2"));
  });

  it("reads a keyed issue by key and says when the provider shares no comments", async () => {
    const impl = provider({
      getIssueById: vi.fn(async () =>
        issue({ key: "ENG-5", rawState: "In Progress", url: "", commentCount: 3 })
      ),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const text = (await p.resolve("ENG-5", { signal: signal() }))!.text;
    expect(impl.getIssueById).toHaveBeenCalledWith(REPO, "ENG-5");
    expect(text).toContain("Issue: ENG-5 Fix login");
    expect(text).toContain("State: open (In Progress)");
    expect(text).toContain("Link: none");
    expect(text).toContain("doesn't share them (the issue has 3)");
  });

  it("refuses a key on a provider that only finds issues by number", async () => {
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(provider()) });
    await expect(p.resolve("ENG-5", { signal: signal() })).rejects.toThrow("by number only");
  });

  it("is not found when the issue is gone", async () => {
    const impl = provider({
      getIssue: vi.fn(async (_repo: RepoRef, n: number) => (n === 12 ? issue() : null)),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    expect(await p.resolve("99", { signal: signal() })).toBeNull();
    expect(impl.getIssue).toHaveBeenCalledWith(REPO, 99);
  });

  it("keeps the latest comments once the thread's end is reached", async () => {
    const all = Array.from({ length: 25 }, (_, i) => comment(i + 1));
    const listIssueComments = vi.fn(async (_r: unknown, _n: number, opts: { cursor?: string }) =>
      opts.cursor === "next" ? page(all.slice(20)) : page(all.slice(0, 20), "next")
    );
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments },
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const text = (await p.resolve("12", { signal: signal() }))!.text;
    expect(listIssueComments.mock.calls).toEqual([
      [REPO, 12, { perPage: 100 }],
      [REPO, 12, { perPage: 100, cursor: "next" }],
    ]);
    expect(text).toContain("Comments (latest 10 of 25):");
    expect(text).toContain("\ncomment 25");
    expect(text).toContain("\ncomment 16");
    expect(text).not.toContain("\ncomment 15\n");
  });

  it("says the discussion is partial when paging stops before its end", async () => {
    let n = 0;
    const listIssueComments = vi.fn(async () => page([comment(++n)], `c${n}`));
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments },
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const text = (await p.resolve("12", { signal: signal() }))!.text;
    expect(text).toContain("Comments (3 of the first 3 read; newer comments may be missing):");
    expect(listIssueComments).toHaveBeenCalledTimes(3);
  });

  it("stops on a cursor it has already followed", async () => {
    const listIssueComments = vi.fn(async () => page([comment(1)], "same"));
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments },
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const text = (await p.resolve("12", { signal: signal() }))!.text;
    expect(text).toContain("newer comments may be missing");
    expect(listIssueComments).toHaveBeenCalledTimes(2);
  });

  it("still attaches the issue when its comments fail", async () => {
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: {
        listIssueComments: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const text = (await p.resolve("12", { signal: signal() }))!.text;
    expect(text).toContain("Issue: #12 Fix login");
    expect(text).toContain("Steps to reproduce");
    expect(text).toContain("Comments: couldn't be read");
  });

  it("stops reading comments short of the resolve deadline, keeping the issue", async () => {
    vi.useFakeTimers();
    const listIssueComments = vi.fn(() => new Promise<never>(() => {}));
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments },
    });
    const deadlineAt = Date.now() + 1_000;
    const p = createIssueContextProvider("p1", { deadlineAt, deps: deps(impl) });
    let settled = false;
    const pending = p.resolve("12", { signal: signal() }).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(699);
    expect(listIssueComments).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const text = (await pending)!.text;
    expect(text).toContain("Issue: #12 Fix login");
    expect(text).toContain("Comments: couldn't be read");
  });

  it("gives comments two seconds however far off the deadline is", async () => {
    vi.useFakeTimers();
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments: vi.fn(() => new Promise<never>(() => {})) },
    });
    const p = createIssueContextProvider("p1", {
      deadlineAt: Date.now() + 60_000,
      deps: deps(impl),
    });
    let settled = false;
    const pending = p.resolve("12", { signal: signal() }).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending)!.text).toContain("Comments: couldn't be read");
  });

  it("stops paging once the host stops waiting", async () => {
    let release!: (value: Page<IssueComment>) => void;
    const listIssueComments = vi.fn(
      () => new Promise<Page<IssueComment>>((resolve) => (release = resolve))
    );
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments },
    });
    const controller = new AbortController();
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const pending = p.resolve("12", { signal: controller.signal });
    await vi.waitFor(() => expect(listIssueComments).toHaveBeenCalledTimes(1));
    controller.abort(new Error("timed out"));
    release(page([comment(1)], "more"));
    await pending;
    expect(listIssueComments).toHaveBeenCalledTimes(1);
  });

  it("keeps the comments read so far when the comments rate limit runs out", async () => {
    const listIssueComments = vi.fn(async () => page([comment(1)], "more"));
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments },
    });
    let commentChecks = 0;
    const d = deps(impl, {
      checkRateLimit: vi.fn(async (bucket: string) => {
        if (bucket === "comments" && ++commentChecks > 1) throw new Error("Rate limit exceeded");
      }),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    const text = (await p.resolve("12", { signal: signal() }))!.text;
    expect(listIssueComments).toHaveBeenCalledTimes(1);
    expect(text).toContain("Comments (1 of the first 1 read; newer comments may be missing):");
    expect(text).toContain("\ncomment 1");
  });

  it("reads nothing once the read rate limit is spent", async () => {
    const impl = provider({ getIssue: vi.fn(async () => issue()) });
    const d = deps(impl, {
      checkRateLimit: vi.fn(async (bucket: string) => {
        if (bucket === "read") throw new Error("Rate limit exceeded");
      }),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    await expect(p.resolve("12", { signal: signal() })).rejects.toThrow("Rate limit exceeded");
    expect(impl.getIssue).not.toHaveBeenCalled();
  });
});

describe("issue reads through the project's issues provider (#16382)", () => {
  beforeEach(() => {
    boundary.checkRateLimit.mockReset();
    boundary.auditForgeCall.mockReset();
    boundary.auditForgeCall.mockImplementation(async (_meta, run: () => Promise<unknown>) => run());
  });

  it("resolves the project's own path for the issues role and audits under its provider", async () => {
    const impl = provider({ getIssue: vi.fn(async () => issue()) });
    boundary.getProjectById.mockReturnValue({ path: "/work/app" });
    boundary.resolveForCwd.mockResolvedValue({
      impl,
      repoRef: REPO,
      namespaceId: "acme.linear",
      providerId: "linear",
      viaIssueOverride: true,
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity });
    expect((await p.resolve("12", { signal: signal() }))?.title).toBe("#12 Fix login");
    expect(boundary.getProjectById).toHaveBeenCalledWith("p1");
    expect(boundary.resolveForCwd).toHaveBeenCalledWith("/work/app", "issues");
    expect(impl.getIssue).toHaveBeenCalledWith(REPO, 12);
    expect(boundary.checkRateLimit).toHaveBeenCalledWith("context-provider:issue-read", 25, 10_000);
    expect(boundary.auditForgeCall).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "acme.linear", methodName: "getIssue" }),
      expect.any(Function)
    );
  });

  it("fails for a project that isn't open", async () => {
    boundary.getProjectById.mockReturnValue(null);
    const p = createIssueContextProvider("gone", { deadlineAt: Infinity });
    await expect(p.resolve("12", { signal: signal() })).rejects.toThrow("the project isn't open");
  });
});

describe("formatIssueContext (#16382)", () => {
  it("marks a cut description and stays within the content limit however long the thread", () => {
    const big = "x".repeat(50_000);
    const comments = Array.from({ length: 10 }, (_, i) => comment(i + 1, `marker-${i + 1} ${big}`));
    const content = formatIssueContext(issue({ body: big }), {
      kind: "complete",
      comments,
      total: 40,
    });
    const text = content.text;
    expect(text.length).toBeLessThanOrEqual(AGENT_CONTEXT_MAX_TEXT_LENGTH);
    expect(text).toContain("[… description cut short: 16,000 of 50,000 characters]");
    expect(text).toContain("[… comment cut short");
    const shown = [...text.matchAll(/marker-(\d+)/g)].map((m) => Number(m[1]));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(
      Array.from({ length: shown.length }, (_, i) => 10 - shown.length + 1 + i)
    );
    expect(text).toContain(`Comments (latest ${shown.length} of 40):`);
    expect(sanitizeContextProviderContent(content).ok).toBe(true);
  });

  it("says an issue has no description or comments rather than leaving them blank", () => {
    const text = formatIssueContext(issue({ body: "  " }), {
      kind: "complete",
      comments: [],
      total: 0,
    }).text;
    expect(text).toContain("Description:\n(none)");
    expect(text).toContain("Comments: none");
  });
});
