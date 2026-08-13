import { z } from "zod";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { WINDOW_CHROME_METHOD_CHANNELS } from "./windowChrome.preload.js";
import { setTitleBarOverlayBannerSeverity } from "../../window/titleBarOverlay.js";
import { BANNER_SEVERITIES } from "../../../shared/config/windowChrome.js";

/**
 * Renderer → main report of which global banner currently occupies the top
 * band, so the native Windows caption strip can be tinted to match it (#11766).
 *
 * Scoped to the sender's own window: a report can only recolour the chrome of
 * the window it came from, never a sibling's.
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
        setTitleBarOverlayBannerSeverity(win, payload.severity);
      },
      { withContext: true }
    ),
  },
});

export function registerWindowChromeHandlers(_deps: HandlerDependencies): () => void {
  return windowChromeNamespace.register();
}
