import { useMemo } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";
import { FolderClosed } from "@/components/icons";
import { cn } from "@/lib/utils";
import { AppPaletteDialog, PaletteNoMatchHint } from "@/components/ui/AppPaletteDialog";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowDownAZ, ChartNoAxesColumn, Clock } from "@/components/icons";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import type {
  ProjectBandKey,
  ProjectSwitcherBrowseBand,
  ProjectSwitcherProjectRow,
  ProjectSwitcherRow,
  ProjectSwitchSelectSource,
  SearchableProject,
} from "@/hooks/useProjectSwitcherPalette";
import {
  PROJECT_SECTION_LABELS,
  OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS,
} from "@/hooks/useProjectSwitcherPalette";
import { groupBandKey, isGroupBandKey } from "@/lib/projectGroupBands";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import type { ProjectGroup } from "@shared/types/project";
import { ProjectGroupContextMenuItems, ProjectGroupDropdownMenuItems } from "./ProjectGroupMenus";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  isOtherProjectsSortMode,
  OTHER_PROJECTS_SORT_MODES,
  type OtherProjectsSortMode,
} from "@/lib/projectSort";
import { pluralize } from "@/lib/pluralize";
import { ProjectListItem, ScratchListItem } from "./ProjectSwitcherRows";
import { BandCollapsedCount } from "./paletteTiles";

interface ProjectSection {
  key: ProjectBandKey;
  label: string;
  /** The band's VISIBLE rows — empty while collapsed. Always rows of `results`. */
  items: ProjectSwitcherProjectRow[];
  /** Projects the band holds whether or not they are on screen. */
  itemCount: number;
  collapsed: boolean;
  /**
   * Whether this band's header offers the fold control. False for bands read
   * off `results` rather than declared by a host: folding those would have to
   * drop rows the arrow keys can still address, so the affordance would be a
   * lie at best and #11071 at worst.
   */
  collapsible: boolean;
  /** Set on a user-made group's band. */
  group?: ProjectGroup;
  /** Group members shown in a band above — what an empty group says. */
  liftedCount?: number;
  /** Agents running across the band, for a folded header. */
  activeAgentCount?: number;
  /** Projects with a working assistant, for a folded header. */
  workingAssistantCount?: number;
}

/**
 * The fold control every band header carries (#11943).
 *
 * Deliberately neutral: it takes `PALETTE_SECTION_LABEL_CLASS`'s own muted tone
 * from the header around it and never the accent, which this surface spends on
 * the selected row alone — seven chevrons competing with it would leave the
 * highlight as just one more coloured thing.
 *
 * `tabIndex={-1}` because section headers live inside the `role="listbox"`,
 * where a focusable child is invalid and unreachable anyway — arrow keys move
 * `aria-activedescendant` across rows and never land here, matching the Other
 * band's sort trigger. Folding is a pointer convenience on purpose: searching
 * deliberately ignores it, so no band can fold a project out of a keyboard
 * user's reach, and there is nothing here they cannot get to by typing.
 *
 * `tabIndex={-1}` keeps it out of the tab order but does NOT stop a pointer
 * press from focusing it, and the header outlives the fold — so without the
 * mousedown veto below, one click would leave focus on a chevron: typing would
 * stop reaching the search box, arrows would stop stepping rows, and Enter
 * would re-toggle the band instead of committing the highlighted project. The
 * sort trigger beside it solves the same problem by handing focus back after
 * its menu closes; refusing the focus outright is cheaper and never blinks.
 *
 * The label is its own leaf so `aria-labelledby` on the surrounding group names
 * the band and nothing else — the chevron is `aria-hidden`, but the id has to
 * sit on the text either way or a later sibling would join the computed name.
 */
function BandLabel({ label, labelId }: { label: string; labelId: string }) {
  return (
    <span id={labelId} className="truncate tracking-wider uppercase">
      {label}
    </span>
  );
}

