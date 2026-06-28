import { Settings2, Unplug } from "lucide-react";
import {
  ContextMenuActionItem,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuActionItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { TOOLBAR_CUSTOMIZE_LABEL, TOOLBAR_UNPIN_LABEL } from "./toolbarMenuStrings";

type Variant = "context" | "dropdown";

interface ToolbarContextMenuItemsProps {
  buttonId: AnyToolbarButtonId;
  side: "left" | "right";
  /**
   * `context` renders inside a Radix `ContextMenuContent`; `dropdown` inside
   * a Radix `DropdownMenuContent`. The primitives aren't cross-compatible —
   * the wrapper picks the matching pair so every right-click surface (and
   * the agent tray dropdown) gets the same Customize + Unpin items.
   */
  variant?: Variant;
  /**
   * Optional override for the unpin handler. Default is
   * `useToolbarPreferencesStore.toggleButtonVisibility(buttonId, side)`, but
   * built-in agent IDs (`claude` / `gemini` / `codex`) read pin state from
   * `agentSettingsStore` (tri-state — see #7673 and `isAgentToolbarVisible`),
   * not from `pinnedButtons`. Pass a callback that calls
   * `setAgentPinned(id, false)` for those buttons so unpinning actually
   * hides them. Buttons outside `BUILT_IN_AGENT_IDS` can rely on the
   * default.
   */
  onUnpin?: () => void;
}

// Single source of truth for the "Customize toolbar…" and "Unpin from toolbar"
// menu items that every right-click surface in the toolbar should expose
// (issue #9825). The Customize entry dispatches the existing
// `app.settings.openTab` action with `{ tab: "toolbar" }` so the action's
// `source` tag (set by `useMenuActionSource`) is correct for each surface —
// `context-menu` for the right-click, `menu` for the agent-tray dropdown.
export function ToolbarContextMenuItems({
  buttonId,
  side,
  variant = "context",
  onUnpin,
}: ToolbarContextMenuItemsProps) {
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);
  const handleUnpin = onUnpin ?? (() => toggleButtonVisibility(buttonId, side));

  if (variant === "dropdown") {
    return (
      <>
        <DropdownMenuActionItem
          actionId="app.settings.openTab"
          args={{ tab: "toolbar" }}
          className="h-7"
        >
          <Settings2 className="mr-2 h-3.5 w-3.5 text-text-muted" />
          {TOOLBAR_CUSTOMIZE_LABEL}
        </DropdownMenuActionItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleUnpin} className="h-7">
          <Unplug className="mr-2 h-3.5 w-3.5" />
          {TOOLBAR_UNPIN_LABEL}
        </DropdownMenuItem>
      </>
    );
  }

  return (
    <>
      <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
        {TOOLBAR_CUSTOMIZE_LABEL}
      </ContextMenuActionItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={handleUnpin}>
        <Unplug className="mr-2 h-3.5 w-3.5" />
        {TOOLBAR_UNPIN_LABEL}
      </ContextMenuItem>
    </>
  );
}
