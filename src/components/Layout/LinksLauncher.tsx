import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Globe, ServerCog } from "lucide-react";
import { Link } from "@/components/icons";
import { linkHost } from "@shared/utils/projectLinks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/card";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
} from "@/components/ui/dropdown-menu";
import { useOverlayFocusRestore } from "@/components/ui/overlay-focus-restore";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { enterFocusedPanel } from "@/components/Terminal/contentGridFocus";
import { useAriaKeyshortcuts, useEffectiveCombo } from "@/hooks";
import {
  hasLauncherLinks,
  useLinksLauncherLinks,
  type LinksLauncherLinks,
} from "@/hooks/useLinksLauncher";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { opensInPanel, openLinkUrl } from "@/services/openLinkUrl";
import { useAllDevSessions } from "@/store/allDevSessionsStore";
import { useLinksLauncherStore } from "@/store/linksLauncherStore";
import { usePanelStore } from "@/store/panelStore";
import { logError } from "@/utils/logger";
import {
  DEV_SERVERS_HEADING,
  LinksLauncherDevServers,
  hasDevServersSection,
  listedDevSessions,
  summarizeDevServers,
  type DevSessionsSnapshot,
} from "./LinksLauncherDevServers";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { focusToolbarControl } from "./PluginToolbarPopover";
import { toolbarIconButtonClass } from "./toolbarItemClasses";

export const LINKS_LAUNCHER_BUTTON_ID = "links-launcher" as const;
const LINKS_ACTION_ID = "links.open" as const;
const LINKS_LABEL = "Links";
export const PROJECT_LINKS_HEADING = "Project links";
export const GLOBAL_LINKS_HEADING = "Your links";

/** Marks the launcher's content, so a close can tell whether focus was inside it. */
const CONTENT_ATTR = "data-links-launcher";

function openLink(url: string): void {
  openLinkUrl(url).catch((error: unknown) => logError("Failed to open link", error));
}

/**
 * Close the launcher opened off its button when that button is being moved
 * into `side`'s `…` menu: its portalled content would otherwise stay pinned to
 * a control nobody can see. Focus that was inside it goes to that `…` button,
 * where the links now are, instead of falling to `document.body`.
 */
export function closeLinksLauncherForHiddenButton(side: "left" | "right"): void {
  const { opening, close } = useLinksLauncherStore.getState();
  if (opening?.origin !== "button") return;
  const active = document.activeElement;
  const focusInside = active instanceof Element && active.closest(`[${CONTENT_ATTR}]`) !== null;
  close(
    opening.seq,
    focusInside
      ? () =>
          document.querySelector<HTMLElement>(
            `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"][data-visible="true"]`
          )
      : null
  );
}

interface LinkRowProps {
  rowId: string;
  title: string;
  url: string;
  addedByAssistant: boolean;
  onOpen: (url: string) => void;
}

function LinkRow({ rowId, title, url, addedByAssistant, onOpen }: LinkRowProps) {
  const focusRestore = useOverlayFocusRestore();
  const titleId = `${rowId}-title`;
  const hostId = `${rowId}-host`;
  return (
    <li>
      <ChoiceCard
        tone="row"
        padding="sm"
        aria-labelledby={titleId}
        aria-describedby={hostId}
        onClick={() => {
          // A panel takes focus as it comes forward; the close mustn't pull it back.
          if (opensInPanel(url)) focusRestore?.expectHandoff();
          onOpen(url);
        }}
        className="group flex w-full items-center gap-2.5 text-left"
      >
        <Globe className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            id={titleId}
            className="min-w-0 shrink-0 max-w-[60%] truncate text-sm text-text-primary"
          >
            {title}
          </span>
          <span
            id={hostId}
            className="min-w-0 truncate text-xs text-text-secondary group-hover:text-text-primary transition-colors duration-150"
          >
            {linkHost(url)}
            {addedByAssistant && <span className="sr-only">, added by the Assistant</span>}
          </span>
        </span>
        {addedByAssistant && (
          <Badge size="xs" tone="neutral" aria-hidden="true" className="shrink-0">
            Assistant
          </Badge>
        )}
      </ChoiceCard>
    </li>
  );
}

