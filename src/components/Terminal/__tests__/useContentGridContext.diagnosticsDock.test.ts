import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const HOOK_PATH = resolve(__dirname, "../useContentGridContext.tsx");

// Issue #12264 — the diagnostics dock takes its height out of the same flex
// column as the panel grid, but a height-only reflow moves none of this
// effect's dependencies, and when it leaves `scrollRowHeight` untouched it
// schedules no terminal correction either. The grid now remeasures on the
// dock's committed geometry signal, through the same lock-guarded path the
// sidebar transition and startup hydration already use.
//
// The wiring lives inside the grid hook, whose dependency surface makes it
// unrenderable in isolation — the same reason the #10827 hydration coverage
// next door asserts on source. The signal's own behaviour (subscribe, notify,
// dispose, resize suppression) is covered for real in
// src/lib/__tests__/diagnosticsDockLayout.test.ts, and the publishing side in
// src/components/Diagnostics/__tests__/DiagnosticsDock.reflow.test.tsx.
describe("useContentGridContext diagnostics dock remeasure (issue #12264)", () => {
  it("imports the dock layout signal subscription", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("subscribeDiagnosticsDockLayoutChange");
    expect(content).toContain("@/lib/diagnosticsDockLayout");
  });

  it("reuses the lock-guarded remeasure rather than a second measurement path", async () => {
    // remeasureAfterUnlock re-checks isSidebarMeasurementLocked and reads
    // gridContainerRef.current, so the dock path inherits both the #6979 jitter
    // guard and the #10827 hydration gate for free.
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("subscribeDiagnosticsDockLayoutChange(remeasureAfterUnlock)");
  });

  it("unsubscribes the dock signal alongside the sidebar subscriptions", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("unsubscribeDock()");
    // All three disposals must live in the same cleanup as the observer, or a
    // remount leaks a listener that measures a detached container.
    const cleanupIndex = content.indexOf("observer.disconnect();");
    const dockDisposeIndex = content.indexOf("unsubscribeDock()");
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(dockDisposeIndex).toBeGreaterThan(cleanupIndex);
  });

  it("subscribes in the same effect that owns the ResizeObserver", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    const subscribeIndex = content.indexOf("subscribeDiagnosticsDockLayoutChange(");
    const observeIndex = content.indexOf("observer.observe(container)");
    const disposeIndex = content.indexOf("unsubscribeDock()");
    expect(observeIndex).toBeGreaterThan(-1);
    expect(subscribeIndex).toBeGreaterThan(observeIndex);
    expect(disposeIndex).toBeGreaterThan(subscribeIndex);
  });
});
