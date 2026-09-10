import type React from "react";
import { BrandSurfaceReset } from "@/components/icons/BrandSurface";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { TOOLBAR_CUSTOMIZE_LABEL } from "./toolbarMenuStrings";
import {
  isToolbarEmptySpaceTarget,
  type ToolbarSide,
  type ToolbarVisibilityMenuRow,
  type ToolbarVisibilityMenuRows,
} from "./toolbarVisibilityMenu";

interface ToolbarButtonsContextMenuProps {
  rows: ToolbarVisibilityMenuRows;
  onToggle: (buttonId: AnyToolbarButtonId, side: ToolbarSide, onToolbar: boolean) => void;
  /** The toolbar root. Slotted, so the menu adds no DOM of its own. */
  children: React.ReactElement;
}

/**
 * The toolbar's empty-space right-click menu (#12355): every button holding a
 * toolbar slot as a checkbox, so a hidden one comes back from the same surface
 * it was hidden on, then "Customize toolbar…" for the full editor.
 *
 * Opens on empty space only. A button with its own menu already wins, because
 * Radix composes each trigger's handler to skip an event an inner trigger has
 * prevented; the filter here covers controls with no menu of their own and
 * portaled content.
 *
 * macOS and Linux deliver this right-click. On Windows the empty space is a
 * caption drag region, so the OS shows its native window menu there instead and
 * the page never sees the event.
 */
export function ToolbarButtonsContextMenu({
  rows,
  onToggle,
  children,
}: ToolbarButtonsContextMenuProps) {
  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    // Cancelling is how the open is refused — Radix's own handler skips a
    // prevented event. No native menu goes missing: project views register no
    // `context-menu` handler.
    if (!isToolbarEmptySpaceTarget(event.target, event.currentTarget)) {
      event.preventDefault();
    }
  };

  const renderRow = (row: ToolbarVisibilityMenuRow) => {
    const Icon = row.icon;
    return (
      <ContextMenuCheckboxItem
        key={row.id}
        checked={row.checked}
        onCheckedChange={(checked) => onToggle(row.id, row.side, checked)}
      >
        <Icon className="mr-2 h-3.5 w-3.5 shrink-0 text-text-secondary" />
        {row.label}
      </ContextMenuCheckboxItem>
    );
  };

  const hasLeft = rows.left.length > 0;
  const hasRight = rows.right.length > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={handleContextMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Toolbar buttons">
        {/* Context reaches through the portal, so without the reset an agent's
            brand mark would measure itself against the toolbar surface. */}
        <BrandSurfaceReset>
          {hasLeft && (
            <ContextMenuGroup aria-label="Left side">{rows.left.map(renderRow)}</ContextMenuGroup>
          )}
          {hasLeft && hasRight && <ContextMenuSeparator />}
          {hasRight && (
            <ContextMenuGroup aria-label="Right side">{rows.right.map(renderRow)}</ContextMenuGroup>
          )}
          {(hasLeft || hasRight) && <ContextMenuSeparator />}
        </BrandSurfaceReset>
        <ContextMenuActionItem inset actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
          {TOOLBAR_CUSTOMIZE_LABEL}
        </ContextMenuActionItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
