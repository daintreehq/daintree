import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ForgeProviderImpl,
  Issue,
  ListOptions,
  PR,
  PRLookupResult,
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
const fakeImpl = vi.hoisted(
  () =>
    ({
      listIssues: vi.fn(),
      listPRs: vi.fn(),
      getIssue: vi.fn(),
      getPR: vi.fn(),
      getCIStatus: vi.fn(),
      getRepoMetadata: vi.fn(),
      // Optional on the provider contract, and the batch tests below toggle it
      // between present and absent to exercise both routes.
      batchLookups: undefined as { findPRsByNumbers?: ReturnType<typeof vi.fn> } | undefined,
    }) as {
      listIssues: ReturnType<typeof vi.fn>;
      listPRs: ReturnType<typeof vi.fn>;
      getIssue: ReturnType<typeof vi.fn>;
      getPR: ReturnType<typeof vi.fn>;
      getCIStatus: ReturnType<typeof vi.fn>;
      getRepoMetadata: ReturnType<typeof vi.fn>;
      batchLookups?: { findPRsByNumbers?: ReturnType<typeof vi.fn> };
    }
);

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
    // 6 core data handlers + the 14-op forgeCapabilityData namespace.
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(20);
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:list-issues", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:list-prs", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-issue", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-pr", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-ci-status", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-checks", expect.any(Function));
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
      "forge:list-issue-comments",
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

  // Each getCIStatus test uses a distinct PR number: the CI single-flight is
  // module-scoped (shared process-wide so duplicate polls don't each write an
  // audit record), so a repeated key would collapse across tests within the TTL.
  describe("getCIStatus", () => {
    let appendSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
    });

    // Distinct sentinel counts: with duplicate values a swapped field mapping
    // in projectCIStatus would still satisfy the assertions below.
    const fullStatus = {
      state: "failure" as const,
      total: 9,
      passed: 5,
      failed: 3,
      pending: 1,
      requiredChecksPassing: false,
      freshnessToken: "etag-abc",
      notModified: false,
      rawData: { checkRuns: [{ name: "build", conclusion: "failure" }] },
    };

    it("strips provider transport fields and maps each count to the same field", async () => {
      fakeImpl.getCIStatus.mockResolvedValue(fullStatus);
      registerForgeDataHandlers();

      const result = await findHandler("forge:get-ci-status")(null, {
        cwd: "/repo",
        prNumber: 900,
      });

      expect(fakeImpl.getCIStatus).toHaveBeenCalledWith(repoRef, 900);
      // Exact object, not a key list: this pins both that no provider field
      // leaks through and that no count is transposed on the way out.
      expect(result).toStrictEqual({
        state: "failure",
        total: 9,
        passed: 5,
        failed: 3,
        pending: 1,
        requiredChecksPassing: false,
      });
    });

    it("preserves requiredChecksPassing:false rather than dropping it as falsy", async () => {
      fakeImpl.getCIStatus.mockResolvedValue({ ...fullStatus, requiredChecksPassing: false });
      registerForgeDataHandlers();

      const result = (await findHandler("forge:get-ci-status")(null, {
        cwd: "/repo",
        prNumber: 901,
      })) as Record<string, unknown>;

      expect(result.requiredChecksPassing).toBe(false);
    });

    it("omits requiredChecksPassing entirely when the provider doesn't gate", async () => {
      const { requiredChecksPassing: _omitted, ...ungated } = fullStatus;
      fakeImpl.getCIStatus.mockResolvedValue({ ...ungated, state: "neutral", total: 0 });
      registerForgeDataHandlers();

      const result = (await findHandler("forge:get-ci-status")(null, {
        cwd: "/repo",
        prNumber: 902,
      })) as Record<string, unknown>;

      expect("requiredChecksPassing" in result).toBe(false);
    });

    it("passes a null lookup through and audits it as not-found", async () => {
      fakeImpl.getCIStatus.mockResolvedValue(null);
      registerForgeDataHandlers();

      const result = await findHandler("forge:get-ci-status")(null, {
        cwd: "/repo",
        prNumber: 903,
      });

      expect(result).toBeNull();
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: "getCIStatus", result: "not-found" })
      );
    });

    it("coalesces concurrent identical calls into one provider call and one audit record", async () => {
      fakeImpl.getCIStatus.mockResolvedValue(fullStatus);
      registerForgeDataHandlers();
      const handler = findHandler("forge:get-ci-status");

      await Promise.all([
        handler(null, { cwd: "/repo", prNumber: 904 }),
        handler(null, { cwd: "/repo", prNumber: 904 }),
      ]);

      expect(fakeImpl.getCIStatus).toHaveBeenCalledTimes(1);
      expect(appendSpy).toHaveBeenCalledTimes(1);
    });

    it("does not coalesce calls that differ by PR number", async () => {
      fakeImpl.getCIStatus.mockResolvedValue(fullStatus);
      registerForgeDataHandlers();
      const handler = findHandler("forge:get-ci-status");

      await Promise.all([
        handler(null, { cwd: "/repo", prNumber: 905 }),
        handler(null, { cwd: "/repo", prNumber: 906 }),
      ]);

      expect(fakeImpl.getCIStatus).toHaveBeenCalledTimes(2);
    });

    it("does not share a slot across worktrees for the same PR number", async () => {
      // The single-flight map is process-wide, so `cwd` in the key is the only
      // thing keeping two checkouts of the same repo apart. Dropping it would
      // serve one worktree's CI state for another.
      fakeImpl.getCIStatus.mockResolvedValue(fullStatus);
      registerForgeDataHandlers();
      const handler = findHandler("forge:get-ci-status");

      await Promise.all([
        handler(null, { cwd: "/repo-a", prNumber: 907 }),
        handler(null, { cwd: "/repo-b", prNumber: 907 }),
      ]);

      expect(fakeImpl.getCIStatus).toHaveBeenCalledTimes(2);
    });

    it("evicts a rejected lookup so the next caller retries and is audited as error", async () => {
      fakeImpl.getCIStatus.mockRejectedValueOnce(new Error("rate limited"));
      registerForgeDataHandlers();
      const handler = findHandler("forge:get-ci-status");

      await expect(handler(null, { cwd: "/repo", prNumber: 908 })).rejects.toThrow("rate limited");
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          methodName: "getCIStatus",
          result: "error",
          errorMessage: "rate limited",
        })
      );

      fakeImpl.getCIStatus.mockResolvedValue(fullStatus);
      await handler(null, { cwd: "/repo", prNumber: 908 });
      // A failed lookup must not be cached as the in-flight answer.
      expect(fakeImpl.getCIStatus).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["undefined", undefined],
      ["a non-object", "green"],
      ["an unknown state", { ...fullStatus, state: "banana" }],
      ["a fractional count", { ...fullStatus, total: 1.5 }],
      ["a negative count", { ...fullStatus, failed: -1 }],
      ["a missing count", { state: "success", total: 1, passed: 1, failed: 0 }],
    ])("rejects %s from the provider as an error, not a missing PR", async (_label, bad) => {
      // Providers are plugin-supplied and this action is reachable by external
      // API-key callers, so off-contract output must surface as an error rather
      // than be laundered into "PR not found" or forwarded to a strict client.
      fakeImpl.getCIStatus.mockResolvedValue(bad);
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:get-ci-status")(null, { cwd: `/repo-${String(_label)}`, prNumber: 909 })
      ).rejects.toThrow(/malformed CI status/);
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: "getCIStatus", result: "error" })
      );
    });

    it("accepts a required-checks-free red PR (state failure with zero counts)", async () => {
      // Real GitHub output: with no required checks configured the provider
      // falls back to the raw rollup, so `state` can be 'failure' while every
      // count is 0. The validator must not treat that as malformed.
      fakeImpl.getCIStatus.mockResolvedValue({
        state: "failure",
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        rawData: null,
      });
      registerForgeDataHandlers();

      const result = await findHandler("forge:get-ci-status")(null, {
        cwd: "/repo",
        prNumber: 910,
      });

      expect(result).toStrictEqual({
        state: "failure",
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
      });
    });

    it("rejects a non-positive PR number before resolving a provider", async () => {
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:get-ci-status")(null, { cwd: "/repo", prNumber: 0 })
      ).rejects.toThrow();
      expect(fakeImpl.getCIStatus).not.toHaveBeenCalled();
    });
  });

  // Distinct PR numbers per test for the same reason as getCIStatus above: the
  // checks single-flight is module-scoped and outlives an individual test.
  describe("getChecks", () => {
    let appendSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
    });

    const fullCheck = {
      name: "build",
      status: "completed" as const,
      conclusion: "failure" as const,
      required: true,
      detailsUrl: "https://ci.test/build/7",
      rawData: { id: 1, extra: "provider-internal" },
    };

    function withChecks(checks: unknown[]) {
      return { ...fakeImpl, checks: { getChecks: vi.fn().mockResolvedValue({ checks }) } };
    }

    function useImpl(impl: unknown) {
      resolveForCwdMock.mockResolvedValue({
        namespaceId: "fake.provider",
        repoRef,
        impl: impl as unknown as ForgeProviderImpl,
      });
    }

    it("delegates to the capability and strips rawData on the way out", async () => {
      const impl = withChecks([fullCheck]);
      useImpl(impl);
      registerForgeDataHandlers();

      const result = await findHandler("forge:get-checks")(null, {
        cwd: "/repo",
        prNumber: 700,
      });

      expect(impl.checks.getChecks).toHaveBeenCalledWith(repoRef, 700);
      // Exact object: pins that no provider-internal field rides along.
      expect(result).toStrictEqual({
        checks: [
          {
            name: "build",
            status: "completed",
            conclusion: "failure",
            required: true,
            detailsUrl: "https://ci.test/build/7",
          },
        ],
      });
    });

    it("preserves required:false rather than dropping it as falsy", async () => {
      useImpl(withChecks([{ ...fullCheck, required: false }]));
      registerForgeDataHandlers();

      const result = (await findHandler("forge:get-checks")(null, {
        cwd: "/repo",
        prNumber: 701,
      })) as { checks: Array<Record<string, unknown>> };

      expect(result.checks[0].required).toBe(false);
    });

    it("omits optional fields the provider did not report", async () => {
      useImpl(withChecks([{ name: "pending-check", status: "queued", rawData: null }]));
      registerForgeDataHandlers();

      const result = (await findHandler("forge:get-checks")(null, {
        cwd: "/repo",
        prNumber: 702,
      })) as { checks: Array<Record<string, unknown>> };

      expect(result.checks[0]).toStrictEqual({ name: "pending-check", status: "queued" });
    });

    it("distinguishes a missing PR from a PR with no checks", async () => {
      // null and [] lead a caller to opposite conclusions, so the handler must
      // never collapse one into the other.
      useImpl({ ...fakeImpl, checks: { getChecks: vi.fn().mockResolvedValue(null) } });
      registerForgeDataHandlers();
      expect(
        await findHandler("forge:get-checks")(null, { cwd: "/repo", prNumber: 703 })
      ).toBeNull();
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: "getChecks", result: "not-found" })
      );

      vi.clearAllMocks();
      _resetRateLimitQueuesForTest();
      useImpl(withChecks([]));
      registerForgeDataHandlers();
      expect(await findHandler("forge:get-checks")(null, { cwd: "/repo", prNumber: 704 })).toEqual({
        checks: [],
      });
    });

    it("rejects when the provider has no checks capability", async () => {
      // An empty list would read as "everything passed" rather than
      // "this provider cannot look" — the repoStats/listIssueComments rule.
      useImpl(fakeImpl);
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:get-checks")(null, { cwd: "/repo", prNumber: 705 })
      ).rejects.toThrow(/does not support/i);
    });

    it.each([
      ["a non-array result", { checks: "green" }],
      ["a nameless check", { checks: [{ status: "completed", rawData: null }] }],
      ["an empty name", { checks: [{ name: "", status: "completed", rawData: null }] }],
      ["an unknown status", { checks: [{ name: "a", status: "running", rawData: null }] }],
      [
        "an unknown conclusion",
        { checks: [{ name: "a", status: "completed", conclusion: "exploded", rawData: null }] },
      ],
      [
        "a non-boolean required",
        { checks: [{ name: "a", status: "completed", required: "yes", rawData: null }] },
      ],
      [
        "a blank name",
        { checks: [{ name: "   ", status: "completed", conclusion: "failure", rawData: null }] },
      ],
      [
        // "running, and it passed" is two contradictory claims under a schema
        // that advertises neither as possible.
        "a conclusion on a check that has not completed",
        {
          checks: [{ name: "a", status: "in_progress", conclusion: "success", rawData: null }],
        },
      ],
    ])("rejects %s from the provider as an error, not a missing PR", async (label, bad) => {
      useImpl({ ...fakeImpl, checks: { getChecks: vi.fn().mockResolvedValue(bad) } });
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:get-checks")(null, { cwd: `/repo-${label}`, prNumber: 706 })
      ).rejects.toThrow(/malformed check/);
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: "getChecks", result: "error" })
      );
    });

    it("coalesces concurrent identical reads but not different PRs or worktrees", async () => {
      const impl = withChecks([fullCheck]);
      useImpl(impl);
      registerForgeDataHandlers();
      const handler = findHandler("forge:get-checks");

      await Promise.all([
        handler(null, { cwd: "/repo", prNumber: 707 }),
        handler(null, { cwd: "/repo", prNumber: 707 }),
      ]);
      expect(impl.checks.getChecks).toHaveBeenCalledTimes(1);

      await Promise.all([
        handler(null, { cwd: "/repo", prNumber: 708 }),
        handler(null, { cwd: "/other-worktree", prNumber: 708 }),
      ]);
      expect(impl.checks.getChecks).toHaveBeenCalledTimes(3);
    });

    it("rejects a non-positive PR number before resolving a provider", async () => {
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:get-checks")(null, { cwd: "/repo", prNumber: 0 })
      ).rejects.toThrow();
      expect(resolveForCwdMock).not.toHaveBeenCalled();
    });
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
    // The guard must check the cwd itself, not a parent or derived path.
    expect(existsSyncMock).toHaveBeenCalledWith("/missing/path");
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

  describe("listIssueComments", () => {
    const comment = {
      id: "101",
      body: "any progress here?",
      url: "https://fake.test/acme/widgets/issues/7#comment-101",
      createdAt: 1,
      rawData: null,
    };

    function implWithComments(listIssueComments: ReturnType<typeof vi.fn>) {
      return { ...fakeImpl, issueComments: { listIssueComments } };
    }

    it("delegates to the capability and returns its page verbatim", async () => {
      const page = { items: [comment], nextCursor: "c2", hasMore: true, totalCount: 9 };
      const listIssueComments = vi.fn().mockResolvedValue(page);
      resolveForCwdMock.mockResolvedValue({
        namespaceId: "fake.provider",
        repoRef,
        impl: implWithComments(listIssueComments) as unknown as ForgeProviderImpl,
      });
      registerForgeDataHandlers();

      const result = await findHandler("forge:list-issue-comments")(null, {
        cwd: "/repo",
        issueNumber: 7,
        opts: { cursor: "c1", perPage: 50 },
      });

      expect(listIssueComments).toHaveBeenCalledWith(repoRef, 7, { cursor: "c1", perPage: 50 });
      expect(result).toEqual(page);
    });

    it("defaults opts to an empty object when omitted", async () => {
      const listIssueComments = vi
        .fn()
        .mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
      resolveForCwdMock.mockResolvedValue({
        namespaceId: "fake.provider",
        repoRef,
        impl: implWithComments(listIssueComments) as unknown as ForgeProviderImpl,
      });
      registerForgeDataHandlers();

      await findHandler("forge:list-issue-comments")(null, { cwd: "/repo", issueNumber: 7 });

      expect(listIssueComments).toHaveBeenCalledWith(repoRef, 7, {});
    });

    it("throws when the provider lacks the capability, so silence is never faked", async () => {
      // `fakeImpl` has no `issueComments` field. An empty page here would tell
      // an agent "nobody replied" when the truth is "nobody could look".
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:list-issue-comments")(null, { cwd: "/repo", issueNumber: 7 })
      ).rejects.toThrow(/does not support reading issue comments/i);
    });

    it("strips option fields the read does not honor and drops malformed ones", async () => {
      // The preload types `opts` loosely, so a direct renderer call can put
      // anything here — only the action's zod schema guards agent callers.
      const listIssueComments = vi
        .fn()
        .mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
      resolveForCwdMock.mockResolvedValue({
        namespaceId: "fake.provider",
        repoRef,
        impl: implWithComments(listIssueComments) as unknown as ForgeProviderImpl,
      });
      registerForgeDataHandlers();

      await findHandler("forge:list-issue-comments")(null, {
        cwd: "/repo",
        issueNumber: 7,
        opts: {
          perPage: Number.NaN,
          cursor: 42,
          bypassCache: "yes",
          state: "closed",
          search: "drop me",
        },
      });

      expect(listIssueComments).toHaveBeenCalledWith(repoRef, 7, {});
    });

    it("rejects a non-positive or non-integer issue number before resolving a provider", async () => {
      registerForgeDataHandlers();
      const handler = findHandler("forge:list-issue-comments");

      for (const issueNumber of [0, -1, 1.5, "7", null, undefined]) {
        await expect(handler(null, { cwd: "/repo", issueNumber })).rejects.toThrow(
          /invalid issue number/i
        );
      }
      expect(resolveForCwdMock).not.toHaveBeenCalled();
    });

    it("rejects a blank cwd", async () => {
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:list-issue-comments")(null, { cwd: "   ", issueNumber: 7 })
      ).rejects.toThrow(/invalid working directory/i);
      expect(resolveForCwdMock).not.toHaveBeenCalled();
    });

    it("propagates a capability failure instead of masking it as an empty thread", async () => {
      const listIssueComments = vi.fn().mockRejectedValue(new Error("Bad credentials"));
      resolveForCwdMock.mockResolvedValue({
        namespaceId: "fake.provider",
        repoRef,
        impl: implWithComments(listIssueComments) as unknown as ForgeProviderImpl,
      });
      registerForgeDataHandlers();

      await expect(
        findHandler("forge:list-issue-comments")(null, { cwd: "/repo", issueNumber: 7 })
      ).rejects.toThrow(/bad credentials/i);
    });
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

  it("never joins a bypassCache list call onto a concurrent cache-first flight", async () => {
    // `bypassCache` is the only escape from a warm list cache. If the key
    // omitted it, the bypassing caller would be handed the cache-first
    // caller's payload and never reach the provider at all.
    fakeImpl.listIssues.mockImplementation((_repo: RepoRef, opts: ListOptions) =>
      Promise.resolve({
        items: [makeIssue(opts.bypassCache ? 2 : 1)],
        nextCursor: null,
        hasMore: false,
      })
    );
    registerForgeDataHandlers();
    const handler = findHandler("forge:list-issues");

    // The cache-first call registers its in-flight slot first; the bypassing
    // one must open its own rather than joining it.
    const [cacheFirst, bypassing] = await Promise.all([
      handler(null, { cwd: "/repo", opts: { state: "open" } }),
      handler(null, { cwd: "/repo", opts: { state: "open", bypassCache: true } }),
    ]);

    expect(fakeImpl.listIssues).toHaveBeenCalledTimes(2);
    expect(fakeImpl.listIssues).toHaveBeenCalledWith(repoRef, {
      state: "open",
      bypassCache: true,
    });
    expect(bypassing).toMatchObject({ items: [{ number: 2 }] });
    expect(cacheFirst).toMatchObject({ items: [{ number: 1 }] });
  });

  it("still collapses an omitted bypassCache with an explicit false", async () => {
    fakeImpl.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    registerForgeDataHandlers();
    const handler = findHandler("forge:list-issues");

    // Same query, spelled two ways — normalizing to `false` keeps the mount
    // burst collapsing instead of splitting into two provider calls.
    await Promise.all([
      handler(null, { cwd: "/repo", opts: { state: "open" } }),
      handler(null, { cwd: "/repo", opts: { state: "open", bypassCache: false } }),
    ]);

    expect(fakeImpl.listIssues).toHaveBeenCalledTimes(1);
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

  // The distinction these hold is the whole reason the handler exists: an
  // explicit `null` from the provider means "asked, no such PR", while a key
  // absent from the map means the request carrying that number never landed.
  // The previous shape returned `PR[]` built from a truthiness test and erased
  // both into the same silence, so a rate-limited lookup was indistinguishable
  // from a deleted PR — and a caller acting on it closes work that exists.
  describe("forge:get-prs-by-numbers", () => {
    const handler =
      () =>
      (...args: unknown[]): Promise<PRLookupResult[]> => {
        registerForgeDataHandlers();
        return findHandler("forge:get-prs-by-numbers")(...args) as Promise<PRLookupResult[]>;
      };

    it("returns one entry per requested number, in the requested order", async () => {
      fakeImpl.batchLookups = {
        findPRsByNumbers: vi.fn(
          async () =>
            new Map([
              [7, makePR(7)],
              [3, makePR(3)],
            ])
        ),
      };
      const result = await handler()({}, { cwd: "/repo", numbers: [7, 3] });
      expect(result.map((r) => r.number)).toEqual([7, 3]);
      expect(result.every((r) => r.status === "found")).toBe(true);
    });

    it("reports an explicit null as not_found and an omitted key as unresolved", async () => {
      fakeImpl.batchLookups = {
        findPRsByNumbers: vi.fn(
          async () =>
            new Map<number, PR | null>([
              [1, makePR(1)],
              // Asked, and the forge says there is no such PR.
              [2, null],
              // 3 is deliberately absent: its chunk never produced an answer.
            ])
        ),
      };
      const result = await handler()({}, { cwd: "/repo", numbers: [1, 2, 3] });
      expect(result).toEqual([
        { number: 1, status: "found", pr: makePR(1) },
        { number: 2, status: "not_found" },
        { number: 3, status: "unresolved", reason: "provider_error" },
      ]);
    });

    it("falls back to the singular read when the provider has no batch capability", async () => {
      // The old handler returned `[]` here, which reads as "none of these
      // exist" — a claim it had no basis for, about a provider it never asked.
      delete fakeImpl.batchLookups;
      fakeImpl.getPR.mockImplementation(async (_repo: RepoRef, n: number) =>
        n === 2 ? null : makePR(n)
      );
      const result = await handler()({}, { cwd: "/repo", numbers: [1, 2] });
      expect(result).toEqual([
        { number: 1, status: "found", pr: makePR(1) },
        { number: 2, status: "not_found" },
      ]);
    });

    it("keeps going past a failing number in the singular fallback", async () => {
      // The failure is in the MIDDLE and the whole array is asserted: a handler
      // that aborted the loop would truncate every number after it, and a test
      // that only checked the failing index would not notice.
      delete fakeImpl.batchLookups;
      fakeImpl.getPR.mockImplementation(async (_repo: RepoRef, n: number) => {
        if (n === 2) throw new Error("rate limited");
        return makePR(n);
      });
      const result = await handler()({}, { cwd: "/repo", numbers: [1, 2, 3] });
      expect(result).toEqual([
        { number: 1, status: "found", pr: makePR(1) },
        // No batch capability and the per-number fallback did not land either,
        // which is what `provider_unsupported` is advertised to mean.
        { number: 2, status: "unresolved", reason: "provider_unsupported" },
        { number: 3, status: "found", pr: makePR(3) },
      ]);
    });

    it("resolves nothing — and says so — when the whole batch throws", async () => {
      fakeImpl.batchLookups = {
        findPRsByNumbers: vi.fn(async () => {
          throw new Error("provider exploded");
        }),
      };
      const result = await handler()({}, { cwd: "/repo", numbers: [4, 5] });
      expect(result).toEqual([
        { number: 4, status: "unresolved", reason: "provider_error" },
        { number: 5, status: "unresolved", reason: "provider_error" },
      ]);
    });

    it("collapses duplicates to their first occurrence", async () => {
      const findPRsByNumbers = vi.fn(async () => new Map([[9, makePR(9)]]));
      fakeImpl.batchLookups = { findPRsByNumbers };
      const result = await handler()({}, { cwd: "/repo", numbers: [9, 9, 9] });
      expect(result).toEqual([{ number: 9, status: "found", pr: makePR(9) }]);
      // The provider is asked once, not three times.
      expect(findPRsByNumbers).toHaveBeenCalledWith(repoRef, [9]);
    });

    it("drops non-positive and non-integer numbers before asking the provider", async () => {
      const findPRsByNumbers = vi.fn(async () => new Map([[2, makePR(2)]]));
      fakeImpl.batchLookups = { findPRsByNumbers };
      const result = await handler()({}, { cwd: "/repo", numbers: [0, -1, 1.5, 2] });
      expect(result).toEqual([{ number: 2, status: "found", pr: makePR(2) }]);
      expect(findPRsByNumbers).toHaveBeenCalledWith(repoRef, [2]);
    });
  });
});
