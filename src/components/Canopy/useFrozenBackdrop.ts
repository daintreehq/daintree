import { useEffect, useState } from "react";
import { UI_EXIT_DURATION } from "@/lib/animationUtils";
import { logWarn } from "@/utils/logger";

/**
 * A still of the app as it stood when the panel opened, to hold behind it.
 *
 * The panel streams a terminal at its own size, and that terminal's pane in the
 * grid behind is frozen meanwhile — its output drawn for the panel's grid would
 * otherwise reflow there in plain view. The still keeps everything behind the
 * panel where it was. It is taken as the panel opens, before the panel resizes
 * any terminal, and the scrim fades in over it.
 *
 * Dropped, for the live app, if the window resizes while open: a still at the
 * old size would no longer line up. Kept through the close's fade, then let go.
 */
export function useFrozenBackdrop(open: boolean): string | null {
  const [still, setStill] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let url: string | null = null;
    window.electron.canopy.captureBackdrop().then(
      (bytes) => {
        if (disposed || bytes === null) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
        setStill(url);
      },
      (error: unknown) => logWarn("[Canopy] couldn't freeze the app behind the panel", { error })
    );
    const onResize = () => setStill(null);
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      const taken = url;
      if (taken === null) return;
      setTimeout(() => {
        setStill((current) => (current === taken ? null : current));
        URL.revokeObjectURL(taken);
      }, UI_EXIT_DURATION);
    };
  }, [open]);

  return still;
}
