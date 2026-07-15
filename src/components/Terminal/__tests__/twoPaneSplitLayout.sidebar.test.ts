import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const LAYOUT_PATH = resolve(__dirname, "../TwoPaneSplitLayout.tsx");

// Issue #7825 — TwoPaneSplitLayout was the third consumer of the `<main>`
// reflow signal that produces sidebar-toggle jitter. The fix mirrors the
// gate-and-resync pattern already used by `useContentGridContext` and
// `useGridNavigation` against `layoutTransitionLock`.
describe("TwoPaneSplitLayout sidebar lock gating (issue #7825)", () => {
  it("imports the sidebar measurement lock helpers", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    // #10827 promoted the guards to the combined measurement lock so both the
    // transition lock and the startup hydration lock gate measurement.
    expect(content).toContain("isSidebarMeasurementLocked");
    expect(content).toContain("subscribeSidebarLayoutTransitionUnlock");
    expect(content).toContain("@/lib/layoutTransitionLock");
  });

  it("does not use useResizeObserverRaf for the container width", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).not.toContain("useResizeObserverRaf");
    expect(content).not.toContain("setContainerEl");
  });

  it("creates a manual ResizeObserver guarded by the measurement lock", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("new ResizeObserver");
    const lockGuardIndex = content.indexOf("if (isSidebarMeasurementLocked()) return;");
    const setterIndex = content.indexOf("setContainerWidth(");
    expect(lockGuardIndex).toBeGreaterThan(-1);
    expect(setterIndex).toBeGreaterThan(-1);
    expect(lockGuardIndex).toBeLessThan(setterIndex);
  });

  it("skips the initial measurement when the measurement lock is active", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("if (!isSidebarMeasurementLocked())");
  });

  it("resyncs the container width on sidebar transition unlock with a drag guard", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("subscribeSidebarLayoutTransitionUnlock(");
    expect(content).toContain("isDraggingDividerRef");
    expect(content).toContain("isDraggingDividerRef.current");
  });

  it("defers the resync until drag end when the unlock fires mid-drag", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("pendingResyncAfterDragRef");
    expect(content).toContain("pendingResyncAfterDragRef.current = true");
    expect(content).toContain("pendingResyncAfterDragRef.current = false");
  });

  it("cancels pending animation frames and unsubscribes both locks on cleanup", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("observer.disconnect()");
    expect(content).toContain("cancelAnimationFrame(rafId)");
    expect(content).toContain("cancelAnimationFrame(finalRafId)");
    expect(content).toContain("unsubscribeTransition()");
    expect(content).toContain("unsubscribeHydration()");
  });
});

// Issue #10827 — on first load the right pane measured against the default
// 350px sidebar before the persisted width restored, then snapped. The same
// gate-and-resync pattern now also covers the one-shot hydration lock.
describe("TwoPaneSplitLayout hydration lock gating (issue #10827)", () => {
  it("imports the hydration unlock subscription and combined lock", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("isSidebarMeasurementLocked");
    expect(content).toContain("subscribeSidebarHydrationUnlock");
    // The bare transition-only lock query must not linger — every measure site
    // gates on the combined lock so neither half can be bypassed.
    expect(content).not.toContain("isSidebarLayoutTransitionLocked");
  });

  it("subscribes to the hydration unlock to remeasure after the width restore", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("subscribeSidebarHydrationUnlock(");
  });
});

describe("TwoPaneSplitLayout coordinated terminal resize", () => {
  it("unlocks into one tracked final resize pass without calling raw fit", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");

    expect(content).not.toContain("terminalInstanceService.fit(");
    expect(content).toMatch(
      /dragLockedIdsRef\.current = \[\][\s\S]{0,220}lockResize\(id, false\)[\s\S]{0,180}runResizePass\(ids\)/
    );
  });

  it("re-arms gesture-owned locks and clears ownership before drag-end unlock", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");

    expect(content).toContain("dragLockedIdsRef");
    expect(content).toMatch(
      /const rearm = \(\) => \{[\s\S]{0,220}lockResize\(id, true\)[\s\S]{0,120}requestAnimationFrame\(rearm\)/
    );
    expect(content).toMatch(/dragLockedIdsRef\.current = \[\][\s\S]{0,220}lockResize\(id, false\)/);
  });

  it("registers non-drag layout work with the batch scheduler immediately", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");

    expect(content).toContain("terminalInstanceService.scheduleBatchResize(panelIds)");
  });

  it("unmount cleanup releases only gesture-owned terminal locks", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    const cleanupStart = content.indexOf("// Cleanup: unlock resize");
    const cleanupEnd = content.indexOf("const minRatio", cleanupStart);
    const cleanup = content.slice(cleanupStart, cleanupEnd);

    expect(cleanup).toContain("const lockedIds = dragLockedIdsRef.current");
    expect(cleanup).toMatch(/for \(const id of lockedIds\)[\s\S]*lockResize\(id, false\)/);
    expect(cleanup).not.toContain("terminalsRef.current.map");
  });
});
