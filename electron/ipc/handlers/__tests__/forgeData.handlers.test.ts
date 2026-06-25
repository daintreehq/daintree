import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ForgeProviderImpl,
  Issue,
  PR,
  Page,
  RepoMetadata,
  RepoRef,
} from "../../../../shared/types/forge.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

// A fake forge provider — deliberately NOT GitHub. Proves the data handlers
// delegate through the normalized contract with no GitHub coupling.
const fakeImpl = vi.hoisted(() => ({
  listIssues: vi.fn(),
  listPRs: vi.fn(),
  getIssue: vi.fn(),
  getPR: vi.fn(),
  getRepoMetadata: vi.fn(),
}));

const repoRef: RepoRef = { host: "fake.test", owner: "acme", repo: "widgets", rawData: null };

const resolveForCwdMock = vi.hoisted(() => vi.fn());

vi.mock("../forgeResolution.js", () => ({
  resolveForCwd: resolveForCwdMock,
}));

// Default to "exists" so the existing stats tests reach the resolution path;
// the #10663 missing-directory guard test flips this to false explicitly.
const existsSyncMock = vi.hoisted(() => vi.fn().mockReturnValue(true));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: existsSyncMock,
}));

// The handlers transitively import the forge audit singleton, which imports
// the electron-store. Mock it so the singleton's read/write callbacks hit an
// in-memory map rather than constructing a real store under a mocked electron.
const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({
  store: storeMock,
  auditLogsStore: { get: vi.fn(() => []), set: vi.fn() },
}));

import { registerForgeDataHandlers } from "../forgeData.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { forgeAuditService } from "../../../services/forge/forgeAuditService.js";

function findHandler(channel: string): (...args: unknown[]) => unknown {
  const entry = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!entry) throw new Error(`handler not registered for ${channel}`);
  return entry[1] as (...args: unknown[]) => unknown;
}

