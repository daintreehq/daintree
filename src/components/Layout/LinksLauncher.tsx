import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Globe, ServerCog } from "lucide-react";
import { GitPullRequest, Link, ListChecks } from "@/components/icons";
import type { DeclaredProjectLink, DeclaredProjectLinkSource } from "@shared/types";
import { linkHost } from "@shared/utils/projectLinks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FactRun } from "@/components/ui/FactSeparator";
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
  useLinksLauncherDeploymentTarget,
  useLinksLauncherLinks,
  useLinksLauncherPullRequest,
  type LauncherDeploymentTarget,
  type LauncherPullRequest,
  type LinksLauncherLinks,
} from "@/hooks/useLinksLauncher";
import { useSkeletonFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { opensInPanel, openLinkUrl, openUrlExternally } from "@/services/openLinkUrl";
import { useAllDevSessions } from "@/store/allDevSessionsStore";
import { useLinksLauncherStore } from "@/store/linksLauncherStore";
import { usePanelStore } from "@/store/panelStore";
import { logError } from "@/utils/logger";
import { pullRequestWords } from "@/components/Worktree/ReviewHub/prWords";
import { usePullRequestTerm } from "@/components/Worktree/ReviewHub/usePullRequestTerm";
import {
  DEV_SERVERS_HEADING,
  LinksLauncherDevServers,
  hasDevServersSection,
  listedDevSessions,
  summarizeDevServers,
  type DevSessionsSnapshot,
} from "./LinksLauncherDevServers";
import {
  LinksLauncherDeployments,
  showsDeployments,
  useLauncherDeployments,
  type LauncherDeployments,
} from "./LinksLauncherDeployments";
import {
  LinksLauncherPullRequest,
  pullRequestFacts,
  pullRequestTitle,
  showsPullRequest,
  useLauncherPullRequestChecks,
  type LauncherChecks,
} from "./LinksLauncherPullRequest";
import { LinksLauncherRow } from "./LinksLauncherRow";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { focusToolbarControl } from "./PluginToolbarPopover";
import { toolbarIconButtonClass } from "./toolbarItemClasses";

export const LINKS_LAUNCHER_BUTTON_ID = "links-launcher" as const;
const LINKS_ACTION_ID = "links.open" as const;
const LINKS_LABEL = "Links";
export const PROJECT_LINKS_HEADING = "Project links";
export const GLOBAL_LINKS_HEADING = "Your links";

interface DeclaredLinkGroup {
  source: DeclaredProjectLinkSource;
  links: readonly DeclaredProjectLink[];
}

/**
 * The declared links, one group per manifest, in the order Main lists the
 * manifests. A manifest this build doesn't know (a newer Remote Host's) still
 * shows, under its own file name.
 */
function declaredLinkGroups(links: readonly DeclaredProjectLink[]): DeclaredLinkGroup[] {
  const groups = new Map<DeclaredProjectLinkSource, DeclaredProjectLink[]>();
  for (const link of links) {
    const group = groups.get(link.source);
    if (group) group.push(link);
    else groups.set(link.source, [link]);
  }
  return Array.from(groups, ([source, own]) => ({ source, links: own }));
}

function declaredLinksHeading(source: DeclaredProjectLinkSource): string {
  return `From ${source}`;
}

/** Read after a declared row's host, so the row says where it came from. */
function DeclaredNote({ source }: { source: DeclaredProjectLinkSource }) {
  return <span className="sr-only">, declared in the project&apos;s {source}</span>;
}

/** Marks the launcher's content, so a close can tell whether focus was inside it. */
const CONTENT_ATTR = "data-links-launcher";

function openLink(url: string): void {
  openLinkUrl(url).catch((error: unknown) => logError("Failed to open link", error));
}

const LOG_PREFIX = "[LinksLauncher]";

function deploymentSectionKey(target: LauncherDeploymentTarget): string {
  const ref = target.kind === "pullRequest" ? `pr:${target.prNumber}` : `branch:${target.branch}`;
  return `${target.worktreeId}:${ref}`;
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
  /** The manifest that declares the link, for one nobody saved. */
  declaredIn?: DeclaredProjectLinkSource;
  onOpen: (url: string) => void;
}

function LinkRow({ rowId, title, url, addedByAssistant, declaredIn, onOpen }: LinkRowProps) {
  return (
    <LinksLauncherRow
      rowId={rowId}
      icon={<Globe className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />}
      title={title}
      detail={
        <>
          {linkHost(url)}
          {addedByAssistant && <span className="sr-only">, added by the Assistant</span>}
          {declaredIn !== undefined && <DeclaredNote source={declaredIn} />}
        </>
      }
      trailing={
        addedByAssistant && (
          <Badge size="xs" tone="neutral" aria-hidden="true" className="shrink-0">
            Assistant
          </Badge>
        )
      }
      url={url}
      onOpen={onOpen}
    />
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
 * The launcher's list: this project's saved links, then the ones its
 * manifests declare, one section per file, then the person's own, then the
 * active worktree's pull request and where it is deployed, then the dev
 * servers across every worktree.
 */
export function LinksLauncherList({
  links,
  pullRequest,
  checks,
  deploymentTarget,
  deployments,
  devSessions,
  onOpen,
  onOpenExternal,
  onManage,
}: {
  links: LinksLauncherLinks;
  pullRequest: LauncherPullRequest | null;
  checks: LauncherChecks;
  deploymentTarget: LauncherDeploymentTarget | null;
  deployments: LauncherDeployments;
  devSessions: DevSessionsSnapshot;
  onOpen: (url: string) => void;
  /** Opens in the system browser, whatever the address. */
  onOpenExternal: (url: string) => void;
  onManage: () => void;
}) {
  const baseId = useId();
  const { projectLinks, declaredLinks, globalLinks } = links;
  const shownPullRequest = showsPullRequest(pullRequest, checks) ? pullRequest : null;
  const deploymentSkeleton = useSkeletonFloor(useSkeletonGate(deployments.kind === "loading"));
  // Still being read, or shown: either way the prompt to add a link would be
  // premature, since the answer may be all the launcher has to show.
  const holdsDeployments =
    deploymentTarget !== null &&
    (deployments.kind === "loading" || showsDeployments(deployments, deploymentSkeleton));
  if (
    !hasLauncherLinks(links) &&
    shownPullRequest === null &&
    !holdsDeployments &&
    !hasDevServersSection(devSessions)
  ) {
    return (
      <div className="flex flex-col items-start gap-2 p-3">
        <p className="text-xs text-text-secondary">
          Links you or the Assistant save for this project, links declared in its manifests, and dev
          servers running in any worktree show here.
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
      {declaredLinkGroups(declaredLinks).map((group, groupIndex) => (
        <LinkSection
          key={group.source}
          heading={declaredLinksHeading(group.source)}
          sectionId={`${baseId}-declared-${groupIndex}`}
        >
          {group.links.map((link, index) => (
            <LinkRow
              key={link.url}
              rowId={`${baseId}-declared-${groupIndex}-${index}`}
              title={link.title}
              url={link.url}
              addedByAssistant={false}
              declaredIn={group.source}
              onOpen={onOpen}
            />
          ))}
        </LinkSection>
      ))}
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
      {shownPullRequest !== null && (
        <LinksLauncherPullRequest
          // A section per pull request: nothing one painted carries over to another.
          key={`${shownPullRequest.worktreeId}:${shownPullRequest.number}`}
          pullRequest={shownPullRequest}
          checks={checks}
          sectionId={`${baseId}-pull-request`}
          onOpen={onOpen}
        />
      )}
      {deploymentTarget !== null && (
        <LinksLauncherDeployments
          // A section per target, like the pull request's.
          key={deploymentSectionKey(deploymentTarget)}
          worktreeLabel={deploymentTarget.worktreeLabel}
          deployments={deployments}
          showSkeleton={deploymentSkeleton}
          sectionId={`${baseId}-deployments`}
          onOpen={onOpenExternal}
        />
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
  // Read here rather than in their sections, so a server, a check or a
  // deployment leaving the list re-runs the focus repair below like a link
  // leaving it does.
  const devSessions = useAllDevSessions();
  const pullRequest = useLinksLauncherPullRequest();
  const checks = useLauncherPullRequestChecks(pullRequest, seq);
  // Asked of the pull request the list shows: once the forge says it is gone,
  // the branch it was opened from may still be deployed.
  const deploymentTarget = useLinksLauncherDeploymentTarget(
    showsPullRequest(pullRequest, checks) ? pullRequest : null
  );
  const deployments = useLauncherDeployments(deploymentTarget, seq);
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
        pullRequest={pullRequest}
        checks={checks}
        deploymentTarget={deploymentTarget}
        deployments={deployments}
        devSessions={devSessions}
        onOpen={(url) => {
          close(seq ?? undefined);
          openLink(url);
        }}
        onOpenExternal={(url) => {
          close(seq ?? undefined);
          openUrlExternally(url, LOG_PREFIX);
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
 * this project's list the way an opening of the popover does. A pull
 * request's checks are read when the launcher opens, and dev servers have
 * controls of their own a menu row can't hold, so each gets one row that
 * opens the launcher once the menu has closed.
 */
export function LinksLauncherOverflowItems({ side }: { side: "left" | "right" }) {
  const links = useLinksLauncherLinks();
  const pullRequest = useLinksLauncherPullRequest();
  const prWords = pullRequestWords(usePullRequestTerm(pullRequest?.providerId ?? null));
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
  const { projectLinks, declaredLinks, globalLinks } = links;
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
      {declaredLinkGroups(declaredLinks).map((group) => (
        <DropdownMenuGroup key={`declared-${group.source}`}>
          <DropdownMenuLabel>{declaredLinksHeading(group.source)}</DropdownMenuLabel>
          {group.links.map((link) => (
            <DropdownMenuItem key={`declared-${link.url}`} onClick={() => select(link.url)}>
              <Globe className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{link.title}</span>
              <DropdownMenuMeta aria-hidden={false}>
                {linkHost(link.url)}
                <DeclaredNote source={group.source} />
              </DropdownMenuMeta>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ))}
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
      {pullRequest !== null && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>{prWords.title}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => select(pullRequest.url)}>
            <GitPullRequest className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {/* Capped: a pull request's title can be long, and the menu sizes to its widest row. */}
            <span className="min-w-0 max-w-64 flex-1 truncate">
              {pullRequestTitle(pullRequest, prWords)}
            </span>
            <DropdownMenuMeta aria-hidden={false}>
              <FactRun facts={pullRequestFacts(pullRequest, prWords)} />
            </DropdownMenuMeta>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => useLinksLauncherStore.getState().deferFromOverflow(side)}
          >
            <ListChecks className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Checks…</span>
          </DropdownMenuItem>
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
