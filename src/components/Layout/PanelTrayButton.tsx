import { useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { Globe, MonitorPlay, Pin, Settings2, SquareMenu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuActionItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import {
  TOOLBAR_CUSTOMIZE_LABEL,
  TOOLBAR_PIN_LABEL,
  TOOLBAR_UNPIN_LABEL,
} from "./toolbarMenuStrings";
import { FolderTree, LayoutPanelTop } from "@/components/icons";
import { actionService } from "@/services/ActionService";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useKeybindingDisplay } from "@/hooks";
import type { BuiltInActionId } from "@shared/types/actions";
import type {
  AnyToolbarButtonId,
  PanelTrayButtonId,
  ToolbarPinnedState,
} from "@shared/types/toolbar";
import { cn } from "@/lib/utils";

export interface PanelTrayItem {
  id: PanelTrayButtonId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Drives the row's shortcut hint and, for every item but the file browser, its activation. */
  actionId: BuiltInActionId;
}

/**
 * The tray's inventory: every non-agent panel the toolbar can spawn without a
 * target (#11667).
 *
 * Fixed rather than derived from `panelKindRegistry`, because a tray row needs
 * three things a panel kind doesn't carry — a toolbar button id to pin, an
 * action to dispatch, and an availability rule. `review`, `file` and `diff` are
 * out for exactly that reason: they have no toolbar button id, and the first
 * needs a resolved worktree while the other two need a file. The "More panels…"
 * footer routes to the palette, which carries the complete dynamic inventory.
 *
 * Order matches `PANEL_TRAY_BUTTON_IDS`, which the store and Settings also read,
 * so no surface can disagree about what the tray holds.
 */
export const PANEL_TRAY_ITEMS: readonly PanelTrayItem[] = [
  {
    id: "file-browser",
    label: "Browse files",
    icon: FolderTree,
    actionId: "worktree.openFileBrowser",
  },
  { id: "browser", label: "Browser", icon: Globe, actionId: "agent.browser" },
  { id: "dev-server", label: "Dev preview", icon: MonitorPlay, actionId: "devServer.start" },
];

/**
 * Whether a tray item currently has its own top-level toolbar button.
 *
 * Three states, in priority order. An explicit `false` is a hide and wins over
 * any position. An explicit `true` is a promotion the user made, and reads as on
 * even in the window between a stale cross-view write dropping the position and
 * `restorePromotedPanelButtons` rebuilding it. Otherwise the position decides:
 * that is the legacy profile, which carries `browser`/`dev-server` in its arrays
 * with no pin entry at all and must keep reading as promoted so an existing
 * user's toolbar looks untouched.
 */
export function isPanelButtonOnToolbar(
  id: PanelTrayButtonId,
  pinnedButtons: ToolbarPinnedState,
  leftButtons: AnyToolbarButtonId[],
  rightButtons: AnyToolbarButtonId[]
): boolean {
  if (pinnedButtons[id] === false) return false;
  if (pinnedButtons[id] === true) return true;
  return leftButtons.includes(id) || rightButtons.includes(id);
}

function PanelTrayRow({
  item,
  onToolbar,
  disabled,
  disabledReason,
  onSelect,
  onTogglePin,
}: {
  item: PanelTrayItem;
  onToolbar: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onSelect: (item: PanelTrayItem) => void;
  onTogglePin: (item: PanelTrayItem) => void;
}) {
  const displayCombo = useKeybindingDisplay(item.actionId);
  const Icon = item.icon;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      onTogglePin(item);
    }
  };

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        if (disabled) {
          // Radix does not read `aria-disabled` as its own `disabled` prop, so
          // selection still fires and would close the menu on a row that opens
          // nothing. Guarding the dispatch alone isn't enough — the menu has to
          // stay put too.
          e.preventDefault();
          return;
        }
        onSelect(item);
      }}
      onKeyDown={handleKeyDown}
      // `aria-disabled` rather than `disabled`: a disabled Radix item is skipped
      // by type-ahead and arrow keys, which would also make its pin affordance
      // unreachable from the keyboard — and pinning a panel you haven't opened a
      // project for yet is a reasonable thing to want.
      aria-disabled={disabled || undefined}
      className={cn("group h-7", disabled && "opacity-50")}
      data-testid={`panel-tray-row-${item.id}`}
    >
      <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
        <Icon className="h-3.5 w-3.5 text-text-muted" />
      </span>

      {/*
        The label never changes with state — the reason rides alongside it. A
        command whose visible name mutates re-announces as a different item to a
        screen reader and stops matching its own name under type-ahead. Same
        shape as the `copy-tree` overflow item, which keeps its label and
        surfaces unavailability separately.
      */}
      <span className="flex-1">{item.label}</span>
      {disabled && disabledReason && (
        <span className="ml-2 text-xs text-text-muted">{disabledReason}</span>
      )}

      {displayCombo && <DropdownMenuShortcut>{displayCombo}</DropdownMenuShortcut>}

      <span className="sr-only">Press P to {onToolbar ? "unpin from" : "pin to"} toolbar</span>

      <span
        role="presentation"
        aria-hidden="true"
        data-testid={`panel-tray-pin-${item.id}`}
        data-pinned={onToolbar ? "true" : "false"}
        title={onToolbar ? `${TOOLBAR_UNPIN_LABEL} (P)` : `${TOOLBAR_PIN_LABEL} (P)`}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(item);
        }}
        className={cn(
          "ml-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-daintree-text/50 transition-opacity hover:bg-overlay-emphasis hover:text-daintree-text",
          onToolbar ? "opacity-100" : "opacity-0 group-data-[highlighted]:opacity-100"
        )}
      >
        <Pin
          className={cn(
            "h-3 w-3",
            onToolbar &&
              "fill-current text-daintree-text/40 group-data-[highlighted]:text-daintree-text"
          )}
          strokeWidth={onToolbar ? 2 : 1.75}
        />
      </span>
    </DropdownMenuItem>
  );
}

