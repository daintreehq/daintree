import { webContents } from "electron";
import { defineIpcNamespace, opValidated } from "../define.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { WEBVIEW_EMULATION_METHOD_CHANNELS } from "./webviewEmulation.preload.js";
import { WebviewSetDeviceEmulationPayloadSchema } from "../../schemas/ipc.js";
import { ensureAttached } from "../../utils/webContentsLifecycle.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { HandlerDependencies } from "../types.js";
import type { DeviceEmulationRequest } from "../../../shared/types/ipc/webviewEmulation.js";

/**
 * Device emulation for dev-preview webview guests.
 *
 * This lives in the main process because `<webview>` has no renderer-side
 * `getWebContents()` — that was only ever an `@electron/remote` shim, and the
 * renderer-side call it replaced silently threw for every preset (#12298). The
 * renderer sends its guest id from `getWebContentsId()` and main resolves the
 * real WebContents, matching the `getScrollPosition` / `reloadIgnoringCache`
 * pattern in `webview.ts`.
 *
 * `enableDeviceEmulation` only drives viewport size, device scale factor and
 * meta-viewport handling. Pointer/hover media features and touch dispatch are
 * separate CDP `Emulation.*` commands, so a preset that stops at
 * `enableDeviceEmulation` still reports `(pointer: fine)` to the page.
 */

/**
 * Per-guest emulation bookkeeping. The guest's own user agent has to be read
 * before the first override, because Electron has no "reset to default" for
 * `setUserAgent` — restoring desktop means writing the captured string back.
 */
interface GuestEmulationState {
  originalUserAgent: string;
  /**
   * Whether touch is currently emulated, or `null` when we no longer know —
   * a partially-applied CDP sequence leaves the guest in a state this cache
   * cannot describe, and the next request must re-issue rather than skip.
   */
  touchEmulated: boolean | null;
  /**
   * Requests for one guest run one at a time. Without this, a desktop clear
   * still awaiting its CDP commands can finish after a newly-selected phone
   * preset and turn that preset's touch emulation back off.
   */
  queue: Promise<void>;
}

const guestEmulation = new Map<number, GuestEmulationState>();

// Emulation racing guest teardown or a navigation is routine; only unexpected
// failures deserve a log line.
const EXPECTED_CDP_ERRORS = [
  "Target closed",
  "Inspected target navigated",
  "Cannot attach",
  "debugger is already attached",
  "No debugger attached",
];

function isExpectedCdpError(message: string): boolean {
  return EXPECTED_CDP_ERRORS.some((expected) => message.includes(expected));
}

/**
 * Touch/pointer emulation over CDP, best-effort: a failure here degrades the
 * preset to "right size, desktop pointer" rather than aborting the whole apply,
 * which would leave the guest sized for a phone with no emulation at all.
 */
async function setTouchEmulation(wc: Electron.WebContents, enabled: boolean): Promise<boolean> {
  try {
    ensureAttached(wc);
    // Drives navigator.maxTouchPoints and Blink's available pointer/hover
    // types, which is what flips `(pointer: coarse)` for the page.
    await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
      enabled,
      maxTouchPoints: enabled ? 5 : 1,
    });
    await wc.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", {
      enabled,
      configuration: enabled ? "mobile" : "desktop",
    });
    // Belt and braces over setTouchEmulationEnabled: an explicit media-feature
    // override so the four pointer/hover queries answer consistently. An empty
    // feature list clears the override and returns the page to native values.
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: enabled
        ? [
            { name: "pointer", value: "coarse" },
            { name: "any-pointer", value: "coarse" },
            { name: "hover", value: "none" },
            { name: "any-hover", value: "none" },
          ]
        : [],
    });
    return true;
  } catch (err) {
    const message = formatErrorMessage(err, "CDP touch emulation failed");
    if (!isExpectedCdpError(message)) {
      console.warn(`[webviewEmulation] touch emulation (enabled=${enabled}) failed:`, message);
    }
    return false;
  }
}

/** Resolves false when the guest went away before this queued request ran. */
async function applyEmulation(
  wc: Electron.WebContents,
  state: GuestEmulationState,
  emulation: DeviceEmulationRequest["emulation"]
): Promise<boolean> {
  if (wc.isDestroyed()) return false;

  if (emulation) {
    wc.setUserAgent(emulation.userAgent);
    wc.enableDeviceEmulation(emulation.params as Electron.Parameters);
    if (emulation.touch !== state.touchEmulated) {
      // Mark unknown across the await: a failure part-way through leaves some
      // overrides set and others not, and claiming either value would let a
      // later request skip the cleanup the guest actually needs.
      state.touchEmulated = null;
      if (await setTouchEmulation(wc, emulation.touch)) state.touchEmulated = emulation.touch;
    }
    return true;
  }

  try {
    wc.disableDeviceEmulation();
  } catch {
    // Throws when emulation was never enabled for this guest.
  }
  if (state.originalUserAgent) {
    wc.setUserAgent(state.originalUserAgent);
  }
  if (state.touchEmulated !== false) {
    state.touchEmulated = null;
    if (await setTouchEmulation(wc, false)) state.touchEmulated = false;
  }
  return true;
}

/**
 * Apply or clear device emulation for one guest.
 *
 * Resolves `{ applied: false }` when nothing was done — an unregistered or
 * destroyed guest — so the renderer never caches a preset as active on a guest
 * that never received it.
 */
async function handleSetDeviceEmulation(
  payload: DeviceEmulationRequest
): Promise<{ applied: boolean }> {
  const { webContentsId, panelId, emulation } = payload;

  // Ownership gate: only the panel that registered this guest may drive it.
  if (getWebviewDialogService().getPanelId(webContentsId) !== panelId) {
    return { applied: false };
  }

  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    guestEmulation.delete(webContentsId);
    return { applied: false };
  }

  let state = guestEmulation.get(webContentsId);
  if (!state) {
    state = {
      originalUserAgent: wc.getUserAgent(),
      touchEmulated: false,
      queue: Promise.resolve(),
    };
    guestEmulation.set(webContentsId, state);
    if (typeof wc.once === "function") {
      wc.once("destroyed", () => guestEmulation.delete(webContentsId));
    }
  }

  const settled = state.queue.then(() => applyEmulation(wc, state, emulation));
  // Keep the chain alive after a rejection so one failed request cannot wedge
  // every later one for this guest.
  state.queue = settled.then(
    () => {},
    () => {}
  );
  // A request that waited behind another can find the guest gone by the time it
  // runs, and must say so rather than let the caller cache a preset that was
  // never applied.
  return { applied: await settled };
}

export const webviewEmulationNamespace = defineIpcNamespace({
  name: "webviewEmulation",
  ops: {
    setDeviceEmulation: opValidated(
      WEBVIEW_EMULATION_METHOD_CHANNELS.setDeviceEmulation,
      WebviewSetDeviceEmulationPayloadSchema,
      handleSetDeviceEmulation
    ),
  },
});

export function registerWebviewEmulationHandlers(_deps: HandlerDependencies): () => void {
  const dispose = webviewEmulationNamespace.register();
  return () => {
    dispose();
    guestEmulation.clear();
  };
}
