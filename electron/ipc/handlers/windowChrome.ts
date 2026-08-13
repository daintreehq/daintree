import { z } from "zod";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { WINDOW_CHROME_METHOD_CHANNELS } from "./windowChrome.preload.js";
import { setTitleBarOverlayBannerSeverity } from "../../window/titleBarOverlay.js";
import { isCachedViewWebContents } from "../../window/webContentsRegistry.js";
import { BANNER_SEVERITIES } from "../../../shared/config/windowChrome.js";

/**
 * Renderer → main report of which global banner currently occupies the top
 * band, so the native Windows caption strip can be tinted to match it (#11766).
 *
 * Scoped to the sender's own window: a report can only recolour the chrome of
 * the window it came from, never a sibling's.
 *
 * Reports from cached project views are dropped. A window can hold several
 * WebContentsViews at once and only one is on screen; the others stay mounted
 * with their own store instances, and the banner states are project-scoped
 * (`useCloudSyncBannerStore` in particular), so an off-screen view raising or
 * clearing its own banner would otherwise recolour the chrome of the project
 * the user is actually looking at.
 */
const bannerSeveritySchema = z.object({
  severity: z.enum(BANNER_SEVERITIES).nullable(),
});

export const windowChromeNamespace = defineIpcNamespace({
  name: "windowChrome",
  ops: {
    setBannerSeverity: opValidated(
      WINDOW_CHROME_METHOD_CHANNELS.setBannerSeverity,
      bannerSeveritySchema,
      async (ctx: IpcContext, payload: z.infer<typeof bannerSeveritySchema>) => {
        const win = ctx.senderWindow;
        if (!win || win.isDestroyed()) return;
        if (isCachedViewWebContents(ctx.webContentsId)) return;
        setTitleBarOverlayBannerSeverity(win, payload.severity);
      },
      { withContext: true }
    ),
  },
});

export function registerWindowChromeHandlers(_deps: HandlerDependencies): () => void {
  return windowChromeNamespace.register();
}
