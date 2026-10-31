import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ForgeNumberReference,
  ForgeProviderImpl,
  ForgeReferenceLookupResult,
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
      getCredentials: vi.fn(async (): Promise<unknown> => ({ kind: "bearer", value: "token" })),
      // Optional on the provider contract, and the batch tests below toggle it
      // between present and absent to exercise both routes.
      batchLookups: undefined as
        | {
            findPRsByNumbers?: ReturnType<typeof vi.fn>;
            findReferencesByNumbers?: ReturnType<typeof vi.fn>;
          }
        | undefined,
    }) as {
      listIssues: ReturnType<typeof vi.fn>;
      listPRs: ReturnType<typeof vi.fn>;
      getIssue: ReturnType<typeof vi.fn>;
      getPR: ReturnType<typeof vi.fn>;
      getCIStatus: ReturnType<typeof vi.fn>;
      getRepoMetadata: ReturnType<typeof vi.fn>;
      getCredentials: ReturnType<typeof vi.fn>;
      batchLookups?: {
        findPRsByNumbers?: ReturnType<typeof vi.fn>;
        findReferencesByNumbers?: ReturnType<typeof vi.fn>;
      };
    }
);

const repoRef: RepoRef = { host: "fake.test", owner: "acme", repo: "widgets", rawData: null };

const resolveForCwdMock = vi.hoisted(() => vi.fn());
const resolveIssueOverrideForCwdMock = vi.hoisted(() => vi.fn(async () => null as unknown));
const resolveIssueLinkForCwdMock = vi.hoisted(() => vi.fn());
const getIssueForLinkMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => undefined));

vi.mock("../forgeResolution.js", () => ({
  resolveForCwd: resolveForCwdMock,
  resolveIssueOverrideForCwd: resolveIssueOverrideForCwdMock,
  resolveIssueLinkForCwd: resolveIssueLinkForCwdMock,
  getIssueForLink: getIssueForLinkMock,
  readIssueLinkTarget: (payload: Record<string, unknown>) => {
    const target: Record<string, unknown> = {};
    for (const key of ["role", "issueProviderId", "issueId", "issueKey"]) {
      if (payload[key] !== undefined) target[key] = payload[key];
    }
    return Object.keys(target).length > 0 ? target : undefined;
  },
  issueToTooltipData: (issue: { number: number; title: string }) => ({
    number: issue.number,
    title: issue.title,
    fromIssue: true,
  }),
  // Mirrors the real stamps: only an issues-override context marks its issues.
  stampIssueProvider: (
    context: { viaIssueOverride?: boolean; namespaceId: string },
    issue: object | null
  ) => (context.viaIssueOverride && issue ? { ...issue, providerId: context.namespaceId } : issue),
  stampIssuePageProvider: (
    context: { viaIssueOverride?: boolean; namespaceId: string },
    page: { items: object[] }
  ) =>
    context.viaIssueOverride
      ? {
          ...page,
          items: page.items.map((issue) => ({ ...issue, providerId: context.namespaceId })),
        }
      : page,
}));

// Default to an existing directory so the stats tests reach the resolution path
// and the health tests see a directory; the #10663 missing-directory guard test
// rejects explicitly.
const statMock = vi.hoisted(() => vi.fn().mockResolvedValue({ isDirectory: () => true }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, default: { ...actual, stat: statMock }, stat: statMock };
});

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

const projectStoreMock = vi.hoisted(() => ({
  saveRepoStats: vi.fn(),
  getProjectByPath: vi.fn(async () => null),
}));

vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

