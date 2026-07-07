/**
 * webContentsLifecycle — Shared CDP helpers for per-renderer freeze and CPU throttle.
 *
 * Wraps `Page.setWebLifecycleState` and `Emulation.setCPUThrottlingRate` so callers
 * don't need to know about `debugger.attach`, `Page.enable`, or the swallow-list of
 * expected CDP errors that surface during teardown/navigation races.
 *
 * Why CDP instead of `WebContents.setBackgroundThrottling`: since Electron 28,
 * `setBackgroundThrottling(false)` on any view in a BrowserWindow disables timer
 * throttling for ALL sibling WebContents in that window. With one always-active
 * view per window, that silently un-throttled every cached sibling and made the
 * cached-view `setBackgroundThrottling(true)` ineffective (#8599).
 * `Emulation.setCPUThrottlingRate` is per-target — it slows the V8/Blink clock
 * for one renderer only while leaving the event loop, IPC, and MessagePort
 * dispatch running, so it is safe for cached views that still receive
 * worktree/workspace messages.
 *
 * Chromium 146 does NOT auto-resume a frozen renderer on focus or re-attach —
 * an explicit `"active"` call is required. Callers that activate a previously
 * deactivated view must call `unfreezeWebContents` before relying on the
 * renderer's event loop.
 *
 * Audit: electron/main.ts and electron/bootstrap.ts checked — no
 * `disable-renderer-backgrounding` or `disable-background-timer-throttling`
 * appendSwitch calls. If either is reintroduced, CDP freeze silently no-ops
 * (lesson #4683).
 */

import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { getIsE2EDisableCachedViewCpuThrottle } from "../setup/runtimeFlags.js";

const EXPECTED_CDP_ERRORS = [
  "Target closed",
  "Inspected target navigated",
  "Cannot attach",
  "debugger is already attached",
  "No debugger attached",
];

const CACHED_VIEW_CPU_THROTTLE_RATE = 4;
const ACTIVE_VIEW_CPU_THROTTLE_RATE = 1;

export function ensureAttached(wc: Electron.WebContents): void {
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach("1.3");
  }
}

async function setLifecycleState(
  wc: Electron.WebContents,
  state: "frozen" | "active"
): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    ensureAttached(wc);
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("Page.setWebLifecycleState", { state });
  } catch (err) {
    const message = formatErrorMessage(err, "CDP lifecycle state failed");
    if (EXPECTED_CDP_ERRORS.some((s) => message.includes(s))) return;
    console.warn(`[webContentsLifecycle] setWebLifecycleState(${state}) failed:`, message);
  }
}

async function setCpuThrottlingRate(wc: Electron.WebContents, rate: number): Promise<void> {
  if (getIsE2EDisableCachedViewCpuThrottle()) return;
  if (wc.isDestroyed()) return;
  try {
    ensureAttached(wc);
    // Emulation domain does not require an `enable` call.
    await wc.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate });
  } catch (err) {
    const message = formatErrorMessage(err, "CDP CPU throttle failed");
    if (EXPECTED_CDP_ERRORS.some((s) => message.includes(s))) return;
    console.warn(`[webContentsLifecycle] setCPUThrottlingRate(${rate}) failed:`, message);
  }
}

export function freezeWebContents(wc: Electron.WebContents): Promise<void> {
  return setLifecycleState(wc, "frozen");
}

export function unfreezeWebContents(wc: Electron.WebContents): Promise<void> {
  return setLifecycleState(wc, "active");
}

export function throttleCpuWebContents(wc: Electron.WebContents): Promise<void> {
  return setCpuThrottlingRate(wc, CACHED_VIEW_CPU_THROTTLE_RATE);
}

export function unthrottleCpuWebContents(wc: Electron.WebContents): Promise<void> {
  return setCpuThrottlingRate(wc, ACTIVE_VIEW_CPU_THROTTLE_RATE);
}

/**
 * Purge a cached renderer's reclaimable memory, main-side over CDP (works
 * even when the renderer is CPU-throttled — the renderer-side `window.gc()`
 * idle callback cannot make that guarantee). The critical pressure
 * notification is the same `NotifyMemoryPressure(CRITICAL)` Blink's own
 * MemoryPurgeManager fires after backgrounding/freeze: it drops Blink
 * discardable caches (fonts, decoded images, backing stores) and triggers a
 * V8 memory-pressure GC. `HeapProfiler.collectGarbage` (the DevTools
 * "collect garbage" button) then compacts and returns the freed pages.
 * Do NOT add `Memory.forciblyPurgeJavaScriptMemory`: it reproducibly
 * SIGSEGVs a CPU-throttled hidden WebContentsView on Electron 42/Chromium
 * 148 (exit code 11 ~instantly; isolated in an A/B probe — the pressure
 * notification alone is stable). Per-target, so the active view is
 * untouched. Shares the Windows-CI e2e opt-out with the CPU throttle: both
 * ride the same debugger session Playwright owns there.
 */
export async function purgeMemoryWebContents(wc: Electron.WebContents): Promise<void> {
  if (getIsE2EDisableCachedViewCpuThrottle()) return;
  if (wc.isDestroyed()) return;
  try {
    ensureAttached(wc);
    await wc.debugger.sendCommand("Memory.simulatePressureNotification", { level: "critical" });
    await wc.debugger.sendCommand("HeapProfiler.enable");
    await wc.debugger.sendCommand("HeapProfiler.collectGarbage");
    await wc.debugger.sendCommand("HeapProfiler.disable");
  } catch (err) {
    const message = formatErrorMessage(err, "CDP memory purge failed");
    if (EXPECTED_CDP_ERRORS.some((s) => message.includes(s))) return;
    console.warn("[webContentsLifecycle] purgeMemoryWebContents failed:", message);
  }
}
