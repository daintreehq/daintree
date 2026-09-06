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
  touchEmulated: boolean;
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

async function handleSetDeviceEmulation(payload: DeviceEmulationRequest): Promise<void> {
  const { webContentsId, panelId, emulation } = payload;

  // Ownership gate: only the panel that registered this guest may drive it.
  if (getWebviewDialogService().getPanelId(webContentsId) !== panelId) return;

  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    guestEmulation.delete(webContentsId);
    return;
  }

  let state = guestEmulation.get(webContentsId);
  if (!state) {
    state = { originalUserAgent: wc.getUserAgent(), touchEmulated: false };
    guestEmulation.set(webContentsId, state);
    wc.once("destroyed", () => guestEmulation.delete(webContentsId));
  }

  if (emulation) {
    wc.setUserAgent(emulation.userAgent);
    wc.enableDeviceEmulation(emulation.params as Electron.Parameters);
    if (emulation.touch !== state.touchEmulated) {
      const applied = await setTouchEmulation(wc, emulation.touch);
      if (applied) state.touchEmulated = emulation.touch;
    }
    return;
  }

  try {
    wc.disableDeviceEmulation();
  } catch {
    // Throws when emulation was never enabled for this guest.
  }
  if (state.originalUserAgent) {
    wc.setUserAgent(state.originalUserAgent);
  }
  if (state.touchEmulated) {
    const applied = await setTouchEmulation(wc, false);
    if (applied) state.touchEmulated = false;
  }
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
