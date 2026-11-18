import type { ReactNode } from "react";
import { ChoiceCard } from "@/components/ui/card";
import { useOverlayFocusRestore } from "@/components/ui/overlay-focus-restore";
import { opensInPanel } from "@/services/openLinkUrl";

/**
 * One address in the links launcher: named by its title, described by its
 * detail line, opened on activation. A local address comes forward in a
 * panel, which takes focus as it does; the close mustn't pull it back.
 */
export function LinksLauncherRow({
  rowId,
  icon,
  title,
  detail,
  trailing,
  url,
  onOpen,
}: {
  rowId: string;
  icon: ReactNode;
  title: string;
  detail: ReactNode;
  trailing?: ReactNode;
  url: string;
  onOpen: (url: string) => void;
}) {
  const focusRestore = useOverlayFocusRestore();
  const titleId = `${rowId}-title`;
  const detailId = `${rowId}-detail`;
  return (
    <li>
      <ChoiceCard
        tone="row"
        padding="sm"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        onClick={() => {
          if (opensInPanel(url)) focusRestore?.expectHandoff();
          onOpen(url);
        }}
        className="group flex w-full items-center gap-2.5 text-left"
      >
        {icon}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            id={titleId}
            className="min-w-0 shrink-0 max-w-[60%] truncate text-sm text-text-primary"
          >
            {title}
          </span>
          <span
            id={detailId}
            className="min-w-0 truncate text-xs text-text-secondary group-hover:text-text-primary transition-colors duration-150"
          >
            {detail}
          </span>
        </span>
        {trailing}
      </ChoiceCard>
    </li>
  );
}
