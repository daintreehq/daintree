import { createContext, useContext } from "react";

/**
 * The plugin instance whose view is rendering, provided by
 * `PluginViewContent`. Kit overlays portal out of the view's root, so without
 * it their content carries no owner and diagnostics (the Styles check,
 * long-frame attribution) cannot tell whose it is. Null outside a plugin view.
 */
export const PluginKitOwnerContext = createContext<string | null>(null);

export type PluginKitLayer = "modal" | "nested";

/**
 * The dialog layer kit content sits in. Kit overlays portal to the body at the
 * popover tier, which is below a nested dialog, so one opened from inside a
 * nested dialog has to lift itself above it.
 */
export const PluginKitLayerContext = createContext<PluginKitLayer>("modal");

/** Above `--z-nested-dialog`, still below toasts. */
const NESTED_OVERLAY_Z_CLASS = "z-[calc(var(--z-nested-dialog)+1)]";

export function usePluginKitOwner(): string | null {
  return useContext(PluginKitOwnerContext);
}

/** The z-index class a kit overlay's content needs in its current layer, if any. */
export function useKitOverlayZClass(): string | undefined {
  return useContext(PluginKitLayerContext) === "nested" ? NESTED_OVERLAY_Z_CLASS : undefined;
}