function BandCollapseToggle({
  collapsed,
  label,
  labelId,
  controlsId,
  testId,
  onToggle,
  leadingIcon,
}: {
  collapsed: boolean;
  label: string;
  labelId: string;
  controlsId: string;
  testId: string;
  onToggle: () => void;
  /** Drawn between the chevron and the label: a user-made group's folder. */
  leadingIcon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      className="flex items-center gap-1.5 min-w-0 hover:text-text-secondary transition-colors"
    >
      <ChevronRight
        data-animated-chevron
        className={cn(
          "w-3 h-3 shrink-0 transition-transform duration-150 ease-out",
          !collapsed && "rotate-90"
        )}
        aria-hidden="true"
      />
      {leadingIcon}
      <BandLabel label={label} labelId={labelId} />
    </button>
  );
}

/**
 * A band key made safe for an element id. Group keys carry a colon
 * (`group:<id>`), which is legal in an id but has to be escaped in every
 * selector that ever looks one up.
 */
function bandDomKey(key: ProjectBandKey): string {
  return key.replace(":", "-");
}

/** Stable `aria-controls` target for a band's rows. */
function bandListId(key: ProjectBandKey): string {
  return `project-section-list-${bandDomKey(key)}`;
}

// Keyed by mode rather than a list, so the lookup below is total: a new mode in
// the union is a compile error here until it gets a label and an icon. The menu
// takes its order from `OTHER_PROJECTS_SORT_MODES`.
const OTHER_PROJECTS_SORT_OPTIONS: Record<
  OtherProjectsSortMode,
  { label: string; Icon: typeof Clock }
> = {
  mostUsed: { label: "Most used", Icon: ChartNoAxesColumn },
  recent: { label: "Recent", Icon: Clock },
  alphabetical: { label: "A to Z", Icon: ArrowDownAZ },
};

/**
 * What a folded band says is still alive inside it, in the words its rows use:
 * "2 agents running", "Assistant working", or both.
 */
