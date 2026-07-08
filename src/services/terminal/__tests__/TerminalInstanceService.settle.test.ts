// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({
      visualBuffers: [],
      signalBuffer: null,
    })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

type RestoreState = ManagedTerminal["scrollbackRestoreState"];

type SettleTestService = {
  instances: Map<string, unknown>;
  waitForFullySettled: (id: string, options?: { timeoutMs?: number }) => Promise<void>;
  waitForAllFullySettled: (ids: string[], options?: { timeoutMs?: number }) => Promise<void>;
  notifyRestoreSettledWaiters: (id: string) => void;
  notifyAttachSettledWaiters: (id: string) => void;
  fullySettledWaiters: Map<string, unknown[]>;
  destroy: (id: string) => void;
  resizeController: Record<string, (...args: unknown[]) => unknown>;
  webGLManager: Record<string, (...args: unknown[]) => unknown>;
  agentStateController: Record<string, (...args: unknown[]) => unknown>;
  restoreController: Record<string, (...args: unknown[]) => unknown>;
  dataBuffer: Record<string, (...args: unknown[]) => unknown>;
  unseenTracker: Record<string, (...args: unknown[]) => unknown>;
};

describe("TerminalInstanceService fully-settled waits", () => {
  let service: SettleTestService;

  // Builds a managed terminal whose visual-attach predicate passes by default
  // (opened, not attaching, host connected, element present). Restore state is
  // caller-controlled so each test drives the second half of the predicate.
  const makeManaged = (
    id: string,
    overrides: Partial<{
      isOpened: boolean;
      isAttaching: boolean;
      scrollbackRestoreState: RestoreState;
      lastScrollbackRestoreError: ManagedTerminal["lastScrollbackRestoreError"];
      connected: boolean;
    }> = {}
  ) => {
    const hostElement = document.createElement("div");
    if (overrides.connected !== false) document.body.appendChild(hostElement);
    const managed = {
      id,
      terminal: {
        element: document.createElement("div"),
        dispose: vi.fn(),
      },
      hostElement,
      isOpened: overrides.isOpened ?? true,
      isAttaching: overrides.isAttaching ?? false,
      isVisible: true,
      scrollbackRestoreState: overrides.scrollbackRestoreState ?? "none",
      lastScrollbackRestoreError: overrides.lastScrollbackRestoreError,
      attachRevealToken: 0,
      listeners: [],
      exitSubscribers: new Set(),
      agentStateSubscribers: new Set(),
      altBufferListeners: new Set(),
    };
    service.instances.set(id, managed);
    return managed as unknown as ManagedTerminal & { scrollbackRestoreState: RestoreState };
  };

  const stubDestroyCollaborators = () => {
    for (const fn of ["clearResizeJob", "clearResizeLock", "clearSettledTimer"]) {
      vi.spyOn(service.resizeController, fn).mockImplementation(() => {});
    }
    vi.spyOn(service.webGLManager, "onTerminalDestroyed").mockImplementation(() => {});
    vi.spyOn(service.agentStateController, "destroy").mockImplementation(() => {});
    vi.spyOn(service.restoreController, "destroy").mockImplementation(() => {});
    vi.spyOn(service.dataBuffer, "resetForTerminal").mockImplementation(() => {});
    vi.spyOn(service.unseenTracker, "destroy").mockImplementation(() => {});
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: SettleTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    document.body.innerHTML = "";
  });

  it("resolves immediately when attached and restore state is 'done'", async () => {
    makeManaged("t1", { scrollbackRestoreState: "done" });
    await expect(service.waitForFullySettled("t1")).resolves.toBeUndefined();
  });

  it("resolves immediately when attached and restore was never scheduled ('none', no error)", async () => {
    makeManaged("t1", { scrollbackRestoreState: "none" });
    await expect(service.waitForFullySettled("t1")).resolves.toBeUndefined();
  });

  it.each(["pending", "in-progress"] as const)(
    "does not settle while restore is %s",
    async (state) => {
      makeManaged("t1", { scrollbackRestoreState: state });
      let settled = false;
      const promise = service.waitForFullySettled("t1", { timeoutMs: 50 }).then(
        () => {
          settled = true;
        },
        () => {
          // timeout rejection — expected
        }
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      await promise;
      expect(settled).toBe(false);
    }
  );

  it("notify is a no-op while restore is in-progress; resolves only once done", async () => {
    const managed = makeManaged("t1", { scrollbackRestoreState: "in-progress" });
    let settled = false;
    const promise = service.waitForFullySettled("t1").then(() => {
      settled = true;
    });
    await Promise.resolve();

    // Spurious notify while still in-progress must not drain the waiter.
    service.notifyRestoreSettledWaiters("t1");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(service.fullySettledWaiters.has("t1")).toBe(true);

    managed.scrollbackRestoreState = "done";
    service.notifyRestoreSettledWaiters("t1");
    await promise;
    expect(settled).toBe(true);
  });

  it("waits for visual attach even when restore finished first (attach-after-restore race)", async () => {
    // Restore is already done, but the terminal is still mid-attach.
    const managed = makeManaged("t1", {
      scrollbackRestoreState: "done",
      isAttaching: true,
    });
    let settled = false;
    const promise = service.waitForFullySettled("t1").then(() => {
      settled = true;
    });
    await Promise.resolve();

    // Restore notification arrives while still attaching — must not settle.
    service.notifyRestoreSettledWaiters("t1");
    await Promise.resolve();
    expect(settled).toBe(false);

    // Attach completes — the attach notifier must also drain fully-settled.
    managed.isAttaching = false;
    service.notifyAttachSettledWaiters("t1");
    await promise;
    expect(settled).toBe(true);
  });

  it("settles when restore transitions to 'done' and is notified", async () => {
    const managed = makeManaged("t1", { scrollbackRestoreState: "in-progress" });
    let settled = false;
    const promise = service.waitForFullySettled("t1").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    managed.scrollbackRestoreState = "done";
    service.notifyRestoreSettledWaiters("t1");
    await promise;
    expect(settled).toBe(true);
  });

  it("settles (does not hang) when restore fails — caller inspects the error", async () => {
    const managed = makeManaged("t1", { scrollbackRestoreState: "in-progress" });
    const promise = service.waitForFullySettled("t1");
    await Promise.resolve();

    // Failure path: scheduler resets state to "none" and stashes the error.
    managed.scrollbackRestoreState = "none";
    (managed as { lastScrollbackRestoreError: unknown }).lastScrollbackRestoreError = {
      type: "error",
      message: "replay failed",
      timestamp: 123,
    };
    service.notifyRestoreSettledWaiters("t1");

    await expect(promise).resolves.toBeUndefined();
    expect(managed.lastScrollbackRestoreError).toBeDefined();
  });

  it("never settles a terminal that is not visually attached", async () => {
    makeManaged("t1", { scrollbackRestoreState: "done", isOpened: false });
    await expect(service.waitForFullySettled("t1", { timeoutMs: 30 })).rejects.toThrow(
      /fully-settle timeout/
    );
  });

  it("rejects with the restore state in the timeout message", async () => {
    makeManaged("t1", { scrollbackRestoreState: "in-progress" });
    await expect(service.waitForFullySettled("t1", { timeoutMs: 30 })).rejects.toThrow(
      /in-progress/
    );
  });

  it("rejects waiters when the terminal is destroyed before settling", async () => {
    makeManaged("t1", { scrollbackRestoreState: "in-progress" });
    stubDestroyCollaborators();
    const promise = service.waitForFullySettled("t1");
    await Promise.resolve();
    service.destroy("t1");
    await expect(promise).rejects.toThrow(/destroyed before fully settled/);
  });

  describe("waitForAllFullySettled (batch)", () => {
    it("resolves immediately for an empty batch", async () => {
      await expect(service.waitForAllFullySettled([])).resolves.toBeUndefined();
    });

    it("resolves once every panel has settled", async () => {
      const a = makeManaged("a", { scrollbackRestoreState: "in-progress" });
      const b = makeManaged("b", { scrollbackRestoreState: "in-progress" });
      let settled = false;
      const promise = service.waitForAllFullySettled(["a", "b"]).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      a.scrollbackRestoreState = "done";
      service.notifyRestoreSettledWaiters("a");
      await Promise.resolve();
      expect(settled).toBe(false);

      b.scrollbackRestoreState = "done";
      service.notifyRestoreSettledWaiters("b");
      await promise;
      expect(settled).toBe(true);
    });

    it("dedupes repeated ids", async () => {
      makeManaged("a", { scrollbackRestoreState: "done" });
      await expect(service.waitForAllFullySettled(["a", "a", "a"])).resolves.toBeUndefined();
    });

    it("rejects naming the still-pending panels on timeout", async () => {
      makeManaged("settled-1", { scrollbackRestoreState: "done" });
      makeManaged("stuck-inprogress", { scrollbackRestoreState: "in-progress" });
      makeManaged("stuck-pending", { scrollbackRestoreState: "pending" });
      const error = await service
        .waitForAllFullySettled(["settled-1", "stuck-inprogress", "stuck-pending"], {
          timeoutMs: 30,
        })
        .then(
          () => null,
          (e: Error) => e
        );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/not fully settled/);
      // The named pending set lives after the colon; assert against that slice
      // so substrings of the fixed prefix can't produce false matches.
      const pendingList = error!.message.split(":")[1] ?? "";
      expect(pendingList).toContain("stuck-inprogress");
      expect(pendingList).toContain("stuck-pending");
      expect(pendingList).not.toContain("settled-1");
    });

    it("leaves no ghost waiters after a batch timeout", async () => {
      makeManaged("p1", { scrollbackRestoreState: "in-progress" });
      const managed = makeManaged("p2", { scrollbackRestoreState: "in-progress" });
      await expect(service.waitForAllFullySettled(["p1", "p2"], { timeoutMs: 20 })).rejects.toThrow(
        /not fully settled/
      );

      // The shared timeout must have detached every per-panel waiter.
      expect(service.fullySettledWaiters.has("p1")).toBe(false);
      expect(service.fullySettledWaiters.has("p2")).toBe(false);

      // A late notify on a now-detached panel is a harmless no-op.
      managed.scrollbackRestoreState = "done";
      expect(() => service.notifyRestoreSettledWaiters("p2")).not.toThrow();
    });

    it("fails the whole batch when a panel is destroyed mid-wait", async () => {
      makeManaged("a", { scrollbackRestoreState: "in-progress" });
      makeManaged("b", { scrollbackRestoreState: "in-progress" });
      stubDestroyCollaborators();
      const promise = service.waitForAllFullySettled(["a", "b"]);
      await Promise.resolve();
      service.destroy("a");
      await expect(promise).rejects.toThrow(/destroyed before fully settled/);
    });
  });
});