const makeIssue = (n: number): Issue => ({
  number: n,
  title: `Issue ${n}`,
  body: "",
  state: "open",
  rawState: "opened",
  url: `https://fake.test/acme/widgets/issues/${n}`,
  assignees: [],
  labels: [],
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

const makePR = (n: number): PR => ({
  number: n,
  title: `PR ${n}`,
  body: "",
  state: "open",
  rawState: "opened",
  isDraft: false,
  merged: false,
  url: `https://fake.test/acme/widgets/pull/${n}`,
  baseRef: "main",
  headRef: `feat-${n}`,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

describe("registerForgeDataHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The handlers share a per-channel rate-limit budget (10 calls / 10s); a
    // suite-cumulative count would make later tests fail on call volume alone.
    _resetRateLimitQueuesForTest();
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: fakeImpl as unknown as ForgeProviderImpl,
    });
  });

  it("registers the core and capability IPC handlers", () => {
    const cleanup = registerForgeDataHandlers();
    // 6 core data handlers + the 11-op forgeCapabilityData namespace.
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(17);
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:list-issues", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:list-prs", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-issue", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-pr", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-repo-metadata",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-current-user", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-repo-stats", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-first-page-cache",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-project-health",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-issue-tooltip",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-pr-tooltip", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-issues-by-numbers",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-prs-by-numbers",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-pr-review-threads",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:resolve-author-avatar",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-token-health", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-rate-limit-details",
      expect.any(Function)
    );
    cleanup();
  });

  it("listIssues resolves the provider and returns its normalized page", async () => {
    const page: Page<Issue> = {
      items: [makeIssue(1), makeIssue(2)],
      nextCursor: null,
      hasMore: false,
    };
    fakeImpl.listIssues.mockResolvedValue(page);
    registerForgeDataHandlers();

    const result = await findHandler("forge:list-issues")(null, {
      cwd: "/repo",
      opts: { state: "open" },
    });

    expect(resolveForCwdMock).toHaveBeenCalledWith("/repo");
    expect(fakeImpl.listIssues).toHaveBeenCalledWith(repoRef, { state: "open" });
    expect(result).toEqual(page);
  });

  it("listIssues defaults opts to an empty object when omitted", async () => {
    fakeImpl.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    registerForgeDataHandlers();

    await findHandler("forge:list-issues")(null, { cwd: "/repo" });

    expect(fakeImpl.listIssues).toHaveBeenCalledWith(repoRef, {});
  });

  it("listPRs delegates to impl.listPRs", async () => {
    const page: Page<PR> = { items: [makePR(7)], nextCursor: "c1", hasMore: true };
    fakeImpl.listPRs.mockResolvedValue(page);
    registerForgeDataHandlers();

    const result = await findHandler("forge:list-prs")(null, { cwd: "/repo" });

    expect(fakeImpl.listPRs).toHaveBeenCalledWith(repoRef, {});
    expect(result).toEqual(page);
  });

  it("getIssue returns the issue", async () => {
    fakeImpl.getIssue.mockResolvedValue(makeIssue(42));
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-issue")(null, { cwd: "/repo", issueNumber: 42 });

    expect(fakeImpl.getIssue).toHaveBeenCalledWith(repoRef, 42);
    expect(result).toMatchObject({ number: 42 });
  });

  it("getIssue propagates a null result when the issue does not exist", async () => {
    fakeImpl.getIssue.mockResolvedValue(null);
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-issue")(null, { cwd: "/repo", issueNumber: 99 });

    expect(result).toBeNull();
  });

  it("getPR delegates to impl.getPR", async () => {
    fakeImpl.getPR.mockResolvedValue(makePR(5));
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-pr")(null, { cwd: "/repo", prNumber: 5 });

    expect(fakeImpl.getPR).toHaveBeenCalledWith(repoRef, 5);
    expect(result).toMatchObject({ number: 5 });
  });

  it("getRepoMetadata delegates to impl.getRepoMetadata", async () => {
    const meta: RepoMetadata = {
      defaultBranch: "main",
      isPrivate: false,
      isFork: false,
      isArchived: false,
      rawData: null,
    };
    fakeImpl.getRepoMetadata.mockResolvedValue(meta);
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-repo-metadata")(null, { cwd: "/repo" });

    expect(fakeImpl.getRepoMetadata).toHaveBeenCalledWith(repoRef);
    expect(result).toEqual(meta);
  });

  it("getRepoStats short-circuits to a zero snapshot when the project directory is gone (#10663)", async () => {
    // The project directory was deleted/moved externally; the renderer keeps
    // polling this handler. The guard must return a commits-only zero snapshot
    // without ever touching git resolution — otherwise each poll spams WARN.
    existsSyncMock.mockReturnValueOnce(false);
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-repo-stats")(null, { cwd: "/missing/path" });

    expect(resolveForCwdMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      commitCount: 0,
      issueCount: null,
      prCount: null,
      loading: false,
    });
  });

  it("getCurrentUser returns the identity projection when the impl exposes one", async () => {
    const user = {
      login: "ada",
      avatarUrl: "https://avatars.test/ada.png",
      rawData: { source: "fake.provider" },
    };
    const implWithIdentity = {
      ...fakeImpl,
      identity: { getCurrentUser: vi.fn().mockResolvedValue(user) },
    };
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: implWithIdentity as unknown as ForgeProviderImpl,
    });
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-current-user")(null, { cwd: "/repo" });

    expect(implWithIdentity.identity.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(result).toEqual(user);
  });

  it("getCurrentUser returns null when the provider has no identity capability", async () => {
    // No `identity` field on the impl — host falls back to `null` so callers
    // treat it as "no viewer" rather than throwing.
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-current-user")(null, { cwd: "/repo" });

    expect(result).toBeNull();
  });

  it("getCurrentUser does not write an audit record (read probe, matches getRateLimit)", async () => {
    // Lock in the no-audit-on-probe design intent. The audit ring should
    // not be flooded by every render-time identity probe fired on dialog
    // open; the `ForgeProviderMethodName` union carries the name for
    // type-exhaustiveness in `summarizeForgeArgs`, not because we audit it.
    fakeImpl.getRepoMetadata.mockResolvedValue({
      defaultBranch: "main",
      isPrivate: false,
      isFork: false,
      isArchived: false,
      rawData: null,
    });
    const user = { login: "ada", rawData: null };
    const implWithIdentity = {
      ...fakeImpl,
      identity: { getCurrentUser: vi.fn().mockResolvedValue(user) },
    };
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: implWithIdentity as unknown as ForgeProviderImpl,
    });
    const auditSpy = vi.spyOn(forgeAuditService, "appendRecord");
    registerForgeDataHandlers();

    for (let i = 0; i < 5; i++) {
      await findHandler("forge:get-current-user")(null, { cwd: "/repo" });
    }

    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid cwd before resolving a provider", async () => {
    registerForgeDataHandlers();
    await expect(findHandler("forge:list-issues")(null, { cwd: "" })).rejects.toThrow(
      "Invalid working directory"
    );
    expect(resolveForCwdMock).not.toHaveBeenCalled();
  });

  it("rejects a non-object payload", async () => {
    registerForgeDataHandlers();
    await expect(findHandler("forge:list-prs")(null, null)).rejects.toThrow("Invalid payload");
  });

  it("rejects a non-positive issue number", async () => {
    registerForgeDataHandlers();
    await expect(
      findHandler("forge:get-issue")(null, { cwd: "/repo", issueNumber: 0 })
    ).rejects.toThrow("Invalid issue number");
  });

  it("rejects a non-integer PR number", async () => {
    registerForgeDataHandlers();
    await expect(
      findHandler("forge:get-pr")(null, { cwd: "/repo", prNumber: 1.5 })
    ).rejects.toThrow("Invalid PR number");
  });

  it("coalesces concurrent identical getPR calls into one provider call", async () => {
    let resolveGetPR!: (pr: PR) => void;
    fakeImpl.getPR.mockReturnValue(new Promise<PR>((resolve) => (resolveGetPR = resolve)));
    registerForgeDataHandlers();
    const handler = findHandler("forge:get-pr");

    const p1 = handler(null, { cwd: "/repo", prNumber: 5 });
    const p2 = handler(null, { cwd: "/repo", prNumber: 5 });
    resolveGetPR(makePR(5));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fakeImpl.getPR).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ number: 5 });
    expect(r2).toMatchObject({ number: 5 });
  });

  it("does not coalesce calls that differ by PR number or cwd", async () => {
    fakeImpl.getPR.mockImplementation((_repo: RepoRef, n: number) => Promise.resolve(makePR(n)));
    registerForgeDataHandlers();
    const handler = findHandler("forge:get-pr");

    await Promise.all([
      handler(null, { cwd: "/repo", prNumber: 5 }),
      handler(null, { cwd: "/repo", prNumber: 6 }),
      handler(null, { cwd: "/other", prNumber: 5 }),
    ]);

    // Distinct (cwd, prNumber) keys → three independent provider calls; the
    // cwd dimension keeps separate projects from sharing a slot (#4832).
    expect(fakeImpl.getPR).toHaveBeenCalledTimes(3);
  });

  it("evicts a failed lookup immediately so the next caller retries", async () => {
    fakeImpl.getIssue
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(makeIssue(42));
    registerForgeDataHandlers();
    const handler = findHandler("forge:get-issue");

    await expect(handler(null, { cwd: "/repo", issueNumber: 42 })).rejects.toThrow("transient");
    // Immediate eviction on rejection: the retry runs the provider again
    // rather than returning the cached failed promise.
    const result = await handler(null, { cwd: "/repo", issueNumber: 42 });
    expect(result).toMatchObject({ number: 42 });
    expect(fakeImpl.getIssue).toHaveBeenCalledTimes(2);
  });

  it("treats list queries with embedded-comma labels as distinct (no false coalescing)", async () => {
    fakeImpl.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    registerForgeDataHandlers();
    const handler = findHandler("forge:list-issues");

    await Promise.all([
      handler(null, { cwd: "/repo", opts: { labels: ["a,b"] } }),
      handler(null, { cwd: "/repo", opts: { labels: ["a", "b"] } }),
    ]);

    // `["a,b"]` and `["a","b"]` are different queries — the JSON-tuple key keeps
    // them in separate in-flight slots instead of collapsing to one call.
    expect(fakeImpl.listIssues).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce list queries that differ only by search term", async () => {
    fakeImpl.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    registerForgeDataHandlers();
    const handler = findHandler("forge:list-issues");

    // The issue picker fires a new IPC call per debounced keystroke; a key
    // that omitted `search` would hand the second caller the first's result.
    await Promise.all([
      handler(null, { cwd: "/repo", opts: { state: "open", search: "auth" } }),
      handler(null, { cwd: "/repo", opts: { state: "open", search: "auth bug" } }),
      handler(null, { cwd: "/repo", opts: { state: "open" } }),
    ]);

    expect(fakeImpl.listIssues).toHaveBeenCalledTimes(3);
  });

  it("collapses repeat lookups within the TTL then re-runs after it elapses", async () => {
    vi.useFakeTimers();
    try {
      fakeImpl.getPR.mockResolvedValue(makePR(5));
      registerForgeDataHandlers();
      const handler = findHandler("forge:get-pr");

      await handler(null, { cwd: "/repo", prNumber: 5 });
      await handler(null, { cwd: "/repo", prNumber: 5 }); // within TTL → cached
      expect(fakeImpl.getPR).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(151); // TTL eviction fires
      await handler(null, { cwd: "/repo", prNumber: 5 }); // after TTL → re-run
      expect(fakeImpl.getPR).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates provider resolution failures (e.g. provider not activated)", async () => {
    resolveForCwdMock.mockRejectedValue(
      new Error("No forge provider registered for this repository")
    );
    registerForgeDataHandlers();
    await expect(findHandler("forge:list-issues")(null, { cwd: "/repo" })).rejects.toThrow(
      "No forge provider registered"
    );
  });

  describe("audit instrumentation", () => {
    let appendSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
    });

    it("emits one success record per resolved provider call", async () => {
      fakeImpl.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
      registerForgeDataHandlers();
      await findHandler("forge:list-issues")(null, { cwd: "/repo", opts: { state: "open" } });

      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "fake.provider",
          methodName: "listIssues",
          result: "success",
          repoOwner: "acme",
          repoName: "widgets",
        })
      );
    });

    it("classifies a null getIssue lookup as not-found", async () => {
      fakeImpl.getIssue.mockResolvedValue(null);
      registerForgeDataHandlers();
      await findHandler("forge:get-issue")(null, { cwd: "/repo", issueNumber: 99 });

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: "getIssue", result: "not-found" })
      );
    });

    it("records an error result and still rethrows when the provider throws", async () => {
      fakeImpl.getRepoMetadata.mockRejectedValue(new Error("rate limited"));
      registerForgeDataHandlers();

      await expect(findHandler("forge:get-repo-metadata")(null, { cwd: "/repo" })).rejects.toThrow(
        "rate limited"
      );
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          methodName: "getRepoMetadata",
          result: "error",
          errorMessage: "rate limited",
        })
      );
    });

    it("emits exactly one record for coalesced concurrent calls", async () => {
      let resolveGetPR!: (pr: PR) => void;
      fakeImpl.getPR.mockReturnValue(new Promise<PR>((resolve) => (resolveGetPR = resolve)));
      registerForgeDataHandlers();
      const handler = findHandler("forge:get-pr");

      const p1 = handler(null, { cwd: "/repo", prNumber: 5 });
      const p2 = handler(null, { cwd: "/repo", prNumber: 5 });
      resolveGetPR(makePR(5));
      await Promise.all([p1, p2]);

      // Audit lives inside the singleflight run() closure, so coalesced callers
      // share the single provider call and its single record — no double-count.
      expect(appendSpy).toHaveBeenCalledTimes(1);
    });

    it("never includes the assignee in the list args summary", async () => {
      fakeImpl.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
      registerForgeDataHandlers();
      await findHandler("forge:list-issues")(null, {
        cwd: "/repo",
        opts: { state: "open", assignee: "secret-user" },
      });

      const summary = (appendSpy.mock.calls[0]![0] as { argsSummary?: string }).argsSummary ?? "";
      expect(summary).not.toContain("secret-user");
    });
  });
});
