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
  assignIssue: vi.fn(),
  unassignIssue: vi.fn(),
  validateToken: vi.fn(),
  classifyPushError: vi.fn(),
  listIssues: vi.fn(),
  listPRs: vi.fn(),
  getIssue: vi.fn(),
  getPR: vi.fn(),
  getRepoMetadata: vi.fn(),
}));

const resolveForCwdMock = vi.hoisted(() => vi.fn());

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../utils.js", () => ({
  checkRateLimit: checkRateLimitMock,
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

vi.mock("../../../utils/openExternal.js", () => ({
  openExternalUrl: openExternalUrlMock,
}));

vi.mock("../forgeResolution.js", () => ({
  resolveForCwd: resolveForCwdMock,
  getImplForNamespace: () => fakeImpl,
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));

vi.mock("../../../services/forgeProviderRegistry.js", () => ({
  getForgeProviderImpl: () => fakeImpl,
  getRegisteredForgeProviders: () => [{ pluginId: "fake-plugin", contribution: { id: "fake" } }],
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
    fakeImpl.assignIssue.mockResolvedValue(undefined);
    fakeImpl.unassignIssue.mockResolvedValue(undefined);
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

  describe("token family (forge:validate-token)", () => {
    it("calls checkRateLimit with token limits (5, 10_000)", async () => {
      const handler = getInvokeHandler(CHANNELS.FORGE_VALIDATE_TOKEN);
      await handler({}, "fake_token");

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FORGE_VALIDATE_TOKEN, 5, 10_000);
      expect(fakeImpl.validateToken).toHaveBeenCalled();
    });

    it("rejects and skips validateToken when rate limit throws", async () => {
      checkRateLimitMock.mockImplementationOnce(() => {
        throw new Error("Rate limit exceeded");
      });
      const handler = getInvokeHandler(CHANNELS.FORGE_VALIDATE_TOKEN);

      await expect(handler({}, "fake_token")).rejects.toThrow("Rate limit exceeded");
      expect(fakeImpl.validateToken).not.toHaveBeenCalled();
      // The guard fires before provider lookup, not just before the API call.
      expect(storeMock.get).not.toHaveBeenCalled();
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
      // token + mutation family: 5/10s (matches github:validate-token / assign-issue)
      { channel: CHANNELS.FORGE_VALIDATE_TOKEN, maxCalls: 5, invoke: (h) => h({}, "fake_token") },
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
    ];

    it("registers all 14 forge channels", () => {
      expect(specs).toHaveLength(14);
      expect(ipcMainMock.handle).toHaveBeenCalledTimes(14);
    });

    it.each(specs)(
      "$channel calls checkRateLimit($channel, $maxCalls, 10_000)",
      async ({ channel, maxCalls, invoke }) => {
        const handler = getInvokeHandler(channel);
        await invoke(handler);
        expect(checkRateLimitMock).toHaveBeenCalledWith(channel, maxCalls, 10_000);
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
