import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worktrees = new Map([["wt-1", { id: "wt-1", path: "/srv/app" }]]);
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => ({ getState: () => ({ worktrees }) }),
}));

import { grantClickedHostFile } from "../clickedHostFile";

vi.stubGlobal("window", {});

const grantClickedFile = vi.fn(async () => {});

describe("grantClickedHostFile", () => {
  beforeEach(() => {
    grantClickedFile.mockReset().mockResolvedValue(undefined);
    (window as unknown as { electron: unknown }).electron = { fileTransfer: { grantClickedFile } };
  });

  afterEach(() => {
    delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  });

  it("asks nothing of a view of this machine", async () => {
    await grantClickedHostFile("/tmp/shot.png");
    window.__DAINTREE_HOST_ID__ = { id: "local" };
    await grantClickedHostFile("/tmp/shot.png");
    expect(grantClickedFile).not.toHaveBeenCalled();
  });

  it("tells a remote view's host about a clicked file outside every worktree", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-03" };
    await grantClickedHostFile("/tmp/shot.png");
    expect(grantClickedFile).toHaveBeenCalledWith({
      hostId: "studio-03",
      hostPath: "/tmp/shot.png",
    });
  });

  it("skips the round trip for a file inside a worktree", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-03" };
    await grantClickedHostFile("/srv/app/src/index.ts");
    expect(grantClickedFile).not.toHaveBeenCalled();
  });

  it("leaves a refusal to the viewer instead of failing the click", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-03" };
    grantClickedFile.mockRejectedValue(Object.assign(new Error("no"), { code: "NOT_A_FILE" }));
    await expect(grantClickedHostFile("/tmp/missing.png")).resolves.toBeUndefined();
  });
});
