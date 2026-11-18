import type { ReactNode } from "react";
import { ChoiceCard } from "@/components/ui/card";
import { useOverlayFocusRestore } from "@/components/ui/overlay-focus-restore";
import { opensInPanel } from "@/services/openLinkUrl";

/**
 * One address in the links launcher: named by its title, described by its
 * detail line, opened on activation. A local address comes forward in a
 * panel, which takes focus as it does; the close mustn't pull it back. An
 * `external` row always goes to the system browser, so it never hands off.
 * Without a `url` the row is read-only text: a fact with nowhere to go.
 */
export function LinksLauncherRow({
  rowId,
  icon,
  title,
  detail,
  trailing,
  url,
  external = false,
  onOpen,
}: {
  rowId: string;
  icon: ReactNode;
  title: string;
  detail: ReactNode;
  trailing?: ReactNode;
  url: string | undefined;
  external?: boolean;
  onOpen: (url: string) => void;
}) {
  const focusRestore = useOverlayFocusRestore();
  const titleId = `${rowId}-title`;
  const detailId = `${rowId}-detail`;
  const body = (
    <>
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
    </>
  );
  if (url === undefined) {
    return (
      <li className="flex w-full items-center gap-2.5 border border-transparent px-3 py-2">
        {body}
      </li>
    );
  }
  return (
    <li>
      <ChoiceCard
        tone="row"
        padding="sm"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        onClick={() => {
          if (!external && opensInPanel(url)) focusRestore?.expectHandoff();
          onOpen(url);
        }}
        className="group flex w-full items-center gap-2.5 text-left"
      >
        {body}
      </ChoiceCard>
    </li>
  );
}
