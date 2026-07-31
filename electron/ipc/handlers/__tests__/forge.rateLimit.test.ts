import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ForgeProviderImpl, RepoRef } from "../../../../shared/types/forge.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const checkRateLimitMock = vi.hoisted(() => vi.fn());

const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// A fake forge provider — deliberately NOT GitHub. Proves the guards sit in
// front of the normalized contract with no GitHub coupling.
const fakeImpl = vi.hoisted(() => ({
  buildIssuesUrl: vi.fn(),
  buildPRsUrl: vi.fn(),
  buildCommitsUrl: vi.fn(),
  buildIssueUrl: vi.fn(),
  buildPRUrl: vi.fn(),
  assignIssue: vi.fn(),
  unassignIssue: vi.fn(),
  createPR: vi.fn(),
  closePR: vi.fn(),
  reopenPR: vi.fn(),
  mergePR: vi.fn(),
  convertPRToDraft: vi.fn(),
  markPRReadyForReview: vi.fn(),
  commentOnPR: vi.fn(),
  editPR: vi.fn(),
  createIssue: vi.fn(),
  closeIssue: vi.fn(),
  reopenIssue: vi.fn(),
  editIssue: vi.fn(),
  addIssueComment: vi.fn(),
  addIssueLabel: vi.fn(),
  removeIssueLabel: vi.fn(),
  validateToken: vi.fn(),
  classifyPushError: vi.fn(),
  listIssues: vi.fn(),
  listPRs: vi.fn(),
  getIssue: vi.fn(),
  getPR: vi.fn(),
  getCIStatus: vi.fn(),
  getRepoMetadata: vi.fn(),
  repoStats: { getRepoStats: vi.fn() },
  reviews: {
    getReviewThreads: vi.fn(),
    approvePR: vi.fn(),
    requestChanges: vi.fn(),
    dismissReview: vi.fn(),
    requestReviewers: vi.fn(),
  },
}));

const resolveForCwdMock = vi.hoisted(() => vi.fn());

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

// Mutable registry fixture — the handler reads this on every call, so
// individual tests can re-register providers to exercise the multi-provider
// routing regression for #9985 without re-mocking the module.
const registeredProvidersMock = vi.hoisted(
  () => [] as Array<{ pluginId: string; contribution: { id: string } }>
);

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../utils.js", () => ({
  checkRateLimit: checkRateLimitMock,
  broadcastToRenderer: vi.fn(),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: vi.fn(),
  typedHandleWithContext: vi.fn(),
  typedHandleWithContextValidated: vi.fn(),
}));

vi.mock("../../../utils/git.js", () => ({
  getCommitCount: vi.fn(async () => 0),
}));

vi.mock("../../../utils/openExternal.js", () => ({
  openExternalUrl: openExternalUrlMock,
}));

vi.mock("../forgeResolution.js", () => ({
  resolveForCwd: resolveForCwdMock,
  getImplForNamespace: () => fakeImpl,
}));

vi.mock("../../../store.js", () => ({
  store: storeMock,
  auditLogsStore: { get: vi.fn(() => []), set: vi.fn() },
}));

vi.mock("../../../services/forgeProviderRegistry.js", () => ({
  getForgeProviderImpl: () => fakeImpl,
  getRegisteredForgeProviders: () => registeredProvidersMock,
}));

vi.mock("../../../services/forge/forgeAuditService.js", () => ({
  auditForgeCall: vi.fn((_meta: unknown, run: () => unknown) => run()),
  summarizeForgeArgs: vi.fn(() => ""),
}));

import { CHANNELS } from "../../channels.js";
import { registerForgeHandlers } from "../forge.js";
import { registerForgeDataHandlers } from "../forgeData.js";