function formatFoldedLiveness(agents: number, assistants: number): string {
  const parts: string[] = [];
  if (agents > 0) parts.push(`${pluralize(agents, "agent")} running`);
  if (assistants > 0) {
    parts.push(
      assistants === 1 ? "assistant working" : `${pluralize(assistants, "assistant")} working`
    );
  }
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The header of every band whose order the user picks — Other projects and
 * each user-made group — which doubles as its sort control (#11455). The
 * band is the residual catch-all, so its order is the one thing a reader can't
 * infer from the rows — the control's first job is naming that order, changing
 * it second. More so since the rows stopped printing their opened times
 * (#11692): there is now nothing else on screen hinting at how they are sorted.
 *
 * Two structural constraints shape the markup:
 *
 * - The `id` stays on a leaf element holding ONLY the label text. It is the
 *   `aria-labelledby` target for the surrounding `role="group"`, and that name
 *   is computed from the element's whole subtree — nesting the mode inside it
 *   would name the band "Other projects Most used". The fold control added in
 *   #11943 is a sibling around that leaf for the same reason.
 * - The trigger is `tabIndex={-1}`. Section headers live inside the
 *   `role="listbox"`, where a focusable child is invalid and unreachable
 *   anyway (arrow keys move `aria-activedescendant` across rows, never here).
 *   Right-click reaches the same options, matching every other secondary
 *   action in this palette.
 *
 * The right-hand slot says one thing at a time: how the band is sorted while it
 * is open, and how much it is holding once it is folded — the sort order of
 * rows nobody can see is not the fact worth the space.
 *
 * No horizontal padding of its own. The `px-2` on the band wrapper is the one
 * inset that positions the row cards below, so a `px-3` here would float the
 * label 12px inside the edge those cards line up on (#11943).
 */
function SortableBandHeader({
  bandKey,
  headerId,
  label,
  itemCount,
  collapsed,
  collapsible,
  sortMode,
  onSortModeChange,
  group,
  activeAgentCount = 0,
  workingAssistantCount = 0,
  onToggleCollapsed,
  onReturnFocus,
}: {
  bandKey: ProjectBandKey;
  headerId: string;
  label: string;
  itemCount: number;
  collapsed: boolean;
  collapsible: boolean;
  sortMode: OtherProjectsSortMode;
  onSortModeChange: (mode: OtherProjectsSortMode) => void;
  /** Set on a user-made group: adds its rename/move/delete actions. */
  group?: ProjectGroup;
  /** Agents running in the band — said on the header only while it is folded. */
  activeAgentCount?: number;
  /** Projects whose assistant is working — said beside the agents, same rule. */
  workingAssistantCount?: number;
  onToggleCollapsed: () => void;
  onReturnFocus?: () => void;
}) {
  const active = OTHER_PROJECTS_SORT_OPTIONS[sortMode];
  const ActiveIcon = active.Icon;
  const isOther = bandKey === "other";
  const sortLabel = isOther ? "other projects" : label;

  const handleValueChange = (value: string) => {
    if (isOtherProjectsSortMode(value)) onSortModeChange(value);
  };

  // Radix would restore focus to the trigger, which then eats ArrowDown and
  // Enter to reopen itself — leaving the palette unable to walk or commit a row
  // until focus moved by hand. The search box owns those keys, so send focus
  // back there. Deferred a frame: focusing inside Radix's own focus-restore
  // window loses the race with its teardown (same reason `ContentPanel`'s
  // rename input defers).
  //
  // Only focus left stranded is taken back. Rename and Delete open a dialog
  // that has claimed focus by the time this frame runs; pulling it back to the
  // search box would leave the keyboard typing behind a visible modal.
  const returnFocus = (event: Event) => {
    event.preventDefault();
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) onReturnFocus?.();
    });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="presentation"
          className={cn(
            PALETTE_SECTION_LABEL_CLASS,
            "group/band-header flex items-center justify-between gap-2 px-2 py-1 normal-case tracking-normal"
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {collapsible ? (
              <BandCollapseToggle
                collapsed={collapsed}
                label={label}
                labelId={headerId}
                controlsId={bandListId(bandKey)}
                testId={`band-collapse-toggle-${bandDomKey(bandKey)}`}
                onToggle={onToggleCollapsed}
                // A user-made group carries the folder its filing actions use,
                // so the sections the user made read apart from the ones the
                // switcher makes — same label, same rule, one quiet glyph.
                leadingIcon={
                  group ? (
                    <FolderClosed className="w-3 h-3 shrink-0" aria-hidden="true" />
                  ) : undefined
                }
              />
            ) : (
              <BandLabel label={label} labelId={headerId} />
            )}
            {collapsed && (activeAgentCount > 0 || workingAssistantCount > 0) && (
              // A folded group keeps its running projects in place rather than
              // lifting them out, so the header is the only thing left to say
              // they are there. Neutral words beside the run hue's own mark —
              // the same pairing a running row's status line uses. Assistants
              // are named apart from agents, as everywhere else: they are live
              // work, but not runs the user launched.
              <span
                className="flex min-w-0 items-center gap-1 text-text-secondary"
                data-testid={`band-running-rollup-${bandDomKey(bandKey)}`}
              >
                <span
                  className="workspace-mark h-1.5 w-1.5 shrink-0 rounded-full bg-activity-working"
                  aria-hidden="true"
                />
                <span className="truncate">
                  {formatFoldedLiveness(activeAgentCount, workingAssistantCount)}
                </span>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {group && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    tabIndex={-1}
                    data-testid={`band-group-menu-${bandDomKey(bandKey)}`}
                    aria-label={`${group.name} group actions`}
                    // Revealed with the header rather than always drawn: one
                    // control per group header, repeated down the list, would
                    // be a column of dots competing with the rows. Held, and
                    // lifted, while its own menu is open so the menu has a
                    // visible owner. Before the count rather than after it, so
                    // every header's right-hand count or sort still ends on the
                    // same edge. 24px square for the pointer target floor,
                    // pulled into the header's line so it doesn't grow it.
                    className={cn(
                      "-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-[opacity,background-color,color] duration-150 ease-out hover:text-text-primary",
                      "opacity-0 group-hover/band-header:opacity-100",
                      "data-[state=open]:opacity-100 data-[state=open]:bg-overlay-subtle data-[state=open]:text-text-primary"
                    )}
                  >
                    <Ellipsis className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={returnFocus}>
                  <ProjectGroupDropdownMenuItems group={group} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {collapsed && <BandCollapsedCount count={itemCount} />}
            {!collapsed && itemCount >= OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    tabIndex={-1}
                    data-testid={
                      isOther
                        ? "other-projects-sort-trigger"
                        : `band-sort-trigger-${bandDomKey(bandKey)}`
                    }
                    aria-label={`Sort ${sortLabel}, currently ${active.label}`}
                    className="flex shrink-0 items-center gap-1 text-text-secondary hover:text-text-primary transition-colors"
                  >
                    <ActiveIcon className="w-3 h-3" aria-hidden="true" />
                    {active.label}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={returnFocus}>
                  <DropdownMenuRadioGroup value={sortMode} onValueChange={handleValueChange}>
                    {OTHER_PROJECTS_SORT_MODES.map((value) => {
                      const { label: optionLabel, Icon } = OTHER_PROJECTS_SORT_OPTIONS[value];
                      return (
                        <DropdownMenuRadioItem key={value} value={value}>
                          <Icon className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                          {optionLabel}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      {/*
       * Right-click keeps the options reachable below the row threshold, where
       * the visible trigger hides itself — the order still applies there — and
       * is where a group's own actions live for anyone who never hovers.
       */}
      <ContextMenuContent>
        <ContextMenuRadioGroup value={sortMode} onValueChange={handleValueChange}>
          {OTHER_PROJECTS_SORT_MODES.map((value) => {
            const { label: optionLabel, Icon } = OTHER_PROJECTS_SORT_OPTIONS[value];
            return (
              <ContextMenuRadioItem key={value} value={value}>
                <Icon className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                {optionLabel}
              </ContextMenuRadioItem>
            );
          })}
        </ContextMenuRadioGroup>
        {group && (
          <>
            <ContextMenuSeparator />
            <ProjectGroupContextMenuItems group={group} />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * What an open group with nothing to show says instead of looking abandoned.
 * Hidden from assistive tech: it is not an option, it sits inside a listbox
 * that may only hold options, and the band's header already names the group.
 */
function EmptyGroupHint({ liftedCount }: { liftedCount: number }) {
  // Laid out on a row's own frame — the border, inset, status slot and tile
  // slot it would have — so the sentence starts on the column the project
  // names start on and reads as this group's content, not a stray note.
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-2 border border-transparent px-2 py-1.5 text-xs text-text-secondary"
      data-testid="empty-group-hint"
    >
      <span className="w-2 shrink-0" />
      <span className="w-8 shrink-0" />
      <span className="min-w-0 truncate">
        {liftedCount > 0
          ? `${pluralize(liftedCount, "project")} shown above`
          : "Right-click a project and choose Move to group"}
      </span>
    </div>
  );
}

interface ProjectListContentProps {
  results: ProjectSwitcherRow[];
  /**
   * Every browse band, including ones the user folded away — those contribute
   * no rows to `results`, so their headers have nowhere else to come from.
   * Absent (a surface driving the list by hand) falls back to reading the bands
   * off `results`, which is the same view whenever nothing is collapsed.
   */
  browseBands?: ProjectSwitcherBrowseBand[];
  selectedIndex: number;
  query: string;
  onSelect: (row: ProjectSwitcherRow, source?: ProjectSwitchSelectSource) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Whether this surface offers "Open project…" — decides what the empty state can name. */
  canAddProject: boolean;
  /**
   * Whether the Scratch band below this list offers a create row. It decides
   * which action an empty list is allowed to name — the modal mounts without
   * the project commands but keeps Scratch, so pointing at the File menu there
   * sent the reader out of the app past a button two rows down.
   */
  canCreateScratch: boolean;
  /**
   * True when browse has scratches but no projects, which makes the Scratch
   * band the palette's first content. The instructional empty state stands down
   * for it — printed above real rows it contradicts them.
   */
  scratchesStandAlone: boolean;
  /**
   * Other hosts matched even though this one did not. Their band renders below
   * this list, so a "No workspaces match" here would sit above real results.
   */
  hasOtherHostResults: boolean;
  /**
   * This window's host, said beside a project whose name another host also
   * lists, so the two copies can be told apart. Null when nothing collides.
   */
  sharedNameHost?: { hostName: string; names: ReadonlySet<string> } | null;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onSleepProject?: (projectId: string) => void;
  onRestartProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
  /**
   * Moves the palette's one cursor to the row under the pointer, so the row the
   * pointer lights is the row Enter commits. Fired on `pointermove`, never
   * `pointerenter`: rows scrolling under a resting pointer must not steal it.
   */
  onHoverRow?: (rowId: string) => void;
  /** Hands focus back to the search box after the sort menu closes. */
  onReturnFocus?: () => void;
}

export function ProjectListContent({
  results,
  browseBands,
  selectedIndex,
  query,
  onSelect,
  listRef,
  canAddProject,
  canCreateScratch,
  scratchesStandAlone,
  hasOtherHostResults,
  sharedNameHost,
  onStopProject,
  onCloseProject,
  onSleepProject,
  onRestartProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
  onHoverRow,
  onReturnFocus,
}: ProjectListContentProps) {
  const isSearching = query.trim().length > 0;

  // Mounted here, once for the whole list, rather than per row: sixty timers in
  // a hundred-project list would all fire for the same reason. It has to be a
  // component that renders the rows, too — the clock is state, so a tick re-runs
  // THIS body and the changed `nowMs` is what invalidates each auto-memoized
  // row. A tick held at the palette root re-renders the root and stops there.
  const nowMs = useGlobalMinuteClock();

  // Bands are contiguous runs of `results`, never a re-filter of it. The hook
  // has already sorted by section, so walking the array once and cutting where
  // `section` changes reproduces the grouping without building a second,
  // narrower list — the thing that stranded the highlight and let Enter commit
  // an off-screen project (#11071). Every row in every band is still a row of
  // `results`, at the same index the arrow keys use.
  const sections = useMemo<ProjectSection[] | null>(() => {
    if (isSearching) return null;

    const bands: ProjectSection[] = [];
    for (const row of results) {
      // Browse is projects only — scratches ride the pinned section below. A
      // non-project row here would mean that changed, so drop the whole band
      // layout rather than skipping the row: the flat branch still renders
      // everything, where dropping one would strand the highlight on a row that
      // isn't on screen (#11071).
      if (row.kind !== "project") return null;
      const last = bands.at(-1);
      if (last && last.key === row.section) {
        last.items.push(row);
        last.itemCount += 1;
      } else {
        bands.push({
          key: row.section,
          // A group band read off `results` has no name to show — only the
          // declared bands carry one — and this fallback is never the path a
          // real switcher takes once groups exist.
          label: isGroupBandKey(row.section) ? "" : PROJECT_SECTION_LABELS[row.section],
          items: [row],
          itemCount: 1,
          collapsed: false,
          collapsible: false,
        });
      }
    }

    if (!browseBands || browseBands.length === 0) return bands.length > 0 ? bands : null;

    // A repeated key passes the order walk below — the second copy simply draws
    // no rows — but React keys, the `aria-labelledby` leaf id and the
    // `aria-controls` target are all derived from it, so the duplicate would
    // collide on all three.
    if (new Set(browseBands.map((band) => band.key)).size !== browseBands.length) return null;

    // The declared bands own the ORDER, the HEADERS and the counts; the runs
    // above own the rows, and they keep owning them — metadata never removes a
    // row. A band declared folded is expected to have contributed nothing to
    // `results` in the first place, so its items come out empty on their own.
    const byKey = new Map(bands.map((band) => [band.key, band]));
    const merged: ProjectSection[] = browseBands.map((band) => {
      const rendered = byKey.get(band.key);
      byKey.delete(band.key);
      return {
        key: band.key,
        label: band.label,
        items: rendered?.items ?? [],
        itemCount: band.itemCount,
        collapsed: band.collapsed,
        collapsible: true,
        group: band.group,
        liftedCount: band.liftedCount,
        activeAgentCount: band.activeAgentCount,
        workingAssistantCount: band.workingAssistantCount,
      };
    });

    // The one check that makes the bands a VIEW over `results` rather than a
    // claim about it: walked in order, they must reproduce `results` exactly.
    // Enumerating the ways two props can disagree misses some — a section key
    // appearing in two non-adjacent runs, a declared order that differs from
    // the row order, a stale count — and each of those either hides a row or
    // puts the DOM in an order the arrow keys don't follow, which is #11071
    // again. Any mismatch drops to the flat branch: a list with no headers
    // looks worse and is correct.
    let cursor = 0;
    for (const band of merged) {
      for (const row of band.items) {
        if (results[cursor] !== row) return null;
        cursor += 1;
      }
    }
    if (cursor !== results.length) return null;
    return merged;
  }, [results, isSearching, browseBands]);

  // `results` is already scoped by the hook to exactly the rows this mode
  // renders, so it doubles as the arrow-key domain. Never re-filter it here:
  // a second, narrower array is what stranded the highlight and let Enter
  // commit an off-screen project (#11071).
  const selectedRowId = results[selectedIndex]?.id;

  const setBandCollapsed = usePreferencesStore((state) => state.setProjectSwitcherBandCollapsed);
  const otherSortMode = usePreferencesStore((state) => state.projectSwitcherOtherSortMode);
  const setOtherSortMode = usePreferencesStore((state) => state.setProjectSwitcherOtherSortMode);
  const setGroupSortMode = useProjectGroupsStore((state) => state.setGroupSortMode);

  const hasBands = sections !== null && sections.length > 0;

  const renderItem = (row: ProjectSwitcherRow) => {
    const isSelected = row.id === selectedRowId;
    return (
      <div key={`${row.kind}-${row.id}`} role="presentation">
        {row.kind === "scratch" ? (
          <ScratchListItem
            scratch={row}
            isSelected={isSelected}
            nowMs={nowMs}
            showCurrentLabel={!hasBands}
            onSelect={onSelect}
            onHoverRow={onHoverRow}
          />
        ) : (
          <ProjectListItem
            project={row}
            isSelected={isSelected}
            nowMs={nowMs}
            // Band membership is frozen while the palette is open, so a
            // project that became active mid-session can sit under another
            // header; only the "Current project" band makes the label redundant.
            showCurrentLabel={!hasBands || row.section !== "current"}
            // Said wherever no header already says it: the ranked list has no
            // headers at all, and a member drawn outside its own group's band —
            // current, asking, pinned, or archived — would otherwise lose the
            // one fact that says where it is filed.
            showGroupLabel={
              !hasBands || (row.groupId !== undefined && row.section !== groupBandKey(row.groupId))
            }
            inBands={hasBands}
            hostName={
              sharedNameHost?.names.has(row.name.toLocaleLowerCase())
                ? sharedNameHost.hostName
                : undefined
            }
            onSelect={onSelect}
            onStopProject={onStopProject}
            onCloseProject={onCloseProject}
            onSleepProject={onSleepProject}
            onRestartProject={onRestartProject}
            onLocateProject={onLocateProject}
            onMoveOrRenameProject={onMoveOrRenameProject}
            onTogglePinProject={onTogglePinProject}
            onCopyPath={onCopyPath}
            onSelectNewWindow={onSelectNewWindow}
            onHoverProject={onHoverProject}
            onHoverProjectEnd={onHoverProjectEnd}
            onHoverRow={onHoverRow}
            onReturnFocus={onReturnFocus}
          />
        )}
      </div>
    );
  };

  return (
    <>
      <div ref={listRef} id="project-list" role="listbox" aria-label="Workspaces">
        {sections && sections.length > 0 ? (
          sections.map((section, sectionIdx) => {
            const headerId = `project-section-${bandDomKey(section.key)}`;
            const listId = bandListId(section.key);
            const toggle = () => setBandCollapsed(section.key, !section.collapsed);

            // Bands wrap options, so they can't be bare `div`s inside the
            // listbox: each is a `group` named by its own visible header. Every
            // band carries one now that `current` is labelled (#11692), which
            // is also what keeps this legal — an unnamed `group` is an ARIA
            // violation, so a band without a header would have to flatten away.
            return (
              <div key={section.key} role="presentation">
                {sectionIdx > 0 && <AppPaletteDialog.Divider />}
                <div
                  role="group"
                  aria-labelledby={headerId}
                  /*
                   * One value on all four bands. The first/last overrides used
                   * to buy the run of bands some end padding, but the scroller
                   * carries that now — and while they were here a folded last
                   * band sat 8px below its own label and 4px above it, which is
                   * exactly the lopsided gap a collapsed band makes obvious.
                   */
                  className="px-1 py-1"
                >
                  {section.key === "other" || section.group ? (
                    <SortableBandHeader
                      bandKey={section.key}
                      headerId={headerId}
                      label={section.label}
                      itemCount={section.itemCount}
                      collapsed={section.collapsed}
                      collapsible={section.collapsible}
                      sortMode={section.group ? section.group.sortMode : otherSortMode}
                      onSortModeChange={(mode) => {
                        if (section.group) void setGroupSortMode(section.group.id, mode);
                        else setOtherSortMode(mode);
                      }}
                      group={section.group}
                      activeAgentCount={section.activeAgentCount}
                      workingAssistantCount={section.workingAssistantCount}
                      onToggleCollapsed={toggle}
                      onReturnFocus={onReturnFocus}
                    />
                  ) : (
                    <div
                      className={cn(
                        PALETTE_SECTION_LABEL_CLASS,
                        // `px-2` matches the row padding below rather than the
                        // wrapper's old inset: both now start from the bare band
                        // edge, so the label and the rows' status column share
                        // the palette's 12px rail (#11943).
                        "flex items-center justify-between gap-2 px-2 py-1"
                      )}
                    >
                      {section.collapsible ? (
                        <BandCollapseToggle
                          collapsed={section.collapsed}
                          label={section.label}
                          labelId={headerId}
                          controlsId={listId}
                          testId={`band-collapse-toggle-${bandDomKey(section.key)}`}
                          onToggle={toggle}
                        />
                      ) : (
                        <BandLabel label={section.label} labelId={headerId} />
                      )}
                      {section.collapsed && <BandCollapsedCount count={section.itemCount} />}
                    </div>
                  )}
                  {/*
                    Stays mounted while collapsed, holding no options. The
                    header's `aria-controls` has to resolve to something, and an
                    element that comes and goes would leave it dangling on every
                    fold.
                  */}
                  <div id={listId}>
                    {section.items.map(renderItem)}
                    {section.group && !section.collapsed && section.items.length === 0 && (
                      <EmptyGroupHint liftedCount={section.liftedCount ?? 0} />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        ) : results.length === 0 ? (
          scratchesStandAlone || hasOtherHostResults ? null : (
            // The family's empty state rather than a local one, so this palette
            // says "nothing matched" the way every other does: same type, a
            // debounced polite announcement, and the Esc hint that turns the
            // dead end into one keypress back.
            <div data-testid="project-empty-state">
              <AppPaletteDialog.Empty
                query={query}
                // "Workspaces", not "projects": scratches are ranked into this
                // same list now, so naming only half of what was searched would
                // read as a scratch still being findable somewhere else.
                noMatchMessage={`No workspaces match "${query.trim()}"`}
                noMatchContent={<PaletteNoMatchHint what="all workspaces" />}
                emptyMessage={
                  canAddProject
                    ? // Names the button sitting directly below this list.
                      "Open a project to get started"
                    : canCreateScratch
                      ? // No project commands on this surface, but Scratch is
                        // still here — so the nearest action is the create row.
                        "Create a scratch workspace to get started"
                      : // Nothing on this surface can open anything, so the only
                        // honest instruction points outside it.
                        "Open a project from the File menu to get started"
                }
              />
            </div>
          )
        ) : (
          <div className="px-1 py-1" role="presentation">
            {results.map((project) => renderItem(project))}
          </div>
        )}
      </div>
    </>
  );
}