vi.mock("../../../utils/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/git.js")>()),
  getCommitCount: vi.fn(async () => 12),
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

    expect(resolveForCwdMock).toHaveBeenCalledWith("/repo", "issues");
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
    expect(result).toEqual({ ...meta, autoMergeSupported: false });
  });

  it("getRepoMetadata reports autoMerge support from the implementation, not a hint (#13747)", async () => {
    fakeImpl.getRepoMetadata.mockResolvedValue({
      defaultBranch: "main",
      isPrivate: false,
      isFork: false,
      isArchived: false,
      rawData: null,
    });
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: {
        ...fakeImpl,
        autoMerge: { enable: vi.fn(), disable: vi.fn() },
      } as unknown as ForgeProviderImpl,
    });
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-repo-metadata")(null, { cwd: "/repo" });

    expect(result).toMatchObject({ autoMergeSupported: true });
  });

  it("getRepoStats short-circuits to a zero snapshot when the project directory is gone (#10663)", async () => {
    // The project directory was deleted/moved externally; the renderer keeps
    // polling this handler. The guard must return a commits-only zero snapshot
    // without ever touching git resolution — otherwise each poll spams WARN.
    statMock.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    registerForgeDataHandlers();

    const result = await findHandler("forge:get-repo-stats")(null, { cwd: "/missing/path" });

    expect(resolveForCwdMock).not.toHaveBeenCalled();
    // The guard must check the cwd itself, not a parent or derived path.
    expect(statMock).toHaveBeenCalledWith("/missing/path");
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

  describe("forge:get-references-by-numbers", () => {
    const lookup = (payload: unknown) => {
      registerForgeDataHandlers();
      return findHandler("forge:get-references-by-numbers")({}, payload) as Promise<
        ForgeReferenceLookupResult[] | null
      >;
    };
    const issue = (n: number): ForgeNumberReference => ({
      kind: "issue",
      number: n,
      title: `Issue ${n}`,
      state: "open",
    });

    it("answers each distinct number in order, telling found from missing from unanswered", async () => {
      const findReferencesByNumbers = vi.fn(
        async () =>
          new Map<number, ForgeNumberReference | null>([
            [5, issue(5)],
            [6, null],
          ])
      );
      fakeImpl.batchLookups = { findReferencesByNumbers };
      const result = await lookup({ cwd: "/repo", numbers: [5, 6, 5, 7, 0, 1.5] });
      expect(result).toEqual([
        { number: 5, status: "found", reference: issue(5) },
        { number: 6, status: "not_found" },
        { number: 7, status: "unresolved" },
      ]);
      expect(findReferencesByNumbers).toHaveBeenCalledWith(repoRef, [5, 6, 7]);
      // The code forge, never the issues override: `#N` names this repository's own.
      expect(resolveForCwdMock).toHaveBeenCalledWith("/repo");
    });

    it("asks for at most 50 numbers at once", async () => {
      const findReferencesByNumbers = vi.fn(
        async (_repo: RepoRef, _numbers: number[]) => new Map()
      );
      fakeImpl.batchLookups = { findReferencesByNumbers };
      const numbers = Array.from({ length: 60 }, (_, i) => i + 1);
      const result = await lookup({ cwd: "/repo", numbers });
      expect(result).toHaveLength(50);
      expect(findReferencesByNumbers.mock.calls[0]![1]).toEqual(numbers.slice(0, 50));
    });

    it("reports every number unanswered when the lookup throws", async () => {
      fakeImpl.batchLookups = {
        findReferencesByNumbers: vi.fn(async () => {
          throw new Error("network down");
        }),
      };
      expect(await lookup({ cwd: "/repo", numbers: [1, 2] })).toEqual([
        { number: 1, status: "unresolved" },
        { number: 2, status: "unresolved" },
      ]);
    });

    it("asks nothing when the provider holds no credential", async () => {
      const findReferencesByNumbers = vi.fn(async () => new Map());
      fakeImpl.batchLookups = { findReferencesByNumbers };
      fakeImpl.getCredentials.mockResolvedValueOnce(null);
      expect(await lookup({ cwd: "/repo", numbers: [1] })).toBeNull();
      expect(findReferencesByNumbers).not.toHaveBeenCalled();
    });

    it("asks nothing for numbers past a GraphQL Int", async () => {
      const findReferencesByNumbers = vi.fn(async () => new Map());
      fakeImpl.batchLookups = { findReferencesByNumbers };
      expect(await lookup({ cwd: "/repo", numbers: [2_147_483_648] })).toEqual([]);
      expect(findReferencesByNumbers).not.toHaveBeenCalled();
    });

    it("is unavailable when the provider has no reference lookup", async () => {
      fakeImpl.batchLookups = { findPRsByNumbers: vi.fn() };
      expect(await lookup({ cwd: "/repo", numbers: [1] })).toBeNull();
    });

    it("is unavailable when the cwd resolves to no forge", async () => {
      resolveForCwdMock.mockRejectedValueOnce(new Error("No remote URL found for this repository"));
      expect(await lookup({ cwd: "/repo", numbers: [1] })).toBeNull();
    });

    it("asks nothing for a draft with no usable numbers", async () => {
      expect(await lookup({ cwd: "/repo", numbers: [0, -3] })).toEqual([]);
      expect(resolveForCwdMock).not.toHaveBeenCalled();
    });
  });
});

