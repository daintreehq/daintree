import { isPtyPanel, type PanelInstance } from "@shared/types/panel";

/**
 * Whether the quick switcher lists this panel. The MRU recorder applies the
 * same test, so the capped MRU list never fills with entries the switcher
 * can't show (#9922, #13763).
 */
export function isQuickSwitchablePanel(panel: PanelInstance): boolean {
  if (panel.location === "trash") return false;
  if (panel.excludeFromPersistence === true) return false;
  if (isPtyPanel(panel) && panel.hasPty === false) return false;
  return true;
}
