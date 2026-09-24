import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getProjectSettings: vi.fn(),
  listWorktrees: vi.fn(),
  listRemotes: vi.fn(),
  listMatchingProviders: vi.fn(),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getProjectById: mocks.getProjectById,
    getProjectSettings: mocks.getProjectSettings,
  },
}));

vi.mock("../GitServiceCache.js", () => ({
  gitServiceCache: {
    getGitService: () => ({
      listWorktrees: mocks.listWorktrees,
      listRemotes: mocks.listRemotes,
    }),
  },
}));

vi.mock("../forgeProviderRegistry.js", () => ({
  listMatchingProviders: mocks.listMatchingProviders,
}));

import { readHelpSessionProjectFacts } from "../helpSessionProjectMetadataReader.js";

describe("readHelpSessionProjectFacts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getProjectById.mockReset().mockReturnValue({ name: "Example" });
    mocks.getProjectSettings.mockReset().mockResolvedValue({});
    mocks.listWorktrees.mockReset().mockResolvedValue([
      { path: "/repo.git", branch: "", bare: true, isMainWorktree: true },
      { path: "/work/example", branch: "main", bare: false, isMainWorktree: false },
    ]);
    mocks.listRemotes
      .mockReset()
      .mockResolvedValue([{ name: "origin", fetchUrl: "https://TOKEN@github.com/acme/x.git" }]);
    mocks.listMatchingProviders.mockReset().mockReturnValue([{}]);
  });

  it("collects the name, non-bare worktrees and a sanitized forge remote", async () => {
    const facts = await readHelpSessionProjectFacts("proj-1", "/work/example");
    expect(facts).toEqual({
      name: "Example",
      worktrees: [{ path: "/work/example", branch: "main", isMainWorktree: false }],
      forgeRemote: { name: "origin", url: "https://github.com/acme/x.git" },
    });
    expect(mocks.getProjectById).toHaveBeenCalledWith("proj-1");
    expect(mocks.listRemotes).toHaveBeenCalledWith("/work/example");
  });

  it("follows the project's configured forge remote", async () => {
    mocks.getProjectSettings.mockResolvedValue({ forgeRemote: "upstream" });
    mocks.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "git@github.com:me/x.git" },
      { name: "upstream", fetchUrl: "git@github.com:acme/x.git" },
    ]);
    const facts = await readHelpSessionProjectFacts("proj-1", "/work/example");
    expect(facts.forgeRemote).toEqual({ name: "upstream", url: "github.com:acme/x.git" });
  });

  it("prefers a remote a forge provider recognises", async () => {
    mocks.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://internal.example/x.git" },
      { name: "gh", fetchUrl: "https://github.com/acme/x.git" },
    ]);
    mocks.listMatchingProviders.mockImplementation((url: string) =>
      url.includes("github.com") ? [{}] : []
    );
    const facts = await readHelpSessionProjectFacts("proj-1", "/work/example");
    expect(facts.forgeRemote?.name).toBe("gh");
  });

  it("omits the forge remote when the configured one is missing", async () => {
    mocks.getProjectSettings.mockResolvedValue({ forgeRemote: "gone" });
    const facts = await readHelpSessionProjectFacts("proj-1", "/work/example");
    expect(facts.forgeRemote).toBeUndefined();
    expect(facts.name).toBe("Example");
  });

  it("omits each failed lookup independently without logging its message", async () => {
    mocks.getProjectById.mockImplementation(() => {
      throw new Error("db closed");
    });
    mocks.listRemotes.mockRejectedValue(new Error("fatal: https://TOKEN@github.com/acme/x.git"));
    const facts = await readHelpSessionProjectFacts("proj-1", "/work/example");
    expect(facts.name).toBeUndefined();
    expect(facts.forgeRemote).toBeUndefined();
    expect(facts.worktrees).toHaveLength(1);
    const logged = JSON.stringify((console.warn as unknown as { mock: { calls: unknown[] } }).mock);
    expect(logged).not.toContain("TOKEN");
  });

  it("omits the worktree list when git can't enumerate it", async () => {
    mocks.listWorktrees.mockRejectedValue(new Error("not a git repository"));
    const facts = await readHelpSessionProjectFacts("proj-1", "/work/example");
    expect(facts.worktrees).toBeUndefined();
    expect(facts.name).toBe("Example");
  });
});
