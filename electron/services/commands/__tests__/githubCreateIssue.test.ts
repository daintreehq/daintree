import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { getGitHubTokenMock, getRepoContextMock, clearGitHubCachesMock } = vi.hoisted(() => ({
  getGitHubTokenMock: vi.fn(),
  getRepoContextMock: vi.fn(),
  clearGitHubCachesMock: vi.fn(),
}));

vi.mock("../../GitHubService.js", () => ({
  getGitHubToken: getGitHubTokenMock,
  getRepoContext: getRepoContextMock,
  clearGitHubCaches: clearGitHubCachesMock,
}));

import { githubCreateIssueCommand } from "../githubCreateIssue.js";

describe("githubCreateIssueCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubTokenMock.mockReturnValue("token-123");
    getRepoContextMock.mockResolvedValue({ owner: "canopy", repo: "app" });
    (globalThis as unknown as { fetch: Mock }).fetch = vi.fn();
  });

  it("returns NOT_GIT_REPO when repository context lookup throws", async () => {
    getRepoContextMock.mockRejectedValue(new Error("git command failed"));

    await expect(
      githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
        title: "Failure handling test",
      })
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_GIT_REPO" },
    });
  });

  it("creates an issue and clears GitHub caches on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        html_url: "https://github.com/canopy/app/issues/42",
        number: 42,
        title: "Improve logging",
      }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = fetchMock;

    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      title: "  Improve logging  ",
      body: "  Add structured logs to PTY lifecycle  ",
      labels: "bug, infrastructure, ,bug",
    });

    expect(result.success).toBe(true);
    expect(clearGitHubCachesMock).toHaveBeenCalledTimes(1);

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(requestBody).toEqual({
      title: "Improve logging",
      body: "Add structured logs to PTY lifecycle",
      labels: ["bug", "infrastructure", "bug"],
    });
  });

  it("maps fetch transport failures to NETWORK_ERROR", async () => {
    (globalThis as unknown as { fetch: Mock }).fetch = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed"));

    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      title: "Network mapping",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NETWORK_ERROR");
  });
});
