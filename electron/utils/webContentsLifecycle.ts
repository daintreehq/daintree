/**
 * webContentsLifecycle: Shared CDP helpers for per-renderer freeze, memory
 * collection, and clearing CPU emulation.
 *
 * Wraps `Page.setWebLifecycleState` and the `HeapProfiler` GC sequence so
 * callers do not need to know about `debugger.attach`, `Page.enable`, or
 * expected CDP errors during teardown and navigation races.
 *
 * Why CDP instead of `WebContents.setBackgroundThrottling`: since Electron 28,
 * `setBackgroundThrottling(false)` on any view in a BrowserWindow disables timer
 * throttling for all sibling WebContents in that window. With one always-active
 * view per window, that makes cached-view `setBackgroundThrottling(true)` ineffective
 * (#8599).
 *
 * Do not reintroduce `Emulation.setCPUThrottlingRate` above 1 as a resource
 * saver. It is DevTools' slow-device simulation: Chromium's POSIX
 * `ThreadCPUThrottler` signals the renderer main thread and busy-waits in the
 * signal handler, so a "throttled" renderer burns 25-40% of a core for as long
 * as the rate stays up, frozen or not (#12456).
 *
 * Frozen renderers do not auto-resume on focus or reattach. Callers activating a
 * frozen view must call `unfreezeWebContents` before relying on its event loop.
 *
 * Do not verify freeze with Playwright. It unconditionally enables focus emulation
 * on every page target and forces the renderer visible, so a
 * `Page.setWebLifecycleState` freeze reports success without freezing. A second CDP
 * session cannot release Playwright's per-session capture. Use
 * `npm run test:freeze-harness`. See the `test:freeze-harness` section in
 * `docs/e2e-testing.md` (#11846).
 *
 * Audit: `electron/main.ts` and `electron/setup/environment.ts` have no `appendSwitch`
 * calls for `disable-renderer-backgrounding` or `disable-background-timer-throttling`.
 * Do not add either. The former removes cached-renderer OS priority demotion and the
 * latter removes hidden-page timer throttling, raising idle CPU. Neither disables CDP
 * freeze.
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

export function freezeWebContents(wc: Electron.WebContents): Promise<void> {
  return setLifecycleState(wc, "frozen");
}

export function unfreezeWebContents(wc: Electron.WebContents): Promise<void> {
  return setLifecycleState(wc, "active");
}

/**
 * Put CPU emulation back to rate 1 on a renderer that already has a debugger
 * session. Nothing in the app raises the rate any more, so this is defensive
 * cleanup for a session left at some other rate; rate 1 tears Chromium's
 * throttling thread down entirely. Never attaches: a renderer with no session
 * has no emulation to clear, and attaching just to say so is pure cost.
 */
export async function unthrottleCpuWebContents(wc: Electron.WebContents): Promise<void> {
  if (getIsE2EDisableCachedViewCpuThrottle()) return;
  if (wc.isDestroyed()) return;
  try {
    if (!wc.debugger.isAttached()) return;
    // Emulation domain does not require an `enable` call.
    await wc.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate: 1 });
  } catch (err) {
    const message = formatErrorMessage(err, "CDP CPU throttle reset failed");
    if (EXPECTED_CDP_ERRORS.some((s) => message.includes(s))) return;
    console.warn("[webContentsLifecycle] setCPUThrottlingRate(1) failed:", message);
  }
}

/**
 * Collect a cached renderer's JavaScript garbage, main-side over CDP (works
 * even when the renderer is frozen — the renderer-side `window.gc()` idle
 * callback cannot make that guarantee). Target-scoped, but not an
 * active-view guarantee: activation only clears the *next* timer, so a
 * sequence already in flight can land on a view that just went active.
 *
 * Do NOT re-add `Memory.simulatePressureNotification`. Despite riding a page
 * target's debugger session it never reached this renderer: on Chromium 148
 * it raises pressure in the browser process, which forwards it off-Android
 * only to the GPU and network processes, and the GPU path purges the shared
 * Ganesh context every view rasterises its DOM text through. So it never
 * bought the Blink font/image cache drop #10981 added it for, and on a 60 s
 * per-cached-view timer it is the leading — not trace-confirmed — suspect
 * for the wrong-glyph file-tree text after a warm switch back.
 *
 * Do NOT add `Memory.forciblyPurgeJavaScriptMemory` either: it reproducibly
 * SIGSEGVs a CPU-throttled hidden WebContentsView on Electron 42/Chromium
 * 148 (exit code 11 ~instantly; isolated in an A/B probe while cached views
 * still ran at rate 4). Shares the Windows-CI e2e opt-out with the CPU rate
 * reset: both ride the same debugger session Playwright owns there, which is
 * why the flag keeps its historical throttle-flavoured name.
 */
export async function purgeMemoryWebContents(wc: Electron.WebContents): Promise<void> {
  if (getIsE2EDisableCachedViewCpuThrottle()) return;
  if (wc.isDestroyed()) return;
  try {
    ensureAttached(wc);
    await wc.debugger.sendCommand("HeapProfiler.enable");
    await wc.debugger.sendCommand("HeapProfiler.collectGarbage");
    await wc.debugger.sendCommand("HeapProfiler.disable");
  } catch (err) {
    const message = formatErrorMessage(err, "CDP memory purge failed");
    if (EXPECTED_CDP_ERRORS.some((s) => message.includes(s))) return;
    console.warn("[webContentsLifecycle] purgeMemoryWebContents failed:", message);
  }
}
