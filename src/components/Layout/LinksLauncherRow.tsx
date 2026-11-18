import type { ReactNode } from "react";
import { ChoiceCard } from "@/components/ui/card";
import { useOverlayFocusRestore } from "@/components/ui/overlay-focus-restore";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { opensInPanel } from "@/services/openLinkUrl";

/**
 * One address in the links launcher: named by its title, described by its
 * detail line, opened on activation. A local address comes forward in a
 * panel, which takes focus as it does; the close mustn't pull it back. An
 * `external` row always goes to the system browser, so it never hands off.
 * Without a `url` the row is read-only text: a fact with nowhere to go.
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
  trailing,
  actions,
  url,
  external = false,
  opensPanel = opensInPanel,
  onOpen,
}: {
  rowId: string;
  icon: ReactNode;
  title: string;
  /** Show the whole title on hover when it is cut. */
  revealTitle?: boolean;
  detail: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  url: string | undefined;
  external?: boolean;
  /** Whether opening `url` brings a panel forward, asked at activation. */
  opensPanel?: (url: string) => boolean;
  onOpen: (url: string) => void;
}) {
  const focusRestore = useOverlayFocusRestore();
  const titleId = `${rowId}-title`;
  const detailId = `${rowId}-detail`;
  const titleText = (
    <span id={titleId} className="min-w-0 shrink-0 max-w-[60%] truncate text-sm text-text-primary">
      {title}
    </span>
  );
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {revealTitle ? (
          // The row is the tab stop; its title is a pointer reveal only.
          <TruncatedTooltip content={title} focusable={false}>
            {titleText}
          </TruncatedTooltip>
        ) : (
          titleText
        )}
        <span
          id={detailId}
          className="min-w-0 truncate text-xs text-text-secondary group-hover:text-text-primary transition-colors duration-150"
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
      <ChoiceCard
        tone="row"
        padding="sm"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        onClick={() => {
          if (!external && opensPanel(url)) focusRestore?.expectHandoff();
          onOpen(url);
        }}
        className="group flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        {body}
      </ChoiceCard>
      {actionSlot}
    </li>
  );
}