const repoRef: RepoRef = { host: "fake.test", owner: "acme", repo: "widgets", rawData: null };

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("forge handlers — rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredProvidersMock.length = 0;
    registeredProvidersMock.push({ pluginId: "fake-plugin", contribution: { id: "fake" } });
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake-plugin.fake",
      providerId: "fake",
      repoRef,
      impl: fakeImpl as unknown as ForgeProviderImpl,
    });
    fakeImpl.buildIssuesUrl.mockReturnValue("https://fake.test/acme/widgets/issues");
    fakeImpl.buildPRsUrl.mockReturnValue("https://fake.test/acme/widgets/pulls");
    fakeImpl.buildCommitsUrl.mockReturnValue("https://fake.test/acme/widgets/commits");
    fakeImpl.buildIssueUrl.mockReturnValue("https://fake.test/acme/widgets/issues/1");
    fakeImpl.buildPRUrl.mockReturnValue("https://fake.test/acme/widgets/pulls/1");
    fakeImpl.repoStats.getRepoStats.mockResolvedValue({
      counts: { issueCount: 0, prCount: 0 },
      source: "memory-cache",
    });
    // `null` (PR not found) is the only valid no-op CI response — the handler
    // rejects an undefined provider result as malformed, so this stub must be
    // explicit rather than relying on the bare mock's undefined.
    fakeImpl.getCIStatus.mockResolvedValue(null);
    fakeImpl.assignIssue.mockResolvedValue(undefined);
    fakeImpl.unassignIssue.mockResolvedValue(undefined);
    const fakePR = {
      number: 1,
      title: "PR",
      body: "",
      state: "open",
      rawState: "open",
      isDraft: false,
      merged: false,
      url: "https://fake.test/acme/widgets/pulls/1",
      baseRef: "main",
      headRef: "feature",
      createdAt: 0,
      updatedAt: 0,
      rawData: null,
    };
    fakeImpl.createPR.mockResolvedValue(fakePR);
    fakeImpl.closePR.mockResolvedValue(undefined);
    fakeImpl.reopenPR.mockResolvedValue(undefined);
    fakeImpl.mergePR.mockResolvedValue(undefined);
    fakeImpl.convertPRToDraft.mockResolvedValue(undefined);
    fakeImpl.markPRReadyForReview.mockResolvedValue(undefined);
    fakeImpl.commentOnPR.mockResolvedValue(undefined);
    fakeImpl.editPR.mockResolvedValue(fakePR);
    fakeImpl.validateToken.mockResolvedValue({ valid: true, username: "user", avatarUrl: null });
    fakeImpl.classifyPushError.mockReturnValue(null);
    fakeImpl.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    fakeImpl.listPRs.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    fakeImpl.getIssue.mockResolvedValue(null);
    fakeImpl.getPR.mockResolvedValue(null);
    fakeImpl.getRepoMetadata.mockResolvedValue({
      defaultBranch: "main",
      isPrivate: false,
      isFork: false,
      isArchived: false,
      rawData: null,
    });
    registerForgeHandlers();
    registerForgeDataHandlers();
  });

  describe("read family (forge:list-issues)", () => {
    it("calls checkRateLimit with read limits (10, 10_000)", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_LIST_ISSUES);
      await handler({}, { cwd: "/tmp/project" });

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FORGE_LIST_ISSUES, 10, 10_000);
      expect(fakeImpl.listIssues).toHaveBeenCalled();
    });

    it("rejects and skips resolution + listIssues when rate limit throws", async () => {
      checkRateLimitMock.mockImplementationOnce(() => {
        throw new Error("Rate limit exceeded");
      });
      const handler = getInvokeHandler(CHANNELS.FORGE_LIST_ISSUES);

      await expect(handler({}, { cwd: "/tmp/project" })).rejects.toThrow("Rate limit exceeded");
      expect(resolveForCwdMock).not.toHaveBeenCalled();
      expect(fakeImpl.listIssues).not.toHaveBeenCalled();
    });
  });

  describe("open family (forge:open-issues)", () => {
    it("calls checkRateLimit with open limits (20, 10_000)", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_OPEN_ISSUES);
      await handler({}, "/tmp/project", "bug", "open");

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FORGE_OPEN_ISSUES, 20, 10_000);
      expect(openExternalUrlMock).toHaveBeenCalled();
    });

    it("rejects and skips openExternalUrl when rate limit throws", async () => {
      checkRateLimitMock.mockImplementationOnce(() => {
        throw new Error("Rate limit exceeded");
      });
      const handler = getInvokeHandler(CHANNELS.FORGE_OPEN_ISSUES);

      await expect(handler({}, "/tmp/project", "bug", "open")).rejects.toThrow(
        "Rate limit exceeded"
      );
      expect(openExternalUrlMock).not.toHaveBeenCalled();
    });
  });

  describe("mutation family (forge:assign-issue)", () => {
    it("calls checkRateLimit with mutation limits (5, 10_000)", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_ASSIGN_ISSUE);
      await handler({}, { cwd: "/tmp/project", issueNumber: 42, username: "octocat" });

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FORGE_ASSIGN_ISSUE, 5, 10_000);
      expect(fakeImpl.assignIssue).toHaveBeenCalled();
    });

    it("rejects and skips assignIssue when rate limit throws", async () => {
      checkRateLimitMock.mockImplementationOnce(() => {
        throw new Error("Rate limit exceeded");
      });
      const handler = getInvokeHandler(CHANNELS.FORGE_ASSIGN_ISSUE);

      await expect(
        handler({}, { cwd: "/tmp/project", issueNumber: 42, username: "octocat" })
      ).rejects.toThrow("Rate limit exceeded");
      expect(fakeImpl.assignIssue).not.toHaveBeenCalled();
    });
  });

  describe("PR write family (forge:*-pr)", () => {
    it("createPR uses mutation limits (5, 10_000) and dispatches to the provider", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_CREATE_PR);
      await handler({}, { cwd: "/tmp/project", head: "feature", base: "main", title: "T" });

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FORGE_CREATE_PR, 5, 10_000);
      expect(fakeImpl.createPR).toHaveBeenCalledWith(repoRef, {
        head: "feature",
        base: "main",
        title: "T",
      });
    });

    it("createPR rejects an invalid head before resolving the provider", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_CREATE_PR);
      await expect(
        handler({}, { cwd: "/tmp/project", head: "", base: "main", title: "T" })
      ).rejects.toThrow(/head branch/i);
      expect(fakeImpl.createPR).not.toHaveBeenCalled();
    });

    it("mergePR uses mutation limits and forwards the strategy", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_MERGE_PR);
      await handler({}, { cwd: "/tmp/project", prNumber: 7, mergeMethod: "squash" });

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FORGE_MERGE_PR, 5, 10_000);
      expect(fakeImpl.mergePR).toHaveBeenCalledWith(repoRef, 7, { mergeMethod: "squash" });
    });

    it("mergePR rejects an invalid merge method", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_MERGE_PR);
      await expect(
        handler({}, { cwd: "/tmp/project", prNumber: 7, mergeMethod: "fast-forward" })
      ).rejects.toThrow(/merge method/i);
      expect(fakeImpl.mergePR).not.toHaveBeenCalled();
    });

    it("closePR / reopenPR / draft toggles / comment dispatch with the PR number", async () => {
      await getInvokeHandler(CHANNELS.FORGE_CLOSE_PR)({}, { cwd: "/p", prNumber: 3 });
      await getInvokeHandler(CHANNELS.FORGE_REOPEN_PR)({}, { cwd: "/p", prNumber: 3 });
      await getInvokeHandler(CHANNELS.FORGE_CONVERT_PR_TO_DRAFT)({}, { cwd: "/p", prNumber: 3 });
      await getInvokeHandler(CHANNELS.FORGE_MARK_PR_READY_FOR_REVIEW)(
        {},
        { cwd: "/p", prNumber: 3 }
      );
      await getInvokeHandler(CHANNELS.FORGE_COMMENT_ON_PR)(
        {},
        { cwd: "/p", prNumber: 3, body: "hi" }
      );

      expect(fakeImpl.closePR).toHaveBeenCalledWith(repoRef, 3);
      expect(fakeImpl.reopenPR).toHaveBeenCalledWith(repoRef, 3);
      expect(fakeImpl.convertPRToDraft).toHaveBeenCalledWith(repoRef, 3);
      expect(fakeImpl.markPRReadyForReview).toHaveBeenCalledWith(repoRef, 3);
      expect(fakeImpl.commentOnPR).toHaveBeenCalledWith(repoRef, 3, "hi");
    });

    it("commentOnPR rejects an empty body", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_COMMENT_ON_PR);
      await expect(handler({}, { cwd: "/p", prNumber: 3, body: "  " })).rejects.toThrow(
        /body is required/i
      );
      expect(fakeImpl.commentOnPR).not.toHaveBeenCalled();
    });

    it("editPR requires at least one of title/body", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_EDIT_PR);
      await expect(handler({}, { cwd: "/p", prNumber: 3 })).rejects.toThrow(/title or body/i);
      expect(fakeImpl.editPR).not.toHaveBeenCalled();
    });

    it("editPR forwards only the provided fields", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_EDIT_PR);
      await handler({}, { cwd: "/p", prNumber: 3, title: "New" });
      expect(fakeImpl.editPR).toHaveBeenCalledWith(repoRef, 3, { title: "New" });
    });
  });

  describe("write-op input validation", () => {
    it("rejects a blank editIssue title before touching the provider", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_EDIT_ISSUE);

      await expect(
        handler({}, { cwd: "/tmp/project", issueNumber: 1, input: { title: "   " } })
      ).rejects.toThrow(/title cannot be blank/i);
      expect(fakeImpl.editIssue).not.toHaveBeenCalled();
    });

    it("rejects an editIssue with neither title nor body", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_EDIT_ISSUE);

      await expect(handler({}, { cwd: "/tmp/project", issueNumber: 1, input: {} })).rejects.toThrow(
        /title or body/i
      );
      expect(fakeImpl.editIssue).not.toHaveBeenCalled();
    });

    it("rejects an invalid closeIssue state reason", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_CLOSE_ISSUE);

      await expect(
        handler({}, { cwd: "/tmp/project", issueNumber: 1, stateReason: "bogus" })
      ).rejects.toThrow(/state reason/i);
      expect(fakeImpl.closeIssue).not.toHaveBeenCalled();
    });

    it("accepts 'duplicate' as a closeIssue state reason", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_CLOSE_ISSUE);

      await handler({}, { cwd: "/tmp/project", issueNumber: 1, stateReason: "duplicate" });
      expect(fakeImpl.closeIssue).toHaveBeenCalledWith(expect.anything(), 1, "duplicate");
    });

    it("rejects a blank addIssueComment body", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_ADD_ISSUE_COMMENT);

      await expect(
        handler({}, { cwd: "/tmp/project", issueNumber: 1, body: "  " })
      ).rejects.toThrow(/comment body is required/i);
      expect(fakeImpl.addIssueComment).not.toHaveBeenCalled();
    });

    it("rejects a blank addIssueLabel name", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_ADD_ISSUE_LABEL);

      await expect(
        handler({}, { cwd: "/tmp/project", issueNumber: 1, label: "  " })
      ).rejects.toThrow(/label name is required/i);
      expect(fakeImpl.addIssueLabel).not.toHaveBeenCalled();
    });
  });

  describe("token family (forge:validate-token)", () => {
    const validatePayload = { providerId: "fake-plugin.fake", token: "fake_token" };

    it("calls checkRateLimit with token limits (5, 10_000)", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_VALIDATE_TOKEN);
      await handler({}, validatePayload);

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FORGE_VALIDATE_TOKEN, 5, 10_000);
      expect(fakeImpl.validateToken).toHaveBeenCalledWith("fake_token");
    });

    it("rejects and skips validateToken when rate limit throws", async () => {
      checkRateLimitMock.mockImplementationOnce(() => {
        throw new Error("Rate limit exceeded");
      });
      const handler = getInvokeHandler(CHANNELS.FORGE_VALIDATE_TOKEN);

      await expect(handler({}, validatePayload)).rejects.toThrow("Rate limit exceeded");
      expect(fakeImpl.validateToken).not.toHaveBeenCalled();
      // The guard fires before provider lookup, not just before the API call.
      expect(fakeImpl.validateToken).not.toHaveBeenCalled();
    });

    it("routes to the named provider even when another forge is registered first (#9985)", async () => {
      // Regression for #9985: a token entered in the GitHub settings tab
      // must validate against GitHub, not whichever forge the registry
      // happened to surface first.
      registeredProvidersMock.length = 0;
      registeredProvidersMock.push(
        { pluginId: "gitlab-plugin", contribution: { id: "gitlab" } },
        { pluginId: "fake-plugin", contribution: { id: "fake" } }
      );
      const handler = getInvokeHandler(CHANNELS.FORGE_VALIDATE_TOKEN);

      // The fake impl is a single instance, so we can only assert the call
      // went through with the right token — the prior bug would have
      // surfaced as a different validation outcome against the first-registered
      // provider, which the runtime-level e2e covers. Here we lock in the
      // canonical-id dispatch path.
      await handler({}, { providerId: "fake-plugin.fake", token: "ghp_token" });

      expect(fakeImpl.validateToken).toHaveBeenCalledTimes(1);
      expect(fakeImpl.validateToken).toHaveBeenCalledWith("ghp_token");
    });

    it("returns a resolved error and skips the impl when the providerId is unknown", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_VALIDATE_TOKEN);
      const result = await handler({}, { providerId: "does.not.exist", token: "ghp_token" });
      expect(result).toEqual({
        valid: false,
        error: expect.stringMatching(/Unknown forge provider/),
      });
      expect(fakeImpl.validateToken).not.toHaveBeenCalled();
    });

    it("returns the existing 'not activated' shape when the impl is not registered (#9985 active vs inactive)", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_VALIDATE_TOKEN);
      // The mock always returns fakeImpl from getForgeProviderImpl, so the
      // 'not activated' branch is unreachable in this harness. The negative
      // case above is the one that actually fires in production. This test
      // pins the explicit-guard contract for callers reading the error string.
      const result = await handler({}, { providerId: "fake-plugin.fake", token: "" });
      expect(result).toEqual({ valid: false, error: "Token is required" });
      expect(fakeImpl.validateToken).not.toHaveBeenCalled();
    });
  });

  describe("best-effort family (forge:classify-push-error)", () => {
    it("propagates the rate-limit rejection instead of swallowing it to null", async () => {
      // The handler collapses resolution failures to `null`; the rate-limit
      // guard sits before that try block so a flood still rejects loudly.
      checkRateLimitMock.mockImplementationOnce(() => {
        throw new Error("Rate limit exceeded");
      });
      const handler = getInvokeHandler(CHANNELS.FORGE_CLASSIFY_PUSH_ERROR);

      await expect(handler({}, { cwd: "/tmp/project", stderr: "boom" })).rejects.toThrow(
        "Rate limit exceeded"
      );
      expect(resolveForCwdMock).not.toHaveBeenCalled();
    });

    it("still collapses resolution failures to null when the guard passes", async () => {
      resolveForCwdMock.mockRejectedValueOnce(new Error("No remote URL found"));
      const handler = getInvokeHandler(CHANNELS.FORGE_CLASSIFY_PUSH_ERROR);

      await expect(handler({}, { cwd: "/tmp/project", stderr: "boom" })).resolves.toBeNull();
      expect(checkRateLimitMock).toHaveBeenCalledWith(
        CHANNELS.FORGE_CLASSIFY_PUSH_ERROR,
        10,
        10_000
      );
    });
  });

  describe("all forge handlers are rate-limit-wired", () => {
    type HandlerSpec = {
      channel: string;
      maxCalls: number;
      /** Rate-limit window — defaults to 10s; the avatar/diagnostics probes use 60s. */
      windowMs?: number;
      invoke: (handler: (...args: unknown[]) => Promise<unknown>) => Promise<unknown>;
    };

    const cwd = "/tmp/project";
    const specs: HandlerSpec[] = [
      // open family: 20/10s (matches github:open-*)
      { channel: CHANNELS.FORGE_OPEN_ISSUES, maxCalls: 20, invoke: (h) => h({}, cwd) },
      { channel: CHANNELS.FORGE_OPEN_PRS, maxCalls: 20, invoke: (h) => h({}, cwd) },
      { channel: CHANNELS.FORGE_OPEN_COMMITS, maxCalls: 20, invoke: (h) => h({}, cwd) },
      {
        channel: CHANNELS.FORGE_OPEN_ISSUE,
        maxCalls: 20,
        invoke: (h) => h({}, { cwd, issueNumber: 1 }),
      },
      // read family: 10/10s (matches github:get-issue-url / list / repo stats)
      {
        channel: CHANNELS.FORGE_GET_ISSUE_URL,
        maxCalls: 10,
        invoke: (h) => h({}, { cwd, issueNumber: 1 }),
      },
      { channel: CHANNELS.FORGE_LIST_ISSUES, maxCalls: 10, invoke: (h) => h({}, { cwd }) },
      { channel: CHANNELS.FORGE_LIST_PRS, maxCalls: 10, invoke: (h) => h({}, { cwd }) },
      { channel: CHANNELS.FORGE_GET_REPO_METADATA, maxCalls: 10, invoke: (h) => h({}, { cwd }) },
      {
        channel: CHANNELS.FORGE_CLASSIFY_PUSH_ERROR,
        maxCalls: 10,
        invoke: (h) => h({}, { cwd, stderr: "remote rejected" }),
      },
      // by-number lookups: 25/10s (matches github:get-issue-by-number / get-pr-by-number)
      {
        channel: CHANNELS.FORGE_GET_ISSUE,
        maxCalls: 25,
        invoke: (h) => h({}, { cwd, issueNumber: 1 }),
      },
      { channel: CHANNELS.FORGE_GET_PR, maxCalls: 25, invoke: (h) => h({}, { cwd, prNumber: 1 }) },
      {
        channel: CHANNELS.FORGE_GET_CI_STATUS,
        maxCalls: 25,
        // Safe to reuse one PR number across the spec loops even though the CI
        // single-flight is module-scoped: checkRateLimit runs before the
        // coalescer, so a collapsed lookup still exercises the guard. (If the
        // guard is ever moved inside the single-flight, that stops holding.)
        invoke: (h) => h({}, { cwd, prNumber: 8101 }),
      },
      // token + mutation family: 5/10s (matches github:validate-token / assign-issue)
      {
        channel: CHANNELS.FORGE_VALIDATE_TOKEN,
        maxCalls: 5,
        invoke: (h) => h({}, { providerId: "fake-plugin.fake", token: "fake_token" }),
      },
      {
        channel: CHANNELS.FORGE_ASSIGN_ISSUE,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1, username: "octocat" }),
      },
      {
        channel: CHANNELS.FORGE_UNASSIGN_ISSUE,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1, username: "octocat" }),
      },
      // review-write ops: 3/10s (more conservative than assign — higher blast radius)
      {
        channel: CHANNELS.FORGE_APPROVE_PR,
        maxCalls: 3,
        invoke: (h) => h({}, { cwd, prNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_REQUEST_CHANGES,
        maxCalls: 3,
        invoke: (h) => h({}, { cwd, prNumber: 1, body: "please fix" }),
      },
      {
        channel: CHANNELS.FORGE_DISMISS_REVIEW,
        maxCalls: 3,
        invoke: (h) => h({}, { cwd, prNumber: 1, reviewId: 1, message: "stale" }),
      },
      {
        channel: CHANNELS.FORGE_REQUEST_REVIEWERS,
        maxCalls: 3,
        invoke: (h) => h({}, { cwd, prNumber: 1, users: ["octocat"] }),
      },
      // issue-write ops: 5/10s (matches the mutation tier — assign-issue)
      {
        channel: CHANNELS.FORGE_CREATE_ISSUE,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, input: { title: "New issue" } }),
      },
      {
        channel: CHANNELS.FORGE_CLOSE_ISSUE,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_REOPEN_ISSUE,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_EDIT_ISSUE,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1, input: { title: "Updated" } }),
      },
      {
        channel: CHANNELS.FORGE_ADD_ISSUE_COMMENT,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1, body: "Looks good" }),
      },
      {
        channel: CHANNELS.FORGE_ADD_ISSUE_LABEL,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1, label: "bug" }),
      },
      {
        channel: CHANNELS.FORGE_REMOVE_ISSUE_LABEL,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, issueNumber: 1, label: "bug" }),
      },
      // open-PR: 20/10s (matches forge:open-issue)
      { channel: CHANNELS.FORGE_OPEN_PR, maxCalls: 20, invoke: (h) => h({}, { cwd, prNumber: 1 }) },
      // PR write family: 5/10s (matches the mutation tier — assign-issue)
      {
        channel: CHANNELS.FORGE_CREATE_PR,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, head: "feature", base: "main", title: "T" }),
      },
      { channel: CHANNELS.FORGE_CLOSE_PR, maxCalls: 5, invoke: (h) => h({}, { cwd, prNumber: 1 }) },
      {
        channel: CHANNELS.FORGE_REOPEN_PR,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, prNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_MERGE_PR,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, prNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_CONVERT_PR_TO_DRAFT,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, prNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_MARK_PR_READY_FOR_REVIEW,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, prNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_COMMENT_ON_PR,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, prNumber: 1, body: "hi" }),
      },
      {
        channel: CHANNELS.FORGE_EDIT_PR,
        maxCalls: 5,
        invoke: (h) => h({}, { cwd, prNumber: 1, title: "New" }),
      },
      // capability reads: 10/10s (matches github:get-repo-stats family)
      { channel: CHANNELS.FORGE_GET_REPO_STATS, maxCalls: 10, invoke: (h) => h({}, { cwd }) },
      { channel: CHANNELS.FORGE_GET_FIRST_PAGE_CACHE, maxCalls: 10, invoke: (h) => h({}, { cwd }) },
      { channel: CHANNELS.FORGE_GET_PROJECT_HEALTH, maxCalls: 10, invoke: (h) => h({}, { cwd }) },
      {
        channel: CHANNELS.FORGE_GET_PR_REVIEW_THREADS,
        maxCalls: 10,
        invoke: (h) => h({}, { cwd, prNumber: 1 }),
      },
      // tooltip + batch lookups: 20/10s (matches github:get-*-tooltip / by-numbers)
      {
        channel: CHANNELS.FORGE_GET_ISSUE_TOOLTIP,
        maxCalls: 20,
        invoke: (h) => h({}, { cwd, issueNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_GET_PR_TOOLTIP,
        maxCalls: 20,
        invoke: (h) => h({}, { cwd, prNumber: 1 }),
      },
      {
        channel: CHANNELS.FORGE_GET_ISSUES_BY_NUMBERS,
        maxCalls: 20,
        invoke: (h) => h({}, { cwd, numbers: [1] }),
      },
      {
        channel: CHANNELS.FORGE_GET_PRS_BY_NUMBERS,
        maxCalls: 20,
        invoke: (h) => h({}, { cwd, numbers: [1] }),
      },
      // long-window probes: 30/60s (matches github:resolve-author-avatar / rate-limit-details)
      {
        channel: CHANNELS.FORGE_RESOLVE_AUTHOR_AVATAR,
        maxCalls: 30,
        windowMs: 60_000,
        invoke: (h) => h({}, { cwd, email: "dev@fake.test" }),
      },
      {
        channel: CHANNELS.FORGE_GET_RATE_LIMIT_DETAILS,
        maxCalls: 30,
        windowMs: 60_000,
        invoke: (h) => h({}, { cwd }),
      },
    ];

    it("registers all forge channels (45 rate-limited + 2 unrated probes)", () => {
      expect(specs).toHaveLength(45);
      // FORGE_GET_CURRENT_USER and FORGE_GET_TOKEN_HEALTH are intentionally
      // unrated replay/identity probes with no checkRateLimit, so they register
      // handlers but stay out of `specs`.
      expect(ipcMainMock.handle).toHaveBeenCalledTimes(47);
    });

    it.each(specs)(
      "$channel calls checkRateLimit($channel, $maxCalls, windowMs)",
      async ({ channel, maxCalls, windowMs, invoke }) => {
        const handler = getInvokeHandler(channel);
        await invoke(handler);
        expect(checkRateLimitMock).toHaveBeenCalledWith(channel, maxCalls, windowMs ?? 10_000);
      }
    );

    it.each(specs)(
      "$channel rejects before any provider work when the guard throws",
      async ({ channel, invoke }) => {
        checkRateLimitMock.mockImplementationOnce(() => {
          throw new Error("Rate limit exceeded");
        });
        const handler = getInvokeHandler(channel);

        await expect(invoke(handler)).rejects.toThrow("Rate limit exceeded");
        expect(resolveForCwdMock).not.toHaveBeenCalled();
      }
    );
  });
});

