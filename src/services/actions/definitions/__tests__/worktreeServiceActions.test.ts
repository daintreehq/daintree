// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionDefinition } from "../../actionTypes";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

const mockRefreshPullRequests = vi.fn().mockResolvedValue(undefined);
vi.mock("@/clients", () => ({
  worktreeClient: { refreshPullRequests: () => mockRefreshPullRequests() },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => null,
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({}) },
}));

const mockRequest = vi.fn();

type ActionFactory = () => AnyActionDefinition;

describe("worktree service action definitions", () => {
  const registry = new Map<string, ActionFactory>();

  beforeAll(async () => {
    (globalThis as unknown as { window: Window }).window = globalThis.window ?? ({} as Window);
    (window as unknown as { electron: unknown }).electron = {
      worktreePort: { request: (...args: unknown[]) => mockRequest(...args) },
    };

    const { registerWorktreeServiceActions } = await import("../worktreeServiceActions");
    registerWorktreeServiceActions(registry as never, {} as never);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ ok: true });
    mockRefreshPullRequests.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the refresh and reconcile actions", () => {
    expect(registry.has("worktree.refresh")).toBe(true);
    expect(registry.has("worktree.reconcileTopology")).toBe(true);
  });

  it("worktree.refresh requests a host refresh and does not notify on success", async () => {
    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    expect(mockRequest).toHaveBeenCalledWith("refresh");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("worktree.refresh surfaces an error toast when the host does not respond", async () => {
    mockRequest.mockRejectedValueOnce(new Error("Worktree port timed out"));

    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const payload = mockNotify.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Refresh failed");
    expect(payload.message).toContain("Worktree port timed out");
  });

  it("worktree.refresh surfaces an error toast when the host reports ok:false (watchdog tripped)", async () => {
    mockRequest.mockResolvedValueOnce({ ok: false, error: "Refresh watchdog tripped" });

    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const payload = mockNotify.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Refresh failed");
    expect(payload.message).toBe("Refresh watchdog tripped");
  });

  it("worktree.refresh drives both the active host and the pool-wide PR fan-out", async () => {
    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    // These reach different hosts and are NOT interchangeable: the worktree
    // port is bound to this view's project alone, while refreshPullRequests
    // fans out across every pooled project. Dropping either as a "duplicate"
    // silently narrows what a refresh actually covers — the duplicate work it
    // used to cause is coalesced host-side instead (#11633).
    expect(mockRequest).toHaveBeenCalledWith("refresh");
    expect(mockRefreshPullRequests).toHaveBeenCalledTimes(1);
  });

  it("worktree.refresh does not let a PR-refresh failure surface as a refresh error", async () => {
    mockRefreshPullRequests.mockRejectedValueOnce(new Error("rate limited"));

    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    // Only the worktree refresh request governs the error toast; a PR fetch
    // failure is independent and must not raise "Refresh failed".
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("worktree.reconcileTopology forces the reconcile so it can't be coalesced away", async () => {
    const def = registry.get("worktree.reconcileTopology")!();
    await def.run!(undefined as never, undefined as never);

    expect(mockRequest).toHaveBeenCalledWith("reconcile-topology", { force: true });
  });
});
