import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveForCwdMock, createIssueMock } = vi.hoisted(() => ({
  resolveForCwdMock: vi.fn(),
  createIssueMock: vi.fn(),
}));

vi.mock("../../../ipc/handlers/forgeResolution.js", () => ({
  resolveForCwd: resolveForCwdMock,
}));

// auditForgeCall is a transparent timing wrapper — invoke the thunk directly so
// tests exercise the real provider-call path without the audit store.
vi.mock("../../forge/forgeAuditService.js", () => ({
  auditForgeCall: (_meta: unknown, run: () => Promise<unknown>) => run(),
  summarizeForgeArgs: () => "",
}));

import { githubCreateIssueCommand } from "../githubCreateIssue.js";

const repoRef = { host: "github.com", owner: "daintree", repo: "app", rawData: {} };

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Improve logging",
    body: "",
    state: "open",
    rawState: "open",
    url: "https://github.com/daintree/app/issues/42",
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    rawData: {},
    ...overrides,
  };
}

describe("githubCreateIssueCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createIssueMock.mockResolvedValue(makeIssue());
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "daintree.github:github",
      providerId: "github",
      repoRef,
      impl: { createIssue: createIssueMock },
    });
  });

  it("maps a provider missing-token failure to EXECUTION_ERROR with a settings pointer", async () => {
    createIssueMock.mockRejectedValue(
      new Error("GitHub token not configured. Set it in Settings.")
    );

    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      title: "No token",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    expect(result.error?.message).toContain("Set it in Settings");
  });

  it("returns NO_CWD when no working directory is in context", async () => {
    const result = await githubCreateIssueCommand.execute({} as never, { title: "No cwd" });

    expect(result).toMatchObject({ success: false, error: { code: "NO_CWD" } });
    expect(resolveForCwdMock).not.toHaveBeenCalled();
  });

  it("returns NOT_GIT_REPO when provider resolution throws", async () => {
    resolveForCwdMock.mockRejectedValue(new Error("No forge provider registered"));

    await expect(
      githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
        title: "Failure handling test",
      })
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_GIT_REPO" },
    });
  });

  it("creates an issue via the resolved provider", async () => {
    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      title: "  Improve logging  ",
      body: "  Add structured logs to PTY lifecycle  ",
      labels: "bug, infrastructure, ,bug",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      url: "https://github.com/daintree/app/issues/42",
      number: 42,
      title: "Improve logging",
    });

    expect(createIssueMock).toHaveBeenCalledWith(repoRef, {
      title: "Improve logging",
      body: "Add structured logs to PTY lifecycle",
      labels: ["bug", "infrastructure", "bug"],
    });
  });

  it("synthesizes title from the first body line, stripping a trailing carriage return", async () => {
    await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      body: "First line\r\nSecond line",
    });

    expect(createIssueMock).toHaveBeenCalledWith(
      repoRef,
      expect.objectContaining({ title: "First line", body: "First line\r\nSecond line" })
    );
  });

  it("returns NO_INPUT when neither title nor body is provided", async () => {
    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {});

    expect(result).toMatchObject({ success: false, error: { code: "NO_INPUT" } });
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("classifies a TimeoutError from the provider as TIMEOUT_ERROR", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    createIssueMock.mockRejectedValue(timeoutError);

    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      title: "Timeout test",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT_ERROR");
    expect(result.error?.message).toContain("Timed out");
  });

  it("classifies a provider error with cause.code as NETWORK_ERROR", async () => {
    const transportError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
    createIssueMock.mockRejectedValue(transportError);

    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      title: "Network cause test",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NETWORK_ERROR");
  });

  it("maps a generic provider failure to EXECUTION_ERROR", async () => {
    createIssueMock.mockRejectedValue(new Error("Failed to create issue: HTTP 422 — Validation"));

    const result = await githubCreateIssueCommand.execute({ cwd: "/repo" } as never, {
      title: "Generic failure",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
    expect(result.error?.message).toContain("HTTP 422");
  });
});
