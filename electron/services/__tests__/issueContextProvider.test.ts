import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "../../../shared/types/forge.js";
import { AGENT_CONTEXT_MAX_TEXT_LENGTH } from "../../../shared/utils/agentContextDrag.js";
import { sanitizeContextProviderContent } from "../../../shared/utils/pluginContextSanitize.js";

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
  const source: IssueSource = {
    impl,
    repo: { host: "example.test", owner: "acme", repo: "app", rawData: null },
    namespaceId: "acme.forge",
  };
  return {
    resolveSource: vi.fn(async () => source),
    checkRateLimit: vi.fn(async () => {}),
    audit: vi.fn(async (_meta: unknown, run: () => Promise<unknown>) => run()),
    now: () => Date.now(),
    ...overrides,
  } as IssueContextDeps & { resolveSource: ReturnType<typeof vi.fn> };
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

  it("offers nothing of its own to a view with no project", () => {
    expect(withHostContextProviders([], null)).toEqual([]);
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
    expect(impl.listIssues).toHaveBeenCalledWith(expect.anything(), { state: "open", perPage: 50 });
    expect(impl.getIssue).not.toHaveBeenCalled();
  });

  it("puts the exact number first and searches every state for it", async () => {
    const impl = provider({
      getIssue: vi.fn(async () => issue({ number: 123, title: "Old one", state: "closed" })),
      listIssues: vi.fn(async () => page([issue(), issue({ number: 123, title: "Old one" })])),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const rows = await search(p, "#123");
    expect(rows.map((r) => r.id)).toEqual(["123", "12"]);
    expect(impl.getIssue).toHaveBeenCalledWith(expect.anything(), 123);
    expect(impl.listIssues).toHaveBeenCalledWith(expect.anything(), {
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
    expect(impl.getIssueById).toHaveBeenCalledWith(expect.anything(), "ENG-5");
    expect(impl.getIssue).not.toHaveBeenCalled();
  });

  it("answers only the newest search in a project, without reaching the forge for the rest", async () => {
    const impl = provider({ listIssues: vi.fn(async () => page([issue()])) });
    const d = deps(impl);
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    const first = p.search("f", { signal: signal() });
    const second = p.search("fi", { signal: signal() });
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toEqual([]);
    expect(await second).toHaveLength(1);
    expect(d.resolveSource).toHaveBeenCalledTimes(1);
  });

  it("keeps the exact hit when the list fails, and fails when nothing answers", async () => {
    const impl = provider({
      getIssue: vi.fn(async () => issue({ number: 4 })),
      listIssues: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    expect((await search(p, "4")).map((r) => r.id)).toEqual(["4"]);
    const failing = search(p, "login");
    await expect(failing).rejects.toThrow("rate limited");
  });

  it("stops when the host stops waiting", async () => {
    const d = deps(provider());
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    const controller = new AbortController();
    const pending = p.search("x", { signal: controller.signal });
    controller.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow("timed out");
    expect(d.resolveSource).not.toHaveBeenCalled();
  });
});

describe("issue resolve (#16382)", () => {
  it("reads an issue by number, with its whole discussion when it fits", async () => {
    const impl = provider({
      getIssue: vi.fn(async () => issue({ commentCount: 2 })),
      issueComments: {
        listIssueComments: vi.fn(async () => page([comment(1), comment(2)])),
      },
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const content = await p.resolve("12", { signal: signal() });
    expect(content?.title).toBe("#12 Fix login");
    const text = content!.text;
    expect(text.split("\n")[0]).toMatch(/untrusted/i);
    expect(text).toContain("Issue: #12 Fix login");
    expect(text).toContain("Link: https://example.test/acme/app/issues/12");
    expect(text).toContain("State: open");
    expect(text).toContain("Steps to reproduce");
    expect(text).toContain("Comments (all 2):");
    expect(text.indexOf("comment 1")).toBeLessThan(text.indexOf("comment 2"));
    expect(text).toContain("--- user1 · 2026-11-01 12:01 UTC");
  });

  it("reads a keyed issue by key and says when the provider shares no comments", async () => {
    const impl = provider({
      getIssueById: vi.fn(async () =>
        issue({ key: "ENG-5", rawState: "In Progress", url: "", commentCount: 3 })
      ),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const text = (await p.resolve("ENG-5", { signal: signal() }))!.text;
    expect(impl.getIssueById).toHaveBeenCalledWith(expect.anything(), "ENG-5");
    expect(text).toContain("State: open (In Progress)");
    expect(text).toContain("Link: none");
    expect(text).toContain("doesn't share them (the issue has 3)");
  });

  it("refuses a key on a provider that only finds issues by number", async () => {
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(provider()) });
    await expect(p.resolve("ENG-5", { signal: signal() })).rejects.toThrow("by number only");
  });

  it("is not found when the issue is gone", async () => {
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(provider()) });
    expect(await p.resolve("99", { signal: signal() })).toBeNull();
  });

  it("keeps the latest comments once the thread's end is reached", async () => {
    const all = Array.from({ length: 25 }, (_, i) => comment(i + 1));
    const listIssueComments = vi.fn(async (_r: unknown, _n: number, opts: { cursor?: string }) =>
      opts.cursor ? page(all.slice(20)) : page(all.slice(0, 20), "next")
    );
    const impl = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments },
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(impl) });
    const text = (await p.resolve("12", { signal: signal() }))!.text;
    expect(text).toContain("Comments (latest 10 of 25):");
    expect(text).toContain("comment 25");
    expect(text).toContain("comment 16");
    expect(text).not.toContain("comment 15\n");
    expect(listIssueComments).toHaveBeenCalledTimes(2);
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

  it("still attaches the issue when its comments can't be read, or run out of time", async () => {
    vi.useFakeTimers();
    const failing = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: {
        listIssueComments: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: deps(failing) });
    expect((await p.resolve("12", { signal: signal() }))!.text).toContain(
      "Comments: couldn't be read"
    );

    const slow = provider({
      getIssue: vi.fn(async () => issue()),
      issueComments: { listIssueComments: vi.fn(() => new Promise<never>(() => {})) },
    });
    const deadlineAt = Date.now() + 1_000;
    const q = createIssueContextProvider("p1", { deadlineAt, deps: deps(slow) });
    const pending = q.resolve("12", { signal: signal() });
    await vi.advanceTimersByTimeAsync(700);
    expect((await pending)!.text).toContain("Comments: couldn't be read");
  });

  it("asks for nothing past the rate limit", async () => {
    const impl = provider({ getIssue: vi.fn(async () => issue()) });
    const d = deps(impl, {
      checkRateLimit: vi.fn(async () => {
        throw new Error("Rate limit exceeded");
      }),
    });
    const p = createIssueContextProvider("p1", { deadlineAt: Infinity, deps: d });
    await expect(p.resolve("12", { signal: signal() })).rejects.toThrow("Rate limit exceeded");
    expect(impl.getIssue).not.toHaveBeenCalled();
  });
});

describe("formatIssueContext (#16382)", () => {
  it("marks a cut description and stays within the content limit however long the thread", () => {
    const big = "x".repeat(50_000);
    const comments = Array.from({ length: 10 }, (_, i) => comment(i + 1, big));
    const content = formatIssueContext(issue({ body: big }), {
      kind: "complete",
      comments,
      total: 40,
    });
    expect(content.text.length).toBeLessThanOrEqual(AGENT_CONTEXT_MAX_TEXT_LENGTH);
    expect(content.text).toContain("[… description cut short: 16,000 of 50,000 characters]");
    expect(content.text).toContain("[… comment cut short");
    expect(content.text).toMatch(/Comments \(latest \d of 40\):/);
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
