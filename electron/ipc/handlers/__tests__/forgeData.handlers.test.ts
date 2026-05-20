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

import { registerForgeDataHandlers } from "../forgeData.js";

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
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "fake.provider",
      repoRef,
      impl: fakeImpl as unknown as ForgeProviderImpl,
    });
  });

  it("registers five IPC handlers", () => {
    const cleanup = registerForgeDataHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(5);
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:list-issues", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:list-prs", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-issue", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-pr", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-repo-metadata",
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

  it("propagates provider resolution failures (e.g. provider not activated)", async () => {
    resolveForCwdMock.mockRejectedValue(
      new Error("No forge provider registered for this repository")
    );
    registerForgeDataHandlers();
    await expect(findHandler("forge:list-issues")(null, { cwd: "/repo" })).rejects.toThrow(
      "No forge provider registered"
    );
  });
});
