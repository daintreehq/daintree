import { APP_MODAL_SELECTOR, hasAppModal } from "@/lib/appModal";

/**
 * Whether the panel rendered in `container` may answer the app's Cmd+F
 * (`daintree:find-in-panel`). The broadcast reaches every focused panel, and a
 * panel dialog's is focused alongside the grid or dock panel still selected
 * underneath it, so while an app modal holds the keyboard only a panel inside
 * that same modal answers (#16877). The nearest modal, not any ancestor: a
 * confirm over a panel dialog holds the keys, so the dialog under it doesn't.
 */
export function canPanelTakeFind(container: Element | null | undefined): boolean {
  if (!hasAppModal()) return true;
  const owner = document.activeElement?.closest(APP_MODAL_SELECTOR);
  return owner != null && container?.closest(APP_MODAL_SELECTOR) === owner;
}
