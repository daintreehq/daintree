// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveUnknownOutcome } = vi.hoisted(() => ({ resolveUnknownOutcome: vi.fn() }));

vi.mock("@/utils/resolveUnknownOutcome", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/resolveUnknownOutcome")>()),
  resolveUnknownOutcome,
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { worktreeClient, worktreeCreateResultFromOutcome } from "../worktreeClient";

const create = vi.fn();
const options = { baseBranch: "main", newBranch: "feature-x", path: "/srv/repo-feature-x" };
const created = { worktreeId: "/srv/repo-feature-x", branch: "feature-x", setupState: "pending" };

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    value: { worktree: { create } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  delete window.__DAINTREE_HOST_ID__;
});

describe("worktreeClient.create", () => {
  it("names no operation in a local view: the create runs exactly as before", async () => {
    create.mockResolvedValue(created);
    await expect(worktreeClient.create(options, "/srv/repo")).resolves.toEqual(created);
    expect(create).toHaveBeenCalledWith(options, "/srv/repo");
  });

  it("names the create in a remote view, and asks the host what happened when the answer is lost", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    create.mockRejectedValue(new Error("[AppError|HOST_DISCONNECTED] The link dropped"));
    resolveUnknownOutcome.mockResolvedValue({
      status: "succeeded",
      result: created,
      settledAt: 1,
    });

    await expect(worktreeClient.create(options, "/srv/repo")).resolves.toEqual(created);

    const opId = create.mock.calls[0]![2] as string;
    expect(opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveUnknownOutcome).toHaveBeenCalledWith(opId, expect.any(Object));
    // Resolved, not retried: one create was sent.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports an outcome the host has no record of instead of retrying blind", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    create.mockRejectedValue(new Error("[AppError|OUTCOME_UNKNOWN] no answer"));
    resolveUnknownOutcome.mockResolvedValue({ status: "unknown" });

    await expect(worktreeClient.create(options, "/srv/repo")).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("passes an ordinary failure straight through", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    create.mockRejectedValue(new Error("[AppError|DRIVEN_ELSEWHERE] driven elsewhere"));
    await expect(worktreeClient.create(options, "/srv/repo")).rejects.toThrow("driven elsewhere");
    expect(resolveUnknownOutcome).not.toHaveBeenCalled();
  });
});

describe("worktreeCreateResultFromOutcome", () => {
  it("rebuilds the create's answer from the host's record", () => {
    expect(worktreeCreateResultFromOutcome(created)).toEqual(created);
    expect(worktreeCreateResultFromOutcome({ worktreeId: "w", branch: "b" })).toEqual({
      worktreeId: "w",
      branch: "b",
      setupState: "unknown",
    });
    expect(() => worktreeCreateResultFromOutcome({ branch: "b" })).toThrow();
  });
});
