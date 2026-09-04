import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { SquareTerminal } from "lucide-react";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import {
  activateDockLaunchItem,
  type ActivateDockLaunchItemContext,
  type DockLaunchItem,
} from "./dockLaunchItems";
import type { LauncherToolbarEntry } from "./launcherToolbarCatalog";

/** The glyph for a row, in whatever vocabulary its category speaks. */
function LauncherItemIcon({ item }: { item: DockLaunchItem }) {
  if (item.category === "agent") {
    // Same fallback glyph the launcher's own agent rows use, so a contributed
    // agent with no icon looks the same in both places rather than borrowing
    // the recipe mark.
    const Icon = item.agent.icon ?? SquareTerminal;
    // Same wrapper the launcher row and the agent tray use, so a plugin agent's
    // brand colour reads identically wherever it appears.
    return (
      <BrandMark brandColor={item.agent.brandColor}>
        <Icon />
      </BrandMark>
    );
  }
  if (item.category === "panel") {
    return <PanelKindIcon iconId={item.iconId} color={item.color} />;
  }
  return <Workflow />;
}

/** What pressing the button does, in one word, for the tooltip and the a11y name. */
const ACTION_VERB = {
  agent: "Start",
  panel: "Open",
  recipe: "Run",
} as const;

/**
 * A launcher row the user pinned to its own top-level toolbar slot (#12217).
 *
 * The launcher row keeps its place either way — pinning adds an access point,
 * it never moves the row out of the launcher, which is the same contract plugin
 * contributions have with the plugin tray (#11304).
 *
 * Activation goes through `activateDockLaunchItem`, the launcher's own seam,
 * rather than a per-category dispatch of its own. That is what keeps a recipe
 * (which has no action id at all and runs through `runRecipeWithResults`), a
 * panel kind (which may or may not name a launch action), and an arbitrary agent
 * behaving on the toolbar exactly as they do in the launcher — including the
 * refusal toasts, which a second implementation would have had to reproduce.
 */
export function LauncherToolbarButton({
  entry,
  activationContext,
  "data-toolbar-item": dataToolbarItem,
}: {
  entry: LauncherToolbarEntry;
  activationContext: ActivateDockLaunchItemContext;
  "data-toolbar-item"?: string;
}) {
  const setLauncherItemOnToolbar = useToolbarPreferencesStore((s) => s.setLauncherItemOnToolbar);
  const { item } = entry;
  const label = `${ACTION_VERB[item.category]} ${item.name}`;
  const disabledReason = item.disabled?.reason;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              // A row whose precondition is unmet stays reachable and stays
              // labelled with why, matching the launcher: the pin is a placement
              // the user made, and removing the button when a project closes
              // would rearrange the toolbar under them.
              disabled={disabledReason !== undefined}
              onClick={() => activateDockLaunchItem(item, activationContext)}
              className="toolbar-icon-button text-text-primary relative"
              aria-label={disabledReason ? `${label} (${disabledReason})` : label}
            >
              <LauncherItemIcon item={item} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {disabledReason ? `${label} — ${disabledReason}` : label}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        {/*
          The generic toggle writes `false`, and for a launcher item only an
          explicit `true` grants a slot — so it would leave the button on screen
          while recording a preference that says nothing. The dedicated action
          deletes the key and the position together.
        */}
        <ToolbarContextMenuItems
          buttonId={entry.buttonId}
          side="left"
          onUnpin={() => setLauncherItemOnToolbar(entry.buttonId, false)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
