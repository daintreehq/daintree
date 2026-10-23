import { createContext, useContext } from "react";
import { DialogLayerContext, useDialogOverlayZClass } from "@/components/ui/dialogLayer";

/**
 * The plugin instance whose view is rendering, provided by
 * `PluginViewContent`. Kit overlays portal out of the view's root, so without
 * it their content carries no owner and diagnostics (the Styles check,
 * long-frame attribution) cannot tell whose it is. Null outside a plugin view.
 */
export const PluginKitOwnerContext = createContext<string | null>(null);

/**
 * The composite controls (a picker, a slider pair) the content sits inside,
 * as space-separated scope ids. Their portalled surfaces carry it, so focus
 * moving into a control's own popover is not mistaken for leaving it.
 */
export const KitFocusScopeContext = createContext("");

export const KIT_FOCUS_SCOPE_ATTRIBUTE = "data-kit-focus-scope";

export function usePluginKitOwner(): string | null {
  return useContext(PluginKitOwnerContext);
}

/**
 * Whether kit content sits in a nested dialog: one the plugin asked for with
 * `layer: "nested"`, or one a dock popover promoted (#14191). The enclosing
 * host dialog publishes the tier it actually painted at.
 */
export function useKitLayerNested(): boolean {
  return useContext(DialogLayerContext) === "nested";
}

/** The z-index class a kit overlay's content needs in its current layer, if any. */
export function useKitOverlayZClass(): string | undefined {
  return useDialogOverlayZClass();
}
