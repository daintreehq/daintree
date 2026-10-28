import { createContext, useContext } from "react";

export type DialogLayer = "modal" | "nested";

/**
 * The tier the enclosing `AppDialog` actually painted at, after its dock
 * popover promotion. Overlays portal to the body at `--z-popover`, below a
 * nested dialog, so one opened inside a dialog at that tier lifts itself above
 * it (#14191). Null outside a dialog: an overlay in a dock popover stays put.
 */
export const DialogLayerContext = createContext<DialogLayer | null>(null);

/** Above `--z-nested-dialog`, still below toasts. */
export const NESTED_OVERLAY_Z_CLASS = "z-[calc(var(--z-nested-dialog)+1)]";

/** The z-index class an overlay's content needs in its enclosing dialog, if any. */
export function useDialogOverlayZClass(): string | undefined {
  return useContext(DialogLayerContext) === "nested" ? NESTED_OVERLAY_Z_CLASS : undefined;
}
