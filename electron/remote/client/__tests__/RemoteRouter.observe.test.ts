import { describe, expect, it, vi } from "vitest";
import type { RemoteHostManager } from "../RemoteHostManager.js";
import {
  observeForwardedInvokes,
  RemoteRouterImpl,
  type ForwardedInvoke,
} from "../RemoteRouter.js";
import { WindowHostBinding } from "../WindowHostBinding.js";

describe("observeForwardedInvokes", () => {
  it("tells observers what the Shell forwarded and the host accepted, with the project from its own view key", async () => {
    let ok = false;
    const invoke = vi.fn(async () =>
      ok ? { ok: true, data: null } : { ok: false, error: { message: "refused" } }
    );
    const manager = { get: () => ({ invoke }) } as unknown as RemoteHostManager;
    const router = new RemoteRouterImpl(manager, new WindowHostBinding(), {
      projectKeyFor: (id) => (id === 9 ? "studio-01:proj" : null),
      windowIdFor: () => null,
    });
    const seen: ForwardedInvoke[] = [];
    const stop = observeForwardedInvokes((call) => seen.push(call));
    const broken = observeForwardedInvokes(() => {
      throw new Error("observer bug");
    });

    await router.forwardInvoke("studio-01", 9, "dev-preview:ensure", [{ panelId: "p" }]);
    expect(seen).toEqual([]);
    ok = true;
    await router.forwardInvoke("studio-01", 9, "dev-preview:ensure", [{ panelId: "p" }]);
    expect(seen).toEqual([
      {
        hostId: "studio-01",
        webContentsId: 9,
        hostProjectId: "proj",
        channel: "dev-preview:ensure",
        args: [{ panelId: "p" }],
      },
    ]);
    expect(invoke).toHaveBeenCalledWith(9, "proj", "dev-preview:ensure", [{ panelId: "p" }]);

    stop();
    broken();
    await router.forwardInvoke("studio-01", 9, "dev-preview:ensure", []);
    expect(seen).toHaveLength(1);
  });
});