function LinkSection({
  heading,
  sectionId,
  children,
}: {
  heading: string;
  sectionId: string;
  children: ReactNode;
}) {
  const headingId = `${sectionId}-heading`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={cn(LIST_LABEL_CLASS, "px-3 pt-1.5 pb-1")}>
        {heading}
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function openProjectLinkSettings(): void {
  void actionService.dispatch(
    "app.settings.openTab",
    { tab: "project:general", sectionId: "project-links" },
    { source: "user" }
  );
}

/**
 * The launcher's list: this project's links, then the person's own, then the
 * dev servers across every worktree.
 */
export function LinksLauncherList({
  links,
  devSessions,
  onOpen,
  onManage,
}: {
  links: LinksLauncherLinks;
  devSessions: DevSessionsSnapshot;
  onOpen: (url: string) => void;
  onManage: () => void;
}) {
  const baseId = useId();
  const { projectLinks, globalLinks } = links;
  if (!hasLauncherLinks(links) && !hasDevServersSection(devSessions)) {
    return (
      <div className="flex flex-col items-start gap-2 p-3">
        <p className="text-xs text-text-secondary">
          Links you or the Assistant save for this project, and dev servers running in any worktree,
          show here.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onManage}>
          Add a project link
        </Button>
      </div>
    );
  }
  return (
    <div className="flex max-h-[min(420px,var(--radix-popover-content-available-height))] flex-col gap-1 overflow-y-auto p-1">
      {projectLinks.length > 0 && (
        <LinkSection heading={PROJECT_LINKS_HEADING} sectionId={`${baseId}-project`}>
          {projectLinks.map((link) => (
            <LinkRow
              key={link.id}
              rowId={`${baseId}-project-${link.id}`}
              title={link.title}
              url={link.url}
              addedByAssistant={link.addedByAssistant === true}
              onOpen={onOpen}
            />
          ))}
        </LinkSection>
      )}
      {globalLinks.length > 0 && (
        <LinkSection heading={GLOBAL_LINKS_HEADING} sectionId={`${baseId}-global`}>
          {globalLinks.map((link) => (
            <LinkRow
              key={link.id}
              rowId={`${baseId}-global-${link.id}`}
              title={link.title}
              url={link.url}
              addedByAssistant={false}
              onOpen={onOpen}
            />
          ))}
        </LinkSection>
      )}
      <LinksLauncherDevServers snapshot={devSessions} sectionId={`${baseId}-dev-servers`} />
    </div>
  );
}

const CONTENT_CLASS = "w-[min(340px,var(--radix-popover-content-available-width))] p-0";

/** The launcher's popover body, shared by the button and the detached anchor. */
function isFocusStranded(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

function LinksLauncherPopoverContent({
  seq,
  onCloseAutoFocus,
}: {
  seq: number | null;
  onCloseAutoFocus: NonNullable<ComponentProps<typeof PopoverContent>["onCloseAutoFocus"]>;
}) {
  const links = useLinksLauncherLinks();
  // Read here rather than in the section, so a server leaving the list
  // re-runs the focus repair below like a link leaving it does.
  const devSessions = useAllDevSessions();
  const close = useLinksLauncherStore((s) => s.close);
  const contentRef = useRef<HTMLDivElement>(null);
  // The control inside that last held focus. Kept through its removal, which
  // fires no blur; cleared only when focus moves somewhere outside.
  const focusedRef = useRef<Element | null>(null);

  // Each opening re-reads the project's links, and the list can change under
  // the keyboard: the row it was on, a dev server's Stop, or the empty state's
  // button goes away
  // and focus falls to the page, where the next Tab starts from the top and
  // a palette closing behind the launcher would take it back.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const last = focusedRef.current;
    if (content === null || last === null || last.isConnected || !isFocusStranded()) return;
    const next = content.querySelector<HTMLElement>("button") ?? content;
    next.focus({ preventScroll: true });
  });

  return (
    <PopoverContent
      ref={contentRef}
      align="end"
      aria-label={LINKS_LABEL}
      data-testid="links-launcher"
      {...{ [CONTENT_ATTR]: "" }}
      className={CONTENT_CLASS}
      onCloseAutoFocus={onCloseAutoFocus}
      onFocusCapture={(event) => {
        focusedRef.current = event.target;
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) focusedRef.current = null;
      }}
    >
      <LinksLauncherList
        links={links}
        devSessions={devSessions}
        onOpen={(url) => {
          close(seq ?? undefined);
          openLink(url);
        }}
        onManage={() => {
          close(seq ?? undefined);
          openProjectLinkSettings();
        }}
      />
    </PopoverContent>
  );
}

/**
 * The toolbar button: opens the launcher beside itself. Present only while
 * there is a link to show (the registry's `isAvailable`), so it can go to `…`
 * and come back like any optional button.
 */
