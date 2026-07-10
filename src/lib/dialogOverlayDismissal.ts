import { dismissAllTooltips } from "@/lib/tooltipDismissRegistry";
import { shortcutHintStore } from "@/store/shortcutHintStore";

/**
 * Clear every transient overlay a dialog transition can strand: Radix
 * tooltips (via the dismiss registry) and the ShortcutHint teaching
 * overlay (z-toast, above z-modal). Called by AppDialog and
 * AppPaletteDialog on every open and close transition (issue #11030).
 */
export function clearDialogOverlays(): void {
  dismissAllTooltips();
  shortcutHintStore.getState().hide();
}