describe("forge write handlers forward the provider result (#11546)", () => {
  // Each handler changed from `await auditForgeCall(...)` to
  // `return auditForgeCall(...)`. Distinct sentinels per method mean a handler
  // that swallows its result, or forwards the wrong provider call's, fails
  // here — the type annotations alone can't catch a dropped `return`.
  const sentinels = {
    assignIssue: [{ login: "assignee-sentinel", avatarUrl: undefined, rawData: null }],
    unassignIssue: [],
    closePR: { sentinel: "closePR" },
    reopenPR: { sentinel: "reopenPR" },
    mergePR: { prNumber: 1, sha: "sha-sentinel", merged: true, message: "merged" },
    convertPRToDraft: { prNumber: 1, isDraft: true },
    markPRReadyForReview: { prNumber: 1, isDraft: false },
    commentOnPR: { sentinel: "commentOnPR" },
  } as const;

  const reviewSentinels = {
    approvePR: { sentinel: "approvePR" },
    requestChanges: { sentinel: "requestChanges" },
    dismissReview: { sentinel: "dismissReview" },
    requestReviewers: { prNumber: 1, requestedUsers: ["u"], requestedTeams: [] },
  } as const;

  const cases: Array<{
    name: string;
    channel: string;
    expected: unknown;
    invoke: (h: (...a: unknown[]) => Promise<unknown>) => Promise<unknown>;
  }> = [
    {
      name: "assignIssue",
      channel: CHANNELS.FORGE_ASSIGN_ISSUE,
      expected: sentinels.assignIssue,
      invoke: (h) => h({}, { cwd: "/repo", issueNumber: 1, username: "octocat" }),
    },
    {
      name: "unassignIssue",
      channel: CHANNELS.FORGE_UNASSIGN_ISSUE,
      expected: sentinels.unassignIssue,
      invoke: (h) => h({}, { cwd: "/repo", issueNumber: 1, username: "octocat" }),
    },
    {
      name: "closePR",
      channel: CHANNELS.FORGE_CLOSE_PR,
      expected: sentinels.closePR,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1 }),
    },
    {
      name: "reopenPR",
      channel: CHANNELS.FORGE_REOPEN_PR,
      expected: sentinels.reopenPR,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1 }),
    },
    {
      name: "mergePR",
      channel: CHANNELS.FORGE_MERGE_PR,
      expected: sentinels.mergePR,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1 }),
    },
    {
      name: "convertPRToDraft",
      channel: CHANNELS.FORGE_CONVERT_PR_TO_DRAFT,
      expected: sentinels.convertPRToDraft,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1 }),
    },
    {
      name: "markPRReadyForReview",
      channel: CHANNELS.FORGE_MARK_PR_READY_FOR_REVIEW,
      expected: sentinels.markPRReadyForReview,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1 }),
    },
    {
      name: "commentOnPR",
      channel: CHANNELS.FORGE_COMMENT_ON_PR,
      expected: sentinels.commentOnPR,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1, body: "hi" }),
    },
    {
      name: "approvePR",
      channel: CHANNELS.FORGE_APPROVE_PR,
      expected: reviewSentinels.approvePR,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1 }),
    },
    {
      name: "requestChanges",
      channel: CHANNELS.FORGE_REQUEST_CHANGES,
      expected: reviewSentinels.requestChanges,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1, body: "fix" }),
    },
    {
      name: "dismissReview",
      channel: CHANNELS.FORGE_DISMISS_REVIEW,
      expected: reviewSentinels.dismissReview,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1, reviewId: 9, message: "stale" }),
    },
    {
      name: "requestReviewers",
      channel: CHANNELS.FORGE_REQUEST_REVIEWERS,
      expected: reviewSentinels.requestReviewers,
      invoke: (h) => h({}, { cwd: "/repo", prNumber: 1, users: ["octocat"] }),
    },
  ];

  beforeEach(() => {
    for (const [method, value] of Object.entries(sentinels)) {
      (fakeImpl[method as keyof typeof sentinels] as Mock).mockResolvedValue(value);
    }
    for (const [method, value] of Object.entries(reviewSentinels)) {
      (fakeImpl.reviews[method as keyof typeof reviewSentinels] as Mock).mockResolvedValue(value);
    }
  });

  it.each(cases)("$name resolves to the provider's result", async ({ channel, expected, invoke }) => {
    await expect(invoke(getInvokeHandler(channel))).resolves.toEqual(expected);
  });
});
