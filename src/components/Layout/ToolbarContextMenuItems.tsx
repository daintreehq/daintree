import { EyeOff, Unplug } from "lucide-react";
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
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { useProjectToolbarOverlay } from "@/hooks/useResolvedPresentation";
import { presentationFeatureForToolbarButton } from "@shared/config/presentationProfile";
import { saveProjectToolbar } from "./saveProjectToolbar";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import {
  TOOLBAR_CUSTOMIZE_ICON,
  TOOLBAR_CUSTOMIZE_LABEL,
  TOOLBAR_HIDE_IN_PROJECT_LABEL,
  TOOLBAR_UNPIN_LABEL,
} from "./toolbarMenuStrings";

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
// `context-menu` for the right-click, `menu` for the launcher dropdown.
export function ToolbarContextMenuItems({
  buttonId,
  side,
  variant = "context",
  onUnpin,
}: ToolbarContextMenuItemsProps) {
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);
  const toolbarOverlay = useProjectToolbarOverlay();
  const projectToolbarActive = toolbarOverlay.active;
  const setPresentationLevel = useProjectPresentationStore((s) => s.setLevel);
  const devPreviewLevel = useProjectPresentationStore((s) => s.levels.devServer);
  const feature = presentationFeatureForToolbarButton(buttonId);
  // A dev preview this project placed itself (#14069) is the project's too: an
  // app-wide unpin would leave it here and take it from every other project.
  const projectPlaced =
    buttonId === "dev-server" && toolbarOverlay.available && devPreviewLevel !== undefined;
  // While this project's toolbar is in use (#13783), unpinning a demotable
  // built-in moves it into `…` for this project and writes nothing app-wide.
  const handleUnpin =
    (projectToolbarActive || projectPlaced) && feature !== undefined
      ? () => saveProjectToolbar(() => setPresentationLevel(feature, "demoted"))
      : (onUnpin ?? (() => toggleButtonVisibility(buttonId, side)));
  // Unpin only moves the button; this takes the dev preview out of every
  // surface in this project and no other (#14069). Offered once main has
  // answered for this project, so the write can't land on an unknown profile.
  const handleHideInProject =
    buttonId === "dev-server" && toolbarOverlay.available
      ? () => saveProjectToolbar(() => setPresentationLevel("devServer", "hidden"))
      : null;

  if (variant === "dropdown") {
    return (
      <>
        <DropdownMenuActionItem actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
          <TOOLBAR_CUSTOMIZE_ICON data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          {TOOLBAR_CUSTOMIZE_LABEL}
        </DropdownMenuActionItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleUnpin}>
          <Unplug data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          {TOOLBAR_UNPIN_LABEL}
        </DropdownMenuItem>
        {handleHideInProject && (
          <DropdownMenuItem onSelect={handleHideInProject}>
            <EyeOff data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {TOOLBAR_HIDE_IN_PROJECT_LABEL}
          </DropdownMenuItem>
        )}
      </>
    );
  }

  return (
    <>
      <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
        <TOOLBAR_CUSTOMIZE_ICON data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
        {TOOLBAR_CUSTOMIZE_LABEL}
      </ContextMenuActionItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={handleUnpin}>
        <Unplug data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
        {TOOLBAR_UNPIN_LABEL}
      </ContextMenuItem>
      {handleHideInProject && (
        <ContextMenuItem onSelect={handleHideInProject}>
          <EyeOff data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          {TOOLBAR_HIDE_IN_PROJECT_LABEL}
        </ContextMenuItem>
      )}
    </>
  );
}
