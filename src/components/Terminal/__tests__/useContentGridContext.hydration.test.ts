import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const HOOK_PATH = resolve(__dirname, "../useContentGridContext.tsx");

// Issue #10827 — the empty-state grid measured against the default 350px
// sidebar on first load (before the persisted width restored), then snapped to
// the correct width. The ResizeObserver effect now gates every measurement on
// the combined `isSidebarMeasurementLocked()` (transition lock OR one-shot
// startup hydration lock) and remeasures once hydration completes, mirroring
// the existing transition-unlock resync.
describe("useContentGridContext hydration lock gating (issue #10827)", () => {
  it("imports the combined measurement lock and the hydration unlock subscription", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("isSidebarMeasurementLocked");
    expect(content).toContain("subscribeSidebarHydrationUnlock");
    expect(content).toContain("subscribeSidebarLayoutTransitionUnlock");
    expect(content).toContain("@/lib/layoutTransitionLock");
    // The bare transition-only query must not linger — measurement sites gate
    // on the combined lock so the hydration half can't be bypassed.
    expect(content).not.toContain("isSidebarLayoutTransitionLocked");
  });

  it("guards the ResizeObserver callback on the combined measurement lock", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("if (isSidebarMeasurementLocked()) return;");
  });

  it("skips the initial synchronous measurement while measurement is locked", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("if (!isSidebarMeasurementLocked())");
  });

  it("subscribes to both transition and hydration unlock for the deferred remeasure", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("subscribeSidebarLayoutTransitionUnlock(remeasureAfterUnlock)");
    expect(content).toContain("subscribeSidebarHydrationUnlock(remeasureAfterUnlock)");
  });

  it("unsubscribes both lock subscriptions on cleanup", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("unsubscribeTransition()");
    expect(content).toContain("unsubscribeHydration()");
  });
});