describe("issues bound to a separate provider (#13700)", () => {
  const trackerRef: RepoRef = { host: "tracker.invalid", owner: "ENG", repo: "ENG", rawData: null };

  function codeImplWithStats() {
    return {
      ...fakeImpl,
      repoStats: {
        getRepoStats: vi.fn(async () => ({
          counts: { issueCount: 99, prCount: 4, lastUpdated: 1 },
          // A cache hit persists like a network read but skips the renderer
          // broadcast, which needs a real window registry.
          source: "memory-cache" as const,
          issues: { items: [makeIssue(1)], nextCursor: null, hasMore: false },
          prs: { items: [], nextCursor: null, hasMore: false },
        })),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
    resolveIssueOverrideForCwdMock.mockResolvedValue(null);
  });

  it("stamps listed issues with the issues provider when its override served them", async () => {
    const tracker = {
      listIssues: vi.fn(async () => ({ items: [makeIssue(42)], nextCursor: null, hasMore: false })),
    };
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "acme.tracker.tracker",
      repoRef: trackerRef,
      impl: tracker,
      viaIssueOverride: true,
    });
    registerForgeDataHandlers();

    const page = (await findHandler("forge:list-issues")(null, { cwd: "/repo" })) as Page<Issue>;

    expect(tracker.listIssues).toHaveBeenCalledWith(trackerRef, {});
    expect(page.items[0]).toMatchObject({ number: 42, providerId: "acme.tracker.tracker" });
  });

  it("names the repository behind unsplit counts so hosts can match it (#14199)", async () => {
    const code = codeImplWithStats();
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef: { ...repoRef, host: "Fake.Test" },
      impl: code,
    });
    registerForgeDataHandlers();

    const stats = await findHandler("forge:get-repo-stats")(null, { cwd: "/repo" });

    expect(stats).toMatchObject({ issueCount: 99, prCount: 4, repoKey: "fake.test/acme/widgets" });
  });

  it("names the same origin without polling, for a view's first paint (#15546)", async () => {
    const code = codeImplWithStats();
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef: { ...repoRef, host: "Fake.Test", projectPath: "/repo" },
      impl: code,
    });
    registerForgeDataHandlers();

    const repoKey = await findHandler("forge:get-repo-key")(null, { cwd: "/repo/src" });
    const stats = await findHandler("forge:get-repo-stats")(null, { cwd: "/repo" });

    expect(repoKey).toBe("fake.test/acme/widgets");
    expect(stats).toMatchObject({ repoKey });
    expect(code.repoStats.getRepoStats).toHaveBeenCalledTimes(1);
    expect(resolveIssueOverrideForCwdMock).toHaveBeenCalledWith("/repo/src", "/repo");
  });

  it.each([
    [
      "an issues provider is bound",
      () =>
        resolveIssueOverrideForCwdMock.mockResolvedValue({
          namespaceId: "acme.tracker.tracker",
          repoRef: trackerRef,
          impl: {},
          viaIssueOverride: true,
        }),
    ],
    [
      "the bound issues provider can't be resolved",
      () => resolveIssueOverrideForCwdMock.mockRejectedValue(new Error("gone")),
    ],
    [
      "no code provider resolves",
      () => resolveForCwdMock.mockRejectedValue(new Error("No remote URL found")),
    ],
  ])("names no origin when %s", async (_label, arrange) => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: codeImplWithStats(),
    });
    arrange();
    registerForgeDataHandlers();

    await expect(findHandler("forge:get-repo-key")(null, { cwd: "/repo" })).resolves.toBeNull();
  });

  it("takes the issue count from the issues provider and keeps PRs from the code forge", async () => {
    const code = codeImplWithStats();
    resolveForCwdMock.mockResolvedValue({ namespaceId: "fake.provider", repoRef, impl: code });
    const trackerList = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      hasMore: true,
      totalCount: 7,
    }));
    resolveIssueOverrideForCwdMock.mockResolvedValue({
      namespaceId: "acme.tracker.tracker",
      repoRef: trackerRef,
      impl: { listIssues: trackerList },
      viaIssueOverride: true,
    });
    registerForgeDataHandlers();

    const stats = await findHandler("forge:get-repo-stats")(null, { cwd: "/repo" });

    expect(stats).toMatchObject({ issueCount: 7, prCount: 4, commitCount: 12 });
    // No one repository reported both counts, so there is nothing to match
    // across hosts (#14199).
    expect(stats).not.toHaveProperty("repoKey");
    expect(trackerList).toHaveBeenCalledWith(trackerRef, {
      state: "open",
      perPage: 1,
      bypassCache: false,
    });
    // Persisted counts carry the issues provider's count, not the code forge's 99.
    expect(projectStoreMock.saveRepoStats).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ forge: expect.objectContaining({ issueCount: 7, prCount: 4 }) })
    );
  });

  it("dates the issue count by when the issues provider counted it, not the code forge", async () => {
    const code = codeImplWithStats();
    resolveForCwdMock.mockResolvedValue({ namespaceId: "fake.provider", repoRef, impl: code });
    const countedAt = 1_000;
    resolveIssueOverrideForCwdMock.mockResolvedValue({
      namespaceId: "acme.tracker.tracker",
      repoRef: trackerRef,
      impl: {
        listIssues: vi.fn(),
        buildIssuesUrl: () => "https://tracker.test/issues",
        repoStats: {
          getRepoStats: vi.fn(async () => ({
            counts: {
              issueCount: 3,
              prCount: null,
              lastUpdated: countedAt,
              issueCountRefreshedAt: countedAt,
            },
            source: "memory-cache" as const,
          })),
        },
      },
      viaIssueOverride: true,
    });
    registerForgeDataHandlers();

    const stats = await findHandler("forge:get-repo-stats")(null, { cwd: "/repo" });

    expect(stats).toMatchObject({ issueCount: 3, issueCountRefreshedAt: countedAt });
  });

  it("reports an unknown issue count, never the code forge's, when the issues provider fails", async () => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: codeImplWithStats(),
    });
    resolveIssueOverrideForCwdMock.mockRejectedValue(new Error("issues provider unavailable"));
    registerForgeDataHandlers();

    const stats = await findHandler("forge:get-repo-stats")(null, { cwd: "/repo" });

    expect(stats).toMatchObject({ issueCount: null, prCount: 4 });
    // A failed read must not overwrite the stored counts.
    expect(projectStoreMock.saveRepoStats).toHaveBeenCalledWith(
      "/repo",
      expect.not.objectContaining({ forge: expect.anything() })
    );
  });

  it("skips cold-start hydration from the code forge's cached issue page", async () => {
    const getFirstPageCache = vi.fn(async () => ({
      issues: { items: [makeIssue(1)], nextCursor: null, hasMore: false },
      prs: { items: [], nextCursor: null, hasMore: false },
      lastUpdated: 1,
    }));
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef: { ...repoRef, projectPath: "/repo" },
      impl: { ...fakeImpl, repoStats: { getRepoStats: vi.fn(), getFirstPageCache } },
    });
    resolveIssueOverrideForCwdMock.mockResolvedValue({
      namespaceId: "acme.tracker.tracker",
      repoRef: trackerRef,
      impl: {},
      viaIssueOverride: true,
    });
    registerForgeDataHandlers();

    const cached = await findHandler("forge:get-first-page-cache")(null, { cwd: "/repo" });

    expect(cached).toBeNull();
    expect(getFirstPageCache).not.toHaveBeenCalled();
    // Reuses the root the code context already found.
    expect(resolveIssueOverrideForCwdMock).toHaveBeenCalledWith("/repo", "/repo");
  });

  it("holds the blend back from persistence when the tracker's own count is stale", async () => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: codeImplWithStats(),
    });
    resolveIssueOverrideForCwdMock.mockResolvedValue({
      namespaceId: "acme.tracker.tracker",
      repoRef: trackerRef,
      impl: {
        listIssues: vi.fn(),
        repoStats: {
          getRepoStats: vi.fn(async () => ({
            counts: { issueCount: 3, prCount: null, stale: true },
            source: "disk" as const,
          })),
        },
      },
      viaIssueOverride: true,
    });
    registerForgeDataHandlers();

    const stats = await findHandler("forge:get-repo-stats")(null, { cwd: "/repo" });

    expect(stats).toMatchObject({ issueCount: 3, prCount: 4 });
    expect(projectStoreMock.saveRepoStats).toHaveBeenCalledWith(
      "/repo",
      expect.not.objectContaining({ forge: expect.anything() })
    );
  });

  it("leaves the single-provider stats path untouched with no issues provider bound", async () => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: codeImplWithStats(),
    });
    registerForgeDataHandlers();

    const stats = await findHandler("forge:get-repo-stats")(null, { cwd: "/repo" });

    expect(stats).toMatchObject({ issueCount: 99, prCount: 4 });
  });
});

