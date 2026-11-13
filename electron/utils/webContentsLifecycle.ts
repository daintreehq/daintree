/**
 * webContentsLifecycle: Shared CDP helpers for per-renderer freeze, memory
 * collection, and clearing CPU emulation.
 *
 * Wraps `Page.setWebLifecycleState`, the `HeapProfiler` GC sequence and the
 * heap-usage read so callers do not need to know about `debugger.attach`,
 * `Page.enable`, or expected CDP errors during teardown and navigation races.
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

/**
 * The teardown/navigation vocabulary. A CDP call failing with one of these lost
 * a race with the guest going away; anything else is worth a warning. Shared so
 * every CDP caller in main answers "was that expected?" the same way.
 */
export const EXPECTED_CDP_ERRORS = [
  "Target closed",
  "Inspected target navigated",
  "Cannot attach",
  "debugger is already attached",
  "No debugger attached",
];

export function isExpectedCdpError(err: unknown): boolean {
  const message = formatErrorMessage(err, "");
  return EXPECTED_CDP_ERRORS.some((expected) => message.includes(expected));
}

export function ensureAttached(wc: Electron.WebContents): void {
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach("1.3");
  }
}

/**
 * What main knows about each renderer's CDP lifecycle state, for
 * {@link isWebContentsFrozen}. Commands on one debugger session are applied in
 * the order they are sent, whatever order their answers come back in, so a
 * page is frozen when the latest freeze sent outranks the latest thaw that
 * succeeded. A freeze counts from the moment it is asked for, since a push sent
 * before its command lands in the freeze anyway, and one that fails after its
 * command went out still counts, since it may have landed (Chromium also keeps
 * a page's frozen state on its host across a reload). Erring toward frozen
 * costs a skipped periodic push, and every activation thaws.
 */
interface LifecycleTrack {
  /** Freezes asked for that haven't yet sent their command, nor failed to. */
  freezesInFlight: number;
  /** Send order of the latest freeze command that went out; 0 for none. */
  lastFreezeSent: number;
  /** Send order of the latest thaw command that succeeded; 0 for none. */
  lastThawApplied: number;
}

const lifecycleTracks = new WeakMap<Electron.WebContents, LifecycleTrack>();
let lifecycleSendOrder = 0;

type LifecycleResult = { sent: false } | { sent: true; order: number; applied: boolean };

async function setLifecycleState(
  wc: Electron.WebContents,
  state: "frozen" | "active",
  onSend?: (order: number) => void
): Promise<LifecycleResult> {
  if (wc.isDestroyed()) return { sent: false };
  let order = 0;
  try {
    ensureAttached(wc);
    await wc.debugger.sendCommand("Page.enable");
    order = ++lifecycleSendOrder;
    onSend?.(order);
    await wc.debugger.sendCommand("Page.setWebLifecycleState", { state });
    return { sent: true, order, applied: true };
  } catch (err) {
    const message = formatErrorMessage(err, "CDP lifecycle state failed");
    if (!EXPECTED_CDP_ERRORS.some((s) => message.includes(s))) {
      console.warn(`[webContentsLifecycle] setWebLifecycleState(${state}) failed:`, message);
    }
    return order === 0 ? { sent: false } : { sent: true, order, applied: false };
  }
}

export async function freezeWebContents(wc: Electron.WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  const track = lifecycleTracks.get(wc) ?? {
    freezesInFlight: 0,
    lastFreezeSent: 0,
    lastThawApplied: 0,
  };
  lifecycleTracks.set(wc, track);
  track.freezesInFlight++;
  // Settled the moment the command goes out, not when it is answered, so a
  // later thaw that succeeds still outranks a freeze whose answer never comes.
  const result = await setLifecycleState(wc, "frozen", (order) => {
    track.freezesInFlight--;
    track.lastFreezeSent = Math.max(track.lastFreezeSent, order);
  });
  if (!result.sent) track.freezesInFlight--;
}

export async function unfreezeWebContents(wc: Electron.WebContents): Promise<void> {
  const result = await setLifecycleState(wc, "active");
  const track = lifecycleTracks.get(wc);
  if (!track || !result.sent || !result.applied) return;
  track.lastThawApplied = Math.max(track.lastThawApplied, result.order);
}

/**
 * Whether this renderer may be frozen: a freeze is in flight, or the latest
 * one sent has no successful thaw sent after it. A push to a frozen renderer
 * either wakes JS in a page frozen to stay idle or schedules work that all
 * fires at once on thaw, inside the warm paint gate, so periodic work that can
 * simply skip a frozen view should (#16810).
 */
export function isWebContentsFrozen(wc: Electron.WebContents): boolean {
  const track = lifecycleTracks.get(wc);
  if (!track) return false;
  return track.freezesInFlight > 0 || track.lastFreezeSent > track.lastThawApplied;
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
 * even when the renderer is frozen — the renderer-side `gc()` idle
 * callback cannot make that guarantee). Target-scoped, but activation only
 * clears the *next* timer, so a sequence already in flight can reach a view
 * that just went active: `shouldCollect` is re-checked after the enable round
 * trip, immediately before the collection, so a caller can abandon it there.
 * Resolves true only when a collection was actually issued.
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
export async function purgeMemoryWebContents(
  wc: Electron.WebContents,
  opts: { shouldCollect?: () => boolean } = {}
): Promise<boolean> {
  if (getIsE2EDisableCachedViewCpuThrottle()) return false;
  if (wc.isDestroyed()) return false;
  let enabled = false;
  try {
    ensureAttached(wc);
    await wc.debugger.sendCommand("HeapProfiler.enable");
    enabled = true;
    if (opts.shouldCollect?.() === false) return false;
    await wc.debugger.sendCommand("HeapProfiler.collectGarbage");
    return true;
  } catch (err) {
    warnUnexpectedCdpError("purgeMemoryWebContents", err);
    return false;
  } finally {
    if (enabled) {
      try {
        await wc.debugger.sendCommand("HeapProfiler.disable");
      } catch (err) {
        warnUnexpectedCdpError("purgeMemoryWebContents", err);
      }
    }
  }
}

/**
 * Used bytes of the renderer's V8 heap (the whole isolate), via CDP. Null when
 * unreadable: destroyed, CDP unavailable, or the Windows-CI e2e opt-out shared
 * with `purgeMemoryWebContents`.
 */
export async function readJsHeapUsedBytes(wc: Electron.WebContents): Promise<number | null> {
  if (getIsE2EDisableCachedViewCpuThrottle()) return null;
  if (wc.isDestroyed()) return null;
  try {
    ensureAttached(wc);
    const usage = (await wc.debugger.sendCommand("Runtime.getHeapUsage")) as
      { usedSize?: unknown } | undefined;
    const used = usage?.usedSize;
    return typeof used === "number" && Number.isFinite(used) ? used : null;
  } catch (err) {
    warnUnexpectedCdpError("readJsHeapUsedBytes", err);
    return null;
  }
}

function warnUnexpectedCdpError(operation: string, err: unknown): void {
  const message = formatErrorMessage(err, `CDP ${operation} failed`);
  if (EXPECTED_CDP_ERRORS.some((s) => message.includes(s))) return;
  console.warn(`[webContentsLifecycle] ${operation} failed:`, message);
}
