import { cloneElement, useRef } from "react";
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
  /**
   * The toolbar root. Cloned with a composed `onContextMenu` — the one prop this
   * menu needs — so its ref and every other handler stay its own.
   */
  children: React.ReactElement<{ onContextMenu?: React.MouseEventHandler<HTMLElement> }>;
}

/**
 * The toolbar's empty-space right-click menu (#12355): every button holding a
 * toolbar slot as a checkbox, so a hidden one comes back from the surface it
 * was hidden on, then "Customize toolbar…" for the full editor.
 *
 * Right-click only. Nothing on the toolbar takes focus without being a control,
 * so there is no keyboard route here; every control's own menu carries
 * "Customize toolbar…" instead.
 *
 * macOS and Linux deliver the right-click — Electron forwards secondary clicks
 * out of a macOS drag region (electron#44761), and Linux windows are framed. On
 * Windows the empty space is a caption drag region, so the OS shows its native
 * window menu there and the page never sees the event.
 */
export function ToolbarButtonsContextMenu({
  rows,
  onToggle,
  children,
}: ToolbarButtonsContextMenuProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const childOnContextMenu = children.props.onContextMenu;

  // Replayed onto a hidden trigger rather than making the root the trigger:
  // Radix arms a 700ms touch/pen long-press timer on its trigger's pointerdown,
  // and on the root that timer would fire from every button beneath it — past
  // this filter, and on top of a button's own menu.
  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    childOnContextMenu?.(event);
    // A control's own menu has already claimed it.
    if (event.defaultPrevented) return;
    if (!isToolbarEmptySpaceTarget(event.target, event.currentTarget)) return;
    event.preventDefault();
    triggerRef.current?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
      })
    );
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
    <>
      {cloneElement(children, { onContextMenu: handleContextMenu })}
      <ContextMenu>
        {/* A sibling of the root, not a descendant, so the replayed event can't
            bubble back into the handler that sent it. */}
        <ContextMenuTrigger asChild>
          <span ref={triggerRef} hidden />
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
              <ContextMenuGroup aria-label="Right side">
                {rows.right.map(renderRow)}
              </ContextMenuGroup>
            )}
            {(hasLeft || hasRight) && <ContextMenuSeparator />}
          </BrandSurfaceReset>
          <ContextMenuActionItem inset actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
            {TOOLBAR_CUSTOMIZE_LABEL}
          </ContextMenuActionItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}