describe("forge:resolve-author-avatar coalescing (#13598)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  let generation: number;
  let resolveAuthorAvatar: ReturnType<typeof vi.fn>;

  function useAvatarImpl(opts: { namespaceId?: string; host?: string; withGeneration?: boolean }) {
    const avatars: Record<string, unknown> = { resolveAuthorAvatar };
    if (opts.withGeneration !== false) avatars.getCacheGeneration = () => generation;
    resolveForCwdMock.mockResolvedValue({
      namespaceId: opts.namespaceId ?? "fake.provider",
      repoRef: { ...repoRef, host: opts.host ?? repoRef.host },
      impl: { ...fakeImpl, avatars } as unknown as ForgeProviderImpl,
    });
  }

  function resolveAvatar(email: string, cwd = "/repo"): Promise<unknown> {
    return Promise.resolve(findHandler("forge:resolve-author-avatar")(null, { cwd, email }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
    generation = 0;
    resolveAuthorAvatar = vi.fn();
    useAvatarImpl({});
    registerForgeDataHandlers();
  });

  it("shares one provider lookup and one rate-limit slot across concurrent identical reads", async () => {
    const pending = deferred<string | null>();
    resolveAuthorAvatar.mockReturnValue(pending.promise);

    const results = Array.from({ length: 20 }, (_, i) =>
      resolveAvatar(i % 2 ? " Dev@Example.com " : "dev@example.com", `/repo/wt-${i}`)
    );
    await vi.waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(1));
    pending.resolve("https://avatars.test/dev.png");

    expect(await Promise.all(results)).toEqual(
      Array.from({ length: 20 }, () => "https://avatars.test/dev.png")
    );
    expect(resolveAuthorAvatar).toHaveBeenCalledTimes(1);
    expect(resolveAuthorAvatar).toHaveBeenCalledWith("dev@example.com");

    // Only the one admitted lookup spent quota: 29 distinct emails still fit
    // the 30/min budget, and the 30th distinct one is refused.
    resolveAuthorAvatar.mockResolvedValue(null);
    for (let i = 0; i < 29; i++) await resolveAvatar(`user-${i}@example.com`);
    await expect(resolveAvatar("one-too-many@example.com")).rejects.toThrow();
  });

  it("hands a rate-limit rejection to every joiner and lets the same author retry later", async () => {
    resolveAuthorAvatar.mockResolvedValue(null);
    for (let i = 0; i < 30; i++) await resolveAvatar(`filler-${i}@example.com`);
    resolveAuthorAvatar.mockClear();

    const reads = Array.from({ length: 5 }, () => resolveAvatar("dev@example.com"));
    const settled = await Promise.allSettled(reads);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();

    _resetRateLimitQueuesForTest();
    resolveAuthorAvatar.mockResolvedValue("https://avatars.test/dev.png");
    expect(await resolveAvatar("dev@example.com")).toBe("https://avatars.test/dev.png");
  });

  it("does not hold a settled result, so the next read reaches the provider again", async () => {
    resolveAuthorAvatar.mockResolvedValue(null);
    expect(await resolveAvatar("dev@example.com")).toBeNull();
    expect(await resolveAvatar("dev@example.com")).toBeNull();
    expect(resolveAuthorAvatar).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct emails, hosts, providers and credential generations in separate flights", async () => {
    const pending = deferred<string | null>();
    resolveAuthorAvatar.mockReturnValue(pending.promise);

    const reads = [resolveAvatar("a@example.com"), resolveAvatar("b@example.com")];
    await vi.waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(2));

    useAvatarImpl({ host: "other.test" });
    reads.push(resolveAvatar("a@example.com"));
    await vi.waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(3));

    useAvatarImpl({ namespaceId: "other.provider" });
    reads.push(resolveAvatar("a@example.com"));
    await vi.waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(4));

    // A credential change mid-flight: later readers must not join the lookup
    // started under the previous credential.
    useAvatarImpl({});
    generation = 1;
    reads.push(resolveAvatar("a@example.com"));
    await vi.waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(5));

    pending.resolve(null);
    await Promise.all(reads);
  });

  it("does not coalesce a provider that exposes no cache generation", async () => {
    useAvatarImpl({ withGeneration: false });
    const pending = deferred<string | null>();
    resolveAuthorAvatar.mockReturnValue(pending.promise);

    const reads = [resolveAvatar("dev@example.com"), resolveAvatar("dev@example.com")];
    await vi.waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(2));
    pending.resolve(null);
    await Promise.all(reads);
  });

  it("hands a provider failure to every joiner as null, then retries on the next read", async () => {
    const pending = deferred<string | null>();
    resolveAuthorAvatar.mockReturnValueOnce(pending.promise);

    const reads = [resolveAvatar("dev@example.com"), resolveAvatar("dev@example.com")];
    await vi.waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(1));
    pending.reject(new Error("network down"));
    expect(await Promise.all(reads)).toEqual([null, null]);

    resolveAuthorAvatar.mockResolvedValueOnce("https://avatars.test/dev.png");
    expect(await resolveAvatar("dev@example.com")).toBe("https://avatars.test/dev.png");
    expect(resolveAuthorAvatar).toHaveBeenCalledTimes(2);
  });

  it("returns null without spending quota for invalid input or an avatar-less provider", async () => {
    expect(await resolveAvatar("   ")).toBeNull();
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: fakeImpl as unknown as ForgeProviderImpl,
    });
    for (let i = 0; i < 40; i++) expect(await resolveAvatar(`u${i}@example.com`)).toBeNull();
    expect(resolveForCwdMock).toHaveBeenCalled();
  });
});

