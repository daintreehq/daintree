import type { ReactNode } from "react";
import { Copy, Globe } from "lucide-react";
import { ChoiceCard } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useOverlayFocusRestore } from "@/components/ui/overlay-focus-restore";
import { ROW_MENU_TARGET_CLASS } from "@/components/ui/paletteRowStyles";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { copyWithToast } from "@/lib/copyWithToast";
import { isRowMenuKey, openRowMenuFromKeyboard } from "@/lib/rowContextMenu";
import { cn } from "@/lib/utils";
import { opensInPanel } from "@/services/openLinkUrl";

/**
 * Marks the launcher's content, so a close can tell whether focus was inside
 * it. A row's menu carries it too: portalled to the page, it is outside the
 * content in the DOM while still a part of it.
 */
export const LINKS_LAUNCHER_CONTENT_ATTR = "data-links-launcher";

const MENU_ICON_CLASS = "mr-2 h-3.5 w-3.5 shrink-0";

/**
 * One address in the links launcher: named by its title, described by its
 * detail line, opened on activation. A local address comes forward in a
 * panel, which takes focus as it does; the close mustn't pull it back. An
 * `external` row always goes to the system browser, so it never hands off.
 * Without a `url` the row is read-only text: a fact with nowhere to go. With
 * one, its context menu opens that address in the system browser or copies it
 * whole, wherever the row itself would take it.
 * `actions` sit beside the row rather than in it, so pressing one never also
 * opens the row, and they stay mounted while the row gains or loses its
 * address, so a focused one keeps the keyboard.
 */
export function LinksLauncherRow({
  rowId,
  icon,
  title,
  revealTitle = false,
  detail,
  keepDetail = false,
  trailing,
  actions,
  url,
  external = false,
  opensPanel = opensInPanel,
  onOpen,
  onOpenExternal,
}: {
  rowId: string;
  icon: ReactNode;
  title: string;
  /** Show the whole title on hover when it is cut. */
  revealTitle?: boolean;
  detail: ReactNode;
  /** Keep a short detail whole and cut the title instead, for an address the row is about. */
  keepDetail?: boolean;
  trailing?: ReactNode;
  actions?: ReactNode;
  url: string | undefined;
  external?: boolean;
  /** Whether opening `url` brings a panel forward, asked at activation. */
  opensPanel?: (url: string) => boolean;
  onOpen: (url: string) => void;
  /** Opens `url` in the system browser, from the row's menu. */
  onOpenExternal: (url: string) => void;
}) {
  const focusRestore = useOverlayFocusRestore();
  const titleId = `${rowId}-title`;
  const detailId = `${rowId}-detail`;
  const titleText = (
    <span
      id={titleId}
      className={cn(
        "truncate text-sm text-text-primary",
        keepDetail ? "min-w-12" : "min-w-0 shrink-0 max-w-[60%]"
      )}
    >
      {title}
    </span>
  );
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {revealTitle ? (
          // In a row that opens, the row is the tab stop and its title a pointer
          // reveal only; a read-only row's title is its own.
          <TruncatedTooltip content={title} focusable={url === undefined}>
            {titleText}
          </TruncatedTooltip>
        ) : (
          titleText
        )}
        <span
          id={detailId}
          className={cn(
            "truncate text-xs text-text-secondary group-hover:text-text-primary transition-colors duration-150",
            // The title keeps a floor, so a very narrow launcher cuts the
            // address rather than the name that tells two servers apart.
            keepDetail ? "shrink-0 max-w-[calc(100%-3.5rem)]" : "min-w-0"
          )}
        >
          {detail}
        </span>
      </span>
      {trailing}
    </>
  );
  const actionSlot = actions !== undefined && (
    <div className="flex shrink-0 items-center gap-0.5 pr-1">{actions}</div>
  );
  if (url === undefined) {
    return (
      <li className="flex w-full items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 border border-transparent px-3 py-2">
          {body}
        </div>
        {actionSlot}
      </li>
    );
  }
  return (
    <li className="flex w-full items-center">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ChoiceCard
            tone="row"
            padding="sm"
            aria-labelledby={titleId}
            aria-describedby={detailId}
            // Stands the global Shift+F10 / Menu-key handler down, which would
            // open the focused panel's menu instead of this row's.
            data-row-menu=""
            onClick={() => {
              if (!external && opensPanel(url)) focusRestore?.expectHandoff();
              onOpen(url);
            }}
            onKeyDown={(event) => {
              if (!isRowMenuKey(event)) return;
              // Also keeps the browser's own contextmenu for the key from opening it twice.
              event.preventDefault();
              event.stopPropagation();
              openRowMenuFromKeyboard(event.currentTarget);
            }}
            className={cn(
              "group flex min-w-0 flex-1 items-center gap-2.5 text-left",
              ROW_MENU_TARGET_CLASS
            )}
          >
            {body}
          </ChoiceCard>
        </ContextMenuTrigger>
        <ContextMenuContent {...{ [LINKS_LAUNCHER_CONTENT_ATTR]: "" }}>
          <ContextMenuItem onSelect={() => onOpenExternal(url)}>
            <Globe className={MENU_ICON_CLASS} aria-hidden="true" />
            Open in external browser
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyWithToast("URL", url)}>
            <Copy className={MENU_ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {actionSlot}
    </li>
  );
}