/**
 * One toolbar button collecting the non-agent panels (#11667).
 *
 * `browser` and `dev-server` used to hold their own always-visible slots even
 * though both assume web development; they now ship inside this tray while
 * `file-browser` — which assumes only that the project has files — takes the
 * first-class slot. A promoted panel keeps its tray row as well as its button,
 * matching the plugin tray.
 *
 * Mirrors `PluginTrayButton`'s structure deliberately: same controlled Dropdown
 * + ContextMenu + Tooltip nesting, same focus-restoration suppression, and the
 * same hover-reveal pin affordance — here granting a built-in its own top-level
 * slot instead of promoting a plugin contribution.
 */
export function PanelTrayButton({
  hasWorkspace,
  hasProject,
  onOpenFileBrowser,
  "data-toolbar-item": dataToolbarItem,
}: {
  /** Gates `file-browser`, whose action resolves no folder without one (#11499). */
  hasWorkspace: boolean;
  /** Gates `dev-server`, which has no project to start a server for without one. */
  hasProject: boolean;
  /**
   * The toolbar's own file-browser handler, reused so a refusal surfaces the
   * same retry toast here as it does from the button (Toolbar.tsx).
   */
  onOpenFileBrowser: () => void;
  "data-toolbar-item"?: string;
}) {
  const pinnedButtons = useToolbarPreferencesStore((s) => s.layout.pinnedButtons);
  const leftButtons = useToolbarPreferencesStore((s) => s.layout.leftButtons);
  const rightButtons = useToolbarPreferencesStore((s) => s.layout.rightButtons);
  const setPanelButtonOnToolbar = useToolbarPreferencesStore((s) => s.setPanelButtonOnToolbar);

  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Mirrors PluginTrayButton: Radix reopens the Tooltip whenever the trigger
  // regains focus, including the programmatic restore from onCloseAutoFocus.
  // Hold the suppression until the next genuine pointer hover (see #5153).
  const isRestoringFocusRef = useRef(false);
  const wasPointerCloseRef = useRef(false);
  const lastPinActionAt = useRef(0);

  const isDisabled = (id: PanelTrayButtonId) =>
    (id === "file-browser" && !hasWorkspace) || (id === "dev-server" && !hasProject);

  const disabledReasonFor = (id: PanelTrayButtonId) => {
    if (id === "file-browser") return "Needs a workspace";
    if (id === "dev-server") return "Needs a project";
    return null;
  };

  const handleSelect = (item: PanelTrayItem) => {
    if (item.id === "file-browser") {
      onOpenFileBrowser();
      return;
    }
    void actionService.dispatch(item.actionId, undefined, { source: "user" });
  };

  const handleTogglePin = (item: PanelTrayItem) => {
    const now = Date.now();
    if (now - lastPinActionAt.current < 50) return;
    lastPinActionAt.current = now;
    setPanelButtonOnToolbar(
      item.id,
      !isPanelButtonOnToolbar(item.id, pinnedButtons, leftButtons, rightButtons)
    );
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setTooltipOpen(false);
        setOpen(next);
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Tooltip
            open={tooltipOpen}
            onOpenChange={(next) => {
              if (next && isRestoringFocusRef.current) return;
              setTooltipOpen(next);
            }}
          >
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item={dataToolbarItem}
                  className="toolbar-icon-button text-daintree-text relative"
                  aria-label="Panel tray"
                  onPointerEnter={() => {
                    isRestoringFocusRef.current = false;
                  }}
                >
                  <LayoutPanelTop />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Panel tray</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
          <ToolbarContextMenuItems buttonId="panel-tray" side="left" />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[16rem]"
        onPointerDownOutside={() => {
          wasPointerCloseRef.current = true;
        }}
        onCloseAutoFocus={(e) => {
          setTooltipOpen(false);
          isRestoringFocusRef.current = true;
          // Skip focus restoration for pointer dismissals so the trigger
          // doesn't keep a focus-visible ring the user never asked for;
          // keyboard close still returns focus for WAI-ARIA.
          if (wasPointerCloseRef.current) {
            e.preventDefault();
            wasPointerCloseRef.current = false;
          }
        }}
      >
        {PANEL_TRAY_ITEMS.map((item) => (
          <PanelTrayRow
            key={item.id}
            item={item}
            onToolbar={isPanelButtonOnToolbar(item.id, pinnedButtons, leftButtons, rightButtons)}
            disabled={isDisabled(item.id)}
            disabledReason={disabledReasonFor(item.id)}
            onSelect={handleSelect}
            onTogglePin={handleTogglePin}
          />
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuActionItem actionId="panel.palette" className="h-7">
          <SquareMenu className="mr-2 h-3.5 w-3.5 text-text-muted" />
          More panels…
        </DropdownMenuActionItem>
        <DropdownMenuActionItem
          actionId="app.settings.openTab"
          args={{ tab: "toolbar" }}
          className="h-7"
        >
          <Settings2 className="mr-2 h-3.5 w-3.5 text-text-muted" />
          {TOOLBAR_CUSTOMIZE_LABEL}
        </DropdownMenuActionItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