export function LinksLauncherToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const opening = useLinksLauncherStore((s) => s.opening);
  const open = useLinksLauncherStore((s) => s.open);
  const close = useLinksLauncherStore((s) => s.close);
  const shortcut = useEffectiveCombo(LINKS_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(LINKS_ACTION_ID);
  const mine = opening?.origin === "button" ? opening : null;

  // Gone from the toolbar with the launcher open off it (its last link
  // removed, its last dev server stopped from inside it): nothing would draw
  // that opening any more. A layout cleanup, so it still sees focus inside the
  // launcher before its nodes go; that focus would otherwise fall to the page.
  useLayoutEffect(
    () => () => {
      const current = useLinksLauncherStore.getState().opening;
      if (current?.origin !== "button") return;
      const active = document.activeElement;
      const focusInside = active instanceof Element && active.closest(`[${CONTENT_ATTR}]`) !== null;
      useLinksLauncherStore.getState().close(current.seq);
      if (!focusInside) return;
      setTimeout(() => {
        if (isFocusStranded()) enterFocusedPanel(usePanelStore.getState().focusedId);
      }, 0);
    },
    []
  );

  return (
    <Popover
      open={mine !== null}
      onOpenChange={(next) => {
        if (next) open("button");
        else if (mine !== null) close(mine.seq);
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <span className="inline-flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-toolbar-item={dataToolbarItem}
                    className={toolbarIconButtonClass}
                    aria-label={LINKS_LABEL}
                    aria-keyshortcuts={ariaShortcut}
                  >
                    <Link />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent(LINKS_LABEL, shortcut)}
              </TooltipContent>
            </Tooltip>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
          <ToolbarContextMenuItems buttonId={LINKS_LAUNCHER_BUTTON_ID} side="right" />
        </ContextMenuContent>
      </ContextMenu>
      <LinksLauncherPopoverContent
        seq={mine?.seq ?? null}
        onCloseAutoFocus={(event) => {
          // Closed because the button is going into `…`; see
          // `closeLinksLauncherForHiddenButton`.
          const successor = useLinksLauncherStore.getState().takeCloseFocus()?.() ?? null;
          if (successor !== null) {
            event.preventDefault();
            focusToolbarControl(successor);
          }
        }}
      />
    </Popover>
  );
}

/**
 * Where the action palette opens the launcher while its button is out of
 * sight: an anchor at the toolbar's trailing edge. It has no control to give
 * focus back to, so a close that would strand focus returns it where the
 * palette was opened from, or failing that to the focused panel; one that
 * sent focus somewhere (a click away, a panel the link opened) is left alone.
 */
export function LinksLauncherDetachedHost() {
  const opening = useLinksLauncherStore((s) => s.opening);
  const close = useLinksLauncherStore((s) => s.close);
  const mine = opening?.origin === "detached" ? opening : null;
  return (
    <Popover
      open={mine !== null}
      onOpenChange={(next) => {
        if (!next && mine !== null) close(mine.seq);
      }}
    >
      <PopoverAnchor asChild>
        <span aria-hidden="true" className="pointer-events-none h-full w-0 self-stretch" />
      </PopoverAnchor>
      <LinksLauncherPopoverContent
        seq={mine?.seq ?? null}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          setTimeout(() => {
            const detachedRestore = useLinksLauncherStore.getState().takeDetachedRestore();
            if (!isFocusStranded()) return;
            // Back where the keyboard was before the palette opened, else the panel.
            detachedRestore?.();
            if (isFocusStranded()) enterFocusedPanel(usePanelStore.getState().focusedId);
          }, 0);
        }}
      />
    </Popover>
  );
}

/**
 * The launcher's links inlined into a `…` menu its button went into, as menu
 * rows. Mounted with the menu's content, so each opening of the menu re-reads
 * this project's list the way an opening of the popover does. Dev servers
 * have controls of their own a menu row can't hold, so one row opens the
 * launcher for them once the menu has closed.
 */
export function LinksLauncherOverflowItems({ side }: { side: "left" | "right" }) {
  const links = useLinksLauncherLinks();
  const { sessions } = useAllDevSessions();
  const listedServers = listedDevSessions(sessions);
  const focusRestore = useOverlayFocusRestore();
  useEffect(() => {
    useLinksLauncherStore.getState().requestRefresh();
  }, []);
  const select = (url: string) => {
    if (opensInPanel(url)) focusRestore?.expectHandoff();
    openLink(url);
  };
  const { projectLinks, globalLinks } = links;
  return (
    <>
      {projectLinks.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>{PROJECT_LINKS_HEADING}</DropdownMenuLabel>
          {projectLinks.map((link) => (
            <DropdownMenuItem key={`project-${link.id}`} onClick={() => select(link.url)}>
              <Globe className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{link.title}</span>
              <DropdownMenuMeta aria-hidden={false}>
                {linkHost(link.url)}
                {link.addedByAssistant === true && (
                  <span className="sr-only">, added by the Assistant</span>
                )}
              </DropdownMenuMeta>
              {link.addedByAssistant === true && (
                <Badge size="xs" tone="neutral" aria-hidden="true" className="ml-2 shrink-0">
                  Assistant
                </Badge>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      )}
      {globalLinks.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>{GLOBAL_LINKS_HEADING}</DropdownMenuLabel>
          {globalLinks.map((link) => (
            <DropdownMenuItem key={`global-${link.id}`} onClick={() => select(link.url)}>
              <Globe className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{link.title}</span>
              <DropdownMenuMeta aria-hidden={false}>{linkHost(link.url)}</DropdownMenuMeta>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      )}
      {listedServers.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => useLinksLauncherStore.getState().deferFromOverflow(side)}
          >
            <ServerCog className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{DEV_SERVERS_HEADING}…</span>
            <DropdownMenuMeta aria-hidden={false}>
              {summarizeDevServers(listedServers)}
            </DropdownMenuMeta>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      )}
    </>
  );
}
