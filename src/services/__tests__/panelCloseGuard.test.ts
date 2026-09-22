import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import {
  __resetPanelCloseGuardsForTests,
  consultPanelCloseGuards,
  hasPanelCloseGuard,
  registerPanelCloseGuard,
} from "../panelCloseGuard";

describe("panelCloseGuard (#12323)", () => {
  beforeEach(() => {
    __resetPanelCloseGuardsForTests();
  });

  it("lets an unguarded close through without asking anyone", async () => {
    expect(hasPanelCloseGuard("p1")).toBe(false);
    await expect(consultPanelCloseGuards(["p1", "p2"])).resolves.toBe(true);
  });

  it("registers per panel and the unregister only removes its own guard", () => {
    const first = registerPanelCloseGuard("p1", async () => "proceed");
    const second = registerPanelCloseGuard("p1", async () => "cancel");
    first();
    expect(hasPanelCloseGuard("p1")).toBe(true);
    second();
    expect(hasPanelCloseGuard("p1")).toBe(false);
  });

  it("stops at the first cancel and never asks the panels after it", async () => {
    const asked: string[] = [];
    registerPanelCloseGuard("a", async () => {
      asked.push("a");
      return "cancel";
    });
    registerPanelCloseGuard("b", async () => {
      asked.push("b");
      return "proceed";
    });
    await expect(consultPanelCloseGuards(["a", "b"])).resolves.toBe(false);
    expect(asked).toEqual(["a"]);
  });

  it("proceeds when every guard agrees", async () => {
    registerPanelCloseGuard("a", async () => "proceed");
    registerPanelCloseGuard("b", async () => "proceed");
    await expect(consultPanelCloseGuards(["a", "b", "c"])).resolves.toBe(true);
  });

  it("treats a throwing guard as a cancel — losing work is the failure to avoid", async () => {
    registerPanelCloseGuard("a", async () => {
      throw new Error("dialog host unmounted");
    });
    await expect(consultPanelCloseGuards(["a"])).resolves.toBe(false);
  });

  it("asks once for a close that fires twice while the prompt is open", async () => {
    let resolveGuard: ((verdict: "proceed" | "cancel") => void) | null = null;
    const guard = vi.fn(
      () =>
        new Promise<"proceed" | "cancel">((resolve) => {
          resolveGuard = resolve;
        })
    );
    registerPanelCloseGuard("a", guard);
    const first = consultPanelCloseGuards(["a"]);
    const second = consultPanelCloseGuards(["a"]);
    // The guard runs on a microtask; both consults share that one prompt.
    await Promise.resolve();
    expect(guard).toHaveBeenCalledTimes(1);
    resolveGuard!("proceed");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    // A later close asks again — the shared verdict is per prompt, not forever.
    resolveGuard = null;
    const third = consultPanelCloseGuards(["a"]);
    await Promise.resolve();
    expect(guard).toHaveBeenCalledTimes(2);
    resolveGuard!("cancel");
    await expect(third).resolves.toBe(false);
  });
});
