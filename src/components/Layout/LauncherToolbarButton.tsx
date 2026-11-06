import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
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
    // No kind colour: the toolbar's built-in panel buttons are monochrome, and a
    // pinned kind wearing its launcher colour was the one panel on the strip
    // that shouted.
    return <PanelKindIcon iconId={item.iconId} />;
  }
  if (item.category === "plugin-entry") return <PanelKindIcon iconId={item.iconId} />;
  return <Workflow />;
}

/** What pressing the button does, in one word, for the tooltip and the a11y name. */
const ACTION_VERB = {
  agent: "Start",
  panel: "Open",
  recipe: "Run",
} as const;

/**
 * The tooltip and accessible name. A plugin entry's label is already the
 * author's verb phrase ("New record…"), so it carries its plugin's name in
 * place of a verb — the same words Settings → Toolbar shows for it.
 */
function launcherButtonLabel(item: DockLaunchItem, showScope: boolean): string {
  if (item.category === "plugin-entry") return `${item.name} (${item.pluginName})`;
  // Every other launch from the toolbar opens in the grid, which its launcher
  // says once; a project-scoped panel kind always opens in the dock.
  if (item.category === "panel" && item.location === "dock") return `Open ${item.name} in dock`;
  if (item.category === "recipe" && showScope) return `Run ${item.name} (${item.scopeLabel})`;
  return `${ACTION_VERB[item.category]} ${item.name}`;
}

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
  showScope = false,
  "data-toolbar-item": dataToolbarItem,
}: {
  entry: LauncherToolbarEntry;
  activationContext: ActivateDockLaunchItemContext;
  /** Another recipe shares this one's name, so its scope rides beside it. */
  showScope?: boolean;
  "data-toolbar-item"?: string;
}) {
  const setLauncherItemOnToolbar = useToolbarPreferencesStore((s) => s.setLauncherItemOnToolbar);
  const { item } = entry;
  const label = launcherButtonLabel(item, showScope);
  const disabledReason = item.disabled?.reason;
  // Recipes share one glyph and carry no icon or colour of their own, so
  // icon-only pins were indistinguishable at rest. Their name is the only thing
  // that tells one from another; the width it costs is what overflow is for.
  const showsName = item.category === "recipe";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="inline-flex">
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
                // aria-disabled, not disabled: a native disabled button leaves the
                // roving toolbar and fires no pointer events, so the tooltip
                // carrying the reason could never open. The activation guards.
                aria-disabled={disabledReason !== undefined || undefined}
                onClick={() => activateDockLaunchItem(item, activationContext)}
                className={cn(
                  "toolbar-icon-button toolbar-quiet-ink text-text-secondary relative",
                  showsName && "w-auto max-w-40 gap-1.5 px-2"
                )}
                aria-label={disabledReason ? `${label} (${disabledReason})` : label}
              >
                <LauncherItemIcon item={item} />
                {showsName && (
                  // The scope is the only thing telling two same-named recipes
                  // apart, so the name gives way to it rather than the reverse.
                  <span aria-hidden="true" className="flex min-w-0 text-xs">
                    <span className="min-w-0 truncate">{item.name}</span>
                    {showScope && item.category === "recipe" && (
                      <span className="shrink-0 whitespace-pre text-text-secondary">
                        {` · ${item.scopeLabel}`}
                      </span>
                    )}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {disabledReason ? `${label} — ${disabledReason}` : label}
            </TooltipContent>
          </Tooltip>
        </span>
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
