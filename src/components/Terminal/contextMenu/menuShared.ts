import type { ActionId } from "@shared/types/actions";
import type { MenuActionSourceValue } from "@/components/ui/menu-source";
import type { usePanelStore } from "@/store";

export const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

export type MenuPanel = ReturnType<typeof usePanelStore.getState>["panelsById"][string];

/** Routes one menu command against the panel the menu was opened on. */
export type MenuActionHandler = (actionId: string) => void;

/**
 * An action the menu runs once it has closed and handed focus back to the
 * pane, so whatever the action opens records the pane as where to return it.
 */
export interface PendingMenuDispatch {
  actionId: ActionId;
  args: Record<string, unknown>;
  source: MenuActionSourceValue;
}
