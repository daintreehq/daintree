import { describe, expect, it, vi } from "vitest";
import type { RemoteHostManager } from "../RemoteHostManager.js";
import { RemoteRouterImpl } from "../RemoteRouter.js";
import { WindowHostBinding } from "../WindowHostBinding.js";

function harness() {
  const keys = new Map<number, string>();
  const windows = new Map<number, number>();
  const invoke = vi.fn(async () => ({ ok: true as const, data: null }));
  let connected = true;
  const manager = {
    get: () => (connected ? { invoke, send: vi.fn() } : undefined),
  } as unknown as RemoteHostManager;
  const bindings = new WindowHostBinding();
  const gone = new Map<number, () => void>();
  const router = new RemoteRouterImpl(manager, bindings, {
    projectKeyFor: (id) => keys.get(id) ?? null,
    windowIdFor: (id) => windows.get(id) ?? null,
    onGone: (id, callback) => {
      expect(gone.has(id)).toBe(false);
      gone.set(id, callback);
    },
  });
  return {
    router,
    keys,
    windows,
    bindings,
    invoke,
    destroy: (id: number) => gone.get(id)?.(),
    disconnect: () => {
      connected = false;
    },
  };
}

describe("RemoteRouterImpl after a view is unregistered (#13285)", () => {
  it("keeps a closing host view on its host, with its project, once the lookups forget it", async () => {
    const h = harness();
    h.keys.set(7, "studio-01:proj");
    h.windows.set(7, 1);
    expect(h.router.hostForSender(7)).toBe("studio-01");

    // Teardown unregisters the view and its window before closing it.
    h.keys.delete(7);
    h.windows.delete(7);
    expect(h.router.hostForSender(7)).toBe("studio-01");
    await h.router.forwardInvoke("studio-01", 7, "project:save-layout", []);
    expect(h.invoke).toHaveBeenCalledWith(7, "proj", "project:save-layout", []);
  });

  it("keeps an evicted host view on its host while its window shows a local project", () => {
    const h = harness();
    h.keys.set(7, "studio-01:proj");
    h.windows.set(7, 1);
    h.router.hostForSender(7);

    h.keys.delete(7);
    // The window stays, now bound to this machine.
    expect(h.router.hostForSender(7)).toBe("studio-01");
  });

  it("keeps an evicted local view local while its window is on a host", () => {
    const h = harness();
    h.keys.set(8, "proj");
    h.windows.set(8, 2);
    expect(h.router.hostForSender(8)).toBeNull();

    h.keys.delete(8);
    h.bindings.set(2, "studio-01");
    expect(h.router.hostForSender(8)).toBeNull();
  });

  it("fails a forgotten host view's call as disconnected once the host is gone", async () => {
    const h = harness();
    h.keys.set(7, "studio-01:proj");
    h.router.hostForSender(7);
    h.keys.delete(7);
    h.disconnect();

    const hostId = h.router.hostForSender(7);
    expect(hostId).toBe("studio-01");
    const envelope = await h.router.forwardInvoke(hostId!, 7, "project:save-layout", []);
    expect(envelope).toMatchObject({ ok: false, error: { code: "HOST_DISCONNECTED" } });
  });

  it("lets a project picker follow its window while the window is open", () => {
    const h = harness();
    h.windows.set(9, 3);
    h.bindings.set(3, "studio-01");
    expect(h.router.hostForSender(9)).toBe("studio-01");

    h.bindings.set(3, "local");
    expect(h.router.hostForSender(9)).toBeNull();

    h.bindings.set(3, "studio-01");
    h.router.hostForSender(9);
    h.windows.delete(9);
    expect(h.router.hostForSender(9)).toBe("studio-01");
  });

  it("forgets a view's route only once its WebContents is destroyed", () => {
    const h = harness();
    for (let id = 1; id <= 2_000; id++) {
      h.keys.set(id, "studio-01:proj");
      h.router.hostForSender(id);
    }
    h.keys.clear();
    // However many views came after it, a closing view keeps its route.
    expect(h.router.hostForSender(1)).toBe("studio-01");

    h.destroy(1);
    expect(h.router.hostForSender(1)).toBeNull();
  });
});
