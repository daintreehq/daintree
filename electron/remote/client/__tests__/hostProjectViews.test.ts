import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundRestoreResult } from "../../../window/ProjectViewRestoreController.js";
import {
  prepareHostProjectView,
  type HostProjectViewDeps,
  type HostProjectViewOwner,
} from "../hostProjectViews.js";

const KEY = "studio-01:proj-1";
const HOST = "studio-01";

describe("prepareHostProjectView (#13392)", () => {
  let owner: HostProjectViewOwner | null;
  let windows: number[];
  let restores: Record<number, BackgroundRestoreResult | null>;
  let claims: Array<{ windowId: number; released: boolean }>;
  let deps: HostProjectViewDeps & { restore: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    owner = null;
    windows = [10, 11];
    restores = {};
    claims = [];
    deps = {
      owner: () => owner,
      windowsOn: () => windows,
      restore: vi.fn(async (windowId: number) => {
        const result = restores[windowId] ?? { status: "restored" };
        if (result?.status === "restored") {
          owner = { state: "cached", entry: { state: "cached", webContentsId: 40 + windowId } };
        }
        return result;
      }),
      claim: (_key, windowId) => {
        const claim = { windowId, released: false };
        claims.push(claim);
        return () => {
          claim.released = true;
        };
      },
    };
  });

  it("uses a loaded view some window already has, restoring nothing", async () => {
    owner = { state: "foreground", entry: { state: "active", webContentsId: 7 } };
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "ready",
      webContentsId: 7,
      created: false,
    });
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it("calls a view that's still loading, or a project another window is opening, busy", async () => {
    owner = { state: "cached", entry: { state: "loading", webContentsId: 7 } };
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "busy",
    });
    owner = { state: "activating", entry: null };
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "busy",
    });
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it("restores one in the background in the first window on the host with room", async () => {
    restores[10] = { status: "deferred", reason: "capacity" };
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "ready",
      webContentsId: 51,
      created: true,
    });
    expect(deps.restore.mock.calls.map(([windowId]) => windowId)).toEqual([10, 11]);
    expect(claims).toEqual([
      { windowId: 10, released: true },
      { windowId: 11, released: true },
    ]);
  });

  it("never opens a second view when a restore was cancelled, or when one appears meanwhile", async () => {
    restores[10] = { status: "skipped", reason: "cancelled" };
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "busy",
    });
    expect(deps.restore).toHaveBeenCalledTimes(1);

    deps.restore.mockClear();
    deps.restore.mockImplementationOnce(async () => {
      // The person opened it in another window while this one was full.
      owner = { state: "foreground", entry: { state: "active", webContentsId: 99 } };
      return { status: "deferred", reason: "pressure" };
    });
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "ready",
      webContentsId: 99,
      created: false,
    });
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });

  it("says why there's nowhere to put one", async () => {
    windows = [];
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "no-window",
    });
    windows = [10, 11];
    restores[10] = { status: "deferred", reason: "capacity" };
    restores[11] = { status: "deferred", reason: "pressure" };
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).resolves.toEqual({
      status: "no-room",
    });
    expect(claims.every((claim) => claim.released)).toBe(true);
  });

  it("releases its claim when a restore throws", async () => {
    deps.restore.mockRejectedValueOnce(new Error("view crashed"));
    await expect(prepareHostProjectView(deps, KEY, HOST, "/p")).rejects.toThrow("view crashed");
    expect(claims).toEqual([{ windowId: 10, released: true }]);
  });
});
