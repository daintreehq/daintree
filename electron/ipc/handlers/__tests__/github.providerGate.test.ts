import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

const gitHubServiceMock = vi.hoisted(() => ({
  listIssues: vi.fn().mockResolvedValue({ issues: [], nextCursor: null }),
  listPullRequests: vi.fn().mockResolvedValue({ prs: [], nextCursor: null }),
  unassignIssue: vi.fn().mockResolvedValue(undefined),
  getRepoStatsComplete: vi.fn().mockResolvedValue({
    stats: { commitCount: 0, issueCount: null, prCount: null, loading: false },
  }),
  setTokenAndSync: vi
    .fn()
    .mockResolvedValue({ valid: true, scopes: [], username: "user", avatarUrl: null }),
  clearTokenAndSync: vi.fn().mockResolvedValue(undefined),
  getGitHubConfigAsync: vi.fn().mockResolvedValue({ hasToken: true }),
  hasGitHubToken: vi.fn().mockReturnValue(true),
  listGitHubRemotes: vi.fn().mockResolvedValue([]),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  shell: shellMock,
  BrowserWindow: {
    fromWebContents: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../utils.js", () => ({
  checkRateLimit: vi.fn(),
  broadcastToRenderer: vi.fn(),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../services/github/index.js", () => ({
  gitHubRateLimitService: {
    onStateChange: vi.fn().mockReturnValue(() => {}),
  },
  gitHubTokenHealthService: {
    onStateChange: vi.fn().mockReturnValue(() => {}),
    getState: vi.fn().mockReturnValue({ status: "unknown", tokenVersion: -1, checkedAt: 0 }),
  },
  fetchRateLimitDetails: vi.fn().mockResolvedValue(null),
  resolveAuthorAvatar: vi.fn().mockResolvedValue(null),
  setTokenAndSync: gitHubServiceMock.setTokenAndSync,
  clearTokenAndSync: gitHubServiceMock.clearTokenAndSync,
  listIssues: gitHubServiceMock.listIssues,
  listPullRequests: gitHubServiceMock.listPullRequests,
  unassignIssue: gitHubServiceMock.unassignIssue,
  getRepoStatsComplete: gitHubServiceMock.getRepoStatsComplete,
  getGitHubConfigAsync: gitHubServiceMock.getGitHubConfigAsync,
  hasGitHubToken: gitHubServiceMock.hasGitHubToken,
  listGitHubRemotes: gitHubServiceMock.listGitHubRemotes,
}));

import { CHANNELS } from "../../channels.js";
import { registerGithubHandlers, githubUnassignIssueNamespace } from "../github.js";
import {
  registerForgeProviderImpl,
  unregisterForgeProviderImpls,
} from "../../../services/forgeProviderRegistry.js";
import type { ForgeProviderImpl } from "../../../../shared/types/forge.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function activateGitHubProvider(): void {
  registerForgeProviderImpl("daintree.github", "github", {} as ForgeProviderImpl);
}

describe("github handlers — provider gate (plugin authoritative)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unregisterForgeProviderImpls("daintree.github");
    registerGithubHandlers({} as never);
  });

  afterEach(() => {
    unregisterForgeProviderImpls("daintree.github");
  });

  describe("with the GitHub plugin disabled (no provider impl registered)", () => {
    it("rejects github:list-issues with FORGE_PROVIDER_UNAVAILABLE before reaching plugin code", async () => {
      const handler = getInvokeHandler(CHANNELS.GITHUB_LIST_ISSUES);

      await expect(handler({} as never, { cwd: "/tmp/project" })).rejects.toHaveProperty(
        "code",
        "FORGE_PROVIDER_UNAVAILABLE"
      );
      expect(gitHubServiceMock.listIssues).not.toHaveBeenCalled();
    });

    it("rejects github:get-repo-stats without invoking the plugin fetch", async () => {
      const handler = getInvokeHandler(CHANNELS.GITHUB_GET_REPO_STATS);

      await expect(handler({} as never, "/tmp/project")).rejects.toHaveProperty(
        "code",
        "FORGE_PROVIDER_UNAVAILABLE"
      );
      expect(gitHubServiceMock.getRepoStatsComplete).not.toHaveBeenCalled();
    });

    it("rejects github:set-token (network validation requires the provider)", async () => {
      const handler = getInvokeHandler(CHANNELS.GITHUB_SET_TOKEN);

      await expect(handler({} as never, "ghp_token")).rejects.toHaveProperty(
        "code",
        "FORGE_PROVIDER_UNAVAILABLE"
      );
      expect(gitHubServiceMock.setTokenAndSync).not.toHaveBeenCalled();
    });

    it("rejects the namespace-registered github:unassign-issue", async () => {
      const handler = githubUnassignIssueNamespace.ops.unassignIssue.handler;

      await expect(
        handler({ cwd: "/tmp/project", issueNumber: 1, username: "octocat" })
      ).rejects.toHaveProperty("code", "FORGE_PROVIDER_UNAVAILABLE");
      expect(gitHubServiceMock.unassignIssue).not.toHaveBeenCalled();
    });

    it("keeps purely-local handlers live: github:open-pr opens externally", async () => {
      const handler = getInvokeHandler(CHANNELS.GITHUB_OPEN_PR);

      await handler({} as never, "https://github.com/owner/repo/pull/1");
      expect(shellMock.openExternal).toHaveBeenCalled();
    });

    it("keeps token-state reads live: github:get-config and github:clear-token", async () => {
      await getInvokeHandler(CHANNELS.GITHUB_GET_CONFIG)({} as never);
      expect(gitHubServiceMock.getGitHubConfigAsync).toHaveBeenCalled();

      await getInvokeHandler(CHANNELS.GITHUB_CLEAR_TOKEN)({} as never);
      expect(gitHubServiceMock.clearTokenAndSync).toHaveBeenCalled();
    });

    it("keeps provider-agnostic project:list-remotes live", async () => {
      await getInvokeHandler(CHANNELS.PROJECT_LIST_REMOTES)({} as never, "/tmp/project");
      expect(gitHubServiceMock.listGitHubRemotes).toHaveBeenCalled();
    });
  });

  describe("provider activation transitions (live toggle)", () => {
    it("serves data once the impl registers, and rejects again after it unregisters", async () => {
      const handler = getInvokeHandler(CHANNELS.GITHUB_LIST_ISSUES);

      activateGitHubProvider();
      await handler({} as never, { cwd: "/tmp/project" });
      expect(gitHubServiceMock.listIssues).toHaveBeenCalledTimes(1);

      unregisterForgeProviderImpls("daintree.github");
      await expect(handler({} as never, { cwd: "/tmp/project" })).rejects.toHaveProperty(
        "code",
        "FORGE_PROVIDER_UNAVAILABLE"
      );
      expect(gitHubServiceMock.listIssues).toHaveBeenCalledTimes(1);
    });
  });
});
