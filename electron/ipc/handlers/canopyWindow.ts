import { readCanopyMode } from "../../services/canopy/canopyMode.js";
import { AppError } from "../../utils/errorTypes.js";
import { focusCanopyWindow, openCanopyWindow } from "../../window/canopyWindow.js";
import { defineIpcNamespace, op } from "../define.js";
import { observeCanopySnapshots } from "./canopy.js";
import { CANOPY_WINDOW_METHOD_CHANNELS } from "./canopyWindow.preload.js";

/** Canopy stopped being on: the window has nothing it may show. */
function closeWhenCanopyIsOff(close: () => void): () => void {
  return observeCanopySnapshots((snapshot) => {
    if (snapshot.mode !== "on") close();
  });
}

export const canopyWindowNamespace = defineIpcNamespace({
  name: "canopyWindow",
  ops: {
    /** Open the one Canopy window, or bring it forward. Refused unless Canopy is on. */
    open: op(CANOPY_WINDOW_METHOD_CHANNELS.open, async (): Promise<void> => {
      if (readCanopyMode() !== "on") {
        throw new AppError({
          code: "UNSUPPORTED",
          message: "Canopy isn't on",
          userMessage: "Turn Canopy on before opening its window.",
        });
      }
      openCanopyWindow(closeWhenCanopyIsOff);
    }),
    /** Bring the Canopy window forward. False when there is none to bring. */
    focus: op(CANOPY_WINDOW_METHOD_CHANNELS.focus, async (): Promise<boolean> => {
      return focusCanopyWindow();
    }),
  },
});

export function registerCanopyWindowHandlers(): () => void {
  return canopyWindowNamespace.register();
}
