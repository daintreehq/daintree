import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateHardenedGit, mockCreateWslHardenedGit } = vi.hoisted(() => ({
  mockCreateHardenedGit: vi.fn(),
  mockCreateWslHardenedGit: vi.fn(),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: mockCreateHardenedGit,
  createWslHardenedGit: mockCreateWslHardenedGit,
}));

import { refreshWorktreeIndex } from "../indexRefresh.js";

describe("refreshWorktreeIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks whether to start only once the git factory is ready, and starts nothing on a no", async () => {
    const raw = vi.fn().mockResolvedValue("");
    let resolveGit!: (git: { raw: typeof raw }) => void;
    mockCreateHardenedGit.mockReturnValue(new Promise((resolve) => (resolveGit = resolve)));
    let wanted = true;
    const mayStart = vi.fn(() => wanted);

    const refresh = refreshWorktreeIndex("/test/worktree", undefined, mayStart);
    await Promise.resolve();
    expect(mayStart).not.toHaveBeenCalled();
    wanted = false;
    resolveGit({ raw });
    await refresh;

    expect(mayStart).toHaveBeenCalledTimes(1);
    expect(raw).not.toHaveBeenCalled();
  });

  it("runs a WSL worktree's refresh inside the distro", async () => {
    const raw = vi.fn().mockResolvedValue("");
    mockCreateWslHardenedGit.mockResolvedValue({ raw });
    const wsl = { distro: "Ubuntu", uncPath: "\\\\wsl$\\Ubuntu\\repo", posixPath: "/repo" };

    await refreshWorktreeIndex(wsl.uncPath, wsl, () => true);

    expect(mockCreateWslHardenedGit).toHaveBeenCalledWith(wsl);
    expect(mockCreateHardenedGit).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