describe("issue links read from the provider that owns them (#13744)", () => {
  const trackerRef: RepoRef = { host: "tracker.invalid", owner: "ENG", repo: "ENG", rawData: null };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
    resolveIssueOverrideForCwdMock.mockResolvedValue(null);
    getIssueForLinkMock.mockResolvedValue(undefined);
  });

  it("routes the tooltip to the target the badge names", async () => {
    const getIssueTooltip = vi.fn(async () => ({ number: 42, title: "From the code forge" }));
    resolveIssueLinkForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: { tooltips: { getIssueTooltip } },
    });
    registerForgeDataHandlers();

    const data = await findHandler("forge:get-issue-tooltip")(null, {
      cwd: "/repo",
      issueNumber: 42,
      role: "code",
    });

    expect(resolveIssueLinkForCwdMock).toHaveBeenCalledWith("/repo", { role: "code" });
    expect(getIssueTooltip).toHaveBeenCalledWith(repoRef, 42);
    expect(data).toMatchObject({ title: "From the code forge" });
  });

  it("projects the tooltip from the issue looked up by id when the link has one", async () => {
    const getIssueTooltip = vi.fn();
    resolveIssueLinkForCwdMock.mockResolvedValue({
      namespaceId: "acme.tracker.tracker",
      repoRef: trackerRef,
      impl: { tooltips: { getIssueTooltip } },
    });
    getIssueForLinkMock.mockResolvedValue({ ...makeIssue(57), title: "Moved issue" });
    registerForgeDataHandlers();

    const data = await findHandler("forge:get-issue-tooltip")(null, {
      cwd: "/repo",
      issueNumber: 42,
      issueProviderId: "acme.tracker.tracker",
      issueId: "uuid-42",
    });

    expect(data).toMatchObject({ number: 57, title: "Moved issue", fromIssue: true });
    expect(getIssueTooltip).not.toHaveBeenCalled();
  });

  it("returns no tooltip when the named provider can't be resolved", async () => {
    resolveIssueLinkForCwdMock.mockRejectedValue(new Error("provider gone"));
    registerForgeDataHandlers();

    const data = await findHandler("forge:get-issue-tooltip")(null, {
      cwd: "/repo",
      issueNumber: 42,
      issueProviderId: "acme.gone.gone",
    });

    expect(data).toBeNull();
  });

  function healthImpl() {
    return {
      ...fakeImpl,
      projectHealth: {
        getProjectHealth: vi.fn(async () => ({
          health: {
            ciStatus: "success" as const,
            issueCount: 99,
            prCount: 4,
            latestRelease: null,
            securityAlerts: { visible: false, count: 0 },
            mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
            repoUrl: "https://fake.test/acme/widgets",
          },
        })),
      },
    };
  }

  it("takes the health issue count and list from the issues provider in split mode", async () => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: healthImpl(),
    });
    resolveIssueOverrideForCwdMock.mockResolvedValue({
      namespaceId: "acme.tracker.tracker",
      repoRef: trackerRef,
      impl: {
        listIssues: vi.fn(async () => ({
          items: [],
          nextCursor: null,
          hasMore: true,
          totalCount: 7,
        })),
        buildIssuesUrl: () => "https://tracker.invalid/team/ENG",
      },
      viaIssueOverride: true,
    });
    registerForgeDataHandlers();

    const health = await findHandler("forge:get-project-health")(null, { cwd: process.cwd() });

    expect(health).toMatchObject({
      issueCount: 7,
      prCount: 4,
      issuesUrl: "https://tracker.invalid/team/ENG",
    });
    expect(health).not.toHaveProperty("issueCountUnavailable");
  });

  it("hides the health issue count rather than show the code forge's when the tracker fails", async () => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: healthImpl(),
    });
    resolveIssueOverrideForCwdMock.mockRejectedValue(new Error("issues provider unavailable"));
    registerForgeDataHandlers();

    const health = await findHandler("forge:get-project-health")(null, { cwd: process.cwd() });

    expect(health).toMatchObject({ issueCountUnavailable: true, prCount: 4 });
    expect(health).not.toMatchObject({ issueCount: 99 });
  });

  it("leaves single-provider health untouched", async () => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: healthImpl(),
    });
    registerForgeDataHandlers();

    const health = await findHandler("forge:get-project-health")(null, { cwd: process.cwd() });

    expect(health).toMatchObject({ issueCount: 99 });
    expect(health).not.toHaveProperty("issuesUrl");
    expect(health).not.toHaveProperty("issueCountUnavailable");
  });
});
