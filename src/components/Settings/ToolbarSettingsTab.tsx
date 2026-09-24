import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Ellipsis, GripVertical } from "lucide-react";
import { useToolbarPreferencesStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { AnyToolbarButtonId, LauncherItemToolbarButtonId } from "@/../../shared/types/toolbar";
// `@shared/...` because these are value imports — the type-only spelling above
// is erased at compile time and never has to resolve at runtime.
import {
  LAUNCHER_PANEL_BUTTON_IDS,
  isLauncherItemToolbarButtonId,
  isLauncherPanelButtonId,
} from "@shared/types/toolbar";
import {
  subscribeToPanelKindRegistry,
  getPanelKindRegistrySnapshot,
} from "@shared/config/panelKindRegistry";
import {
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
} from "@shared/config/pluginAgentRegistry";
import { useRecipeStore } from "@/store/recipeStore";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { resolveLauncherItemMetadata } from "@/components/Layout/launcherToolbarCatalog";
import { LAUNCHABLE_AGENT_IDS, isBuiltInAgentId } from "@shared/config/agentIds";
import {
  TOOLBAR_BUTTON_METADATA,
  getToolbarButtonGroup,
  type ToolbarButtonMetadata,
} from "@/components/Layout/toolbarButtonMetadata";
import {
  getGroupedInsertionIndex,
  orderToolbarButtonsByGroup,
  stepToolbarButton,
} from "@/components/Layout/toolbarButtonGrouping";
import { getAgentConfig } from "@/config/agents";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";

import { buildPluginToolbarMeta } from "@/components/Layout/pluginToolbarMeta";
import { cn } from "@/lib/utils";
import { DRAG_GHOST_OPACITY, EASE_OUT_EXPO, UI_ANIMATION_DURATION } from "@/lib/animationUtils";
import {
  isToolbarButtonOnToolbar,
  setToolbarButtonOnToolbar,
  type ToolbarButtonPlacementState,
} from "@/lib/toolbarVisibilityDispatch";
import { makeSortableAnnouncements } from "@/components/DragDrop/sortableAnnouncements";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

type ToolbarSide = "left" | "right";

type AllMetadata = Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>;

interface SideLists {
  left: AnyToolbarButtonId[];
  right: AnyToolbarButtonId[];
}

/**
 * Which list a toggled row stays in until the page is left. A switch flipped
 * off in the side columns keeps its row there (off), and one flipped on under
 * "Not on the toolbar" keeps its row there (on), so the control the user just
 * pressed never jumps sections under the pointer.
 */
type RowHome = "arrangement" | "pool";

// dnd-kit ids are `UniqueIdentifier` (string | number); toolbar button ids are
// a string subset. Narrow in one place so the unavoidable assertion lives here.
function toButtonId(id: UniqueIdentifier): AnyToolbarButtonId {
  return id as AnyToolbarButtonId;
}

function switchLabel(label: string): string {
  return `Show ${label} on the toolbar`;
}

interface ToolbarButtonCardProps {
  buttonId: AnyToolbarButtonId;
  /** Only on the live row — the drag overlay renders the same card and must not repeat the id. */
  switchId?: string;
  metadata: ToolbarButtonMetadata;
  isVisible: boolean;
  onToggle?: () => void;
  /** Spread onto the grip handle — attributes + listeners from `useSortable`. */
  gripProps?: Record<string, unknown>;
  draggable: boolean;
  /** The non-drag route to the same moves the grip offers (WCAG 2.2 SC 2.5.7). */
  moves?: ButtonMoves;
}

interface ButtonMoves {
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onMoveAcross: () => void;
  acrossLabel: string;
}

function ToolbarButtonMoveMenu({
  buttonId,
  label,
  moves,
}: {
  buttonId: string;
  label: string;
  moves: ButtonMoves;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Move ${label}`}
          data-move-trigger={buttonId}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]",
            "text-text-secondary hover:bg-overlay-soft hover:text-text-primary transition-colors",
            "data-[state=open]:bg-overlay-soft data-[state=open]:text-text-primary",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          )}
        >
          <Ellipsis className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuItem disabled={!moves.onMoveUp} onSelect={() => moves.onMoveUp?.()}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!moves.onMoveDown} onSelect={() => moves.onMoveDown?.()}>
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={moves.onMoveAcross}>{moves.acrossLabel}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Presentational row shared by the sortable list and the drag overlay. It
// never calls `useSortable` so it is safe to render inside `DragOverlay`
// (which mounts outside any `SortableContext`).
function ToolbarButtonCard({
  buttonId,
  switchId,
  metadata,
  isVisible,
  onToggle,
  gripProps,
  draggable,
  moves,
}: ToolbarButtonCardProps) {
  const Icon = metadata.icon;

  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-2.5">
          {/* A row that can't move keeps the grip's slot but not the grip, so every
              icon and label in the column stays on one rail. When interactive,
              gripProps carries dnd-kit's role/tabIndex/describedby — the grip must
              stay in the accessibility tree and needs an accessible name. */}
          {draggable ? (
            <span
              {...(gripProps ?? {})}
              // The colour sits on the wrapper, not the SVG: forced colours keep an
              // SVG's own colour (`preserve-parent-color`), so a class on the glyph
              // would stay theme grey in high-contrast mode.
              className="shrink-0 cursor-grab rounded-[var(--radius-sm)] text-text-secondary outline-offset-2 active:cursor-grabbing"
              aria-hidden={gripProps ? undefined : true}
              aria-label={gripProps ? `Reorder ${metadata.label}` : undefined}
            >
              <GripVertical aria-hidden="true" className="h-4 w-4" />
            </span>
          ) : (
            <span className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{metadata.label}</span>
        </span>
      }
      labelText={metadata.label}
      control={
        <>
          {moves ? (
            <ToolbarButtonMoveMenu buttonId={buttonId} label={metadata.label} moves={moves} />
          ) : (
            // Same width as the menu trigger, so every switch sits on one rail.
            <span className="h-6 w-6 shrink-0" aria-hidden="true" />
          )}
          <SettingsSwitch
            id={switchId}
            checked={isVisible}
            onCheckedChange={() => onToggle?.()}
            aria-label={switchLabel(metadata.label)}
          />
        </>
      }
    />
  );
}

interface SortableButtonItemProps {
  buttonId: AnyToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: AnyToolbarButtonId) => void;
  allMetadata: AllMetadata;
  moves?: ButtonMoves;
}

function SortableButtonItem({
  buttonId,
  isVisible,
  onToggle,
  allMetadata,
  moves,
}: SortableButtonItemProps) {
  const metadata = allMetadata[buttonId];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: buttonId,
    disabled: !isVisible,
  });

  // Keep the dnd-kit transform/transition/opacity on this single node (the
  // drag-source). Nesting a second transform-holding wrapper would fight the
  // sortable transform — see #9029. A button that is merely off keeps full
  // opacity: off is a setting, not a disabled row, and the switch says which.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? DRAG_GHOST_OPACITY : 1,
  };

  if (!metadata) return null;

  return (
    <div ref={setNodeRef} style={style}>
      <ToolbarButtonCard
        buttonId={buttonId}
        switchId={columnSwitchId(buttonId)}
        metadata={metadata}
        isVisible={isVisible}
        onToggle={() => onToggle(buttonId)}
        gripProps={{ ...attributes, ...listeners }}
        draggable={isVisible}
        // Off buttons don't drag either — the menu offers exactly what the grip does.
        moves={isVisible ? moves : undefined}
      />
    </div>
  );
}

interface PoolButtonRowProps {
  buttonId: AnyToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: AnyToolbarButtonId) => void;
  metadata: ToolbarButtonMetadata | undefined;
  /** Only where it adds something the label doesn't — which plugin a button came from. */
  showDescription?: boolean;
}

// A button that is not on the toolbar: no position to show, so no grip and no
// move menu — just its identity and the switch that puts it back. Reusing
// `SortableButtonItem` would call `useSortable` outside a `SortableContext` and
// crash; this is a plain non-sortable row.
function PoolButtonRow({
  buttonId,
  isVisible,
  onToggle,
  metadata,
  showDescription = false,
}: PoolButtonRowProps) {
  if (!metadata) return null;
  const Icon = metadata.icon;

  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{metadata.label}</span>
        </span>
      }
      labelText={metadata.label}
      description={showDescription ? metadata.description : undefined}
      onRowClick={() => onToggle(buttonId)}
      control={({ descriptionId }) => (
        <SettingsSwitch
          id={poolSwitchId(buttonId)}
          checked={isVisible}
          onCheckedChange={() => onToggle(buttonId)}
          aria-label={switchLabel(metadata.label)}
          aria-describedby={descriptionId}
        />
      )}
    />
  );
}

interface ToolbarSideColumnProps {
  id: string;
  side: ToolbarSide;
  label: string;
  /** Every id on this side, hidden ones included — the drag handlers write the whole array back. */
  buttonIds: AnyToolbarButtonId[];
  /** The rows this column draws: the buttons on the toolbar, plus any switched off this visit. */
  rendersRow: (id: AnyToolbarButtonId) => boolean;
  allMetadata: AllMetadata;
  isOnToolbar: (id: AnyToolbarButtonId) => boolean;
  onToggle: (buttonId: AnyToolbarButtonId, side: ToolbarSide) => void;
  getMoves: (buttonId: AnyToolbarButtonId, side: ToolbarSide) => ButtonMoves;
}

function ToolbarSideColumn({
  id,
  side,
  label,
  buttonIds,
  rendersRow,
  allMetadata,
  isOnToolbar,
  onToggle,
  getMoves,
}: ToolbarSideColumnProps) {
  // The column id doubles as a droppable target so an empty side still accepts
  // a cross-side drop (a `SortableContext` registers no droppable of its own
  // when it holds zero items).
  const { setNodeRef, isOver } = useDroppable({ id: side });
  // Only what renders. An id with no live metadata — an uninstalled plugin's
  // button the user had dragged here, or a launcher item belonging to another
  // project (#12217) — draws nothing, and neither does a button that is off.
  // The ids stay in `buttonIds` regardless: the drag handlers write the whole
  // array back, so filtering the list itself would drop them on the next
  // reorder.
  const renderedIds = buttonIds.filter((id) => allMetadata[id] !== undefined && rendersRow(id));
  const onCount = renderedIds.filter(isOnToolbar).length;

  return (
    <div id={id} ref={setNodeRef} className="min-w-0 scroll-mt-6">
      <SortableContext items={buttonIds} strategy={rectSortingStrategy}>
        <SettingsGroup
          label={`${label} · ${onCount} ${onCount === 1 ? "button" : "buttons"}`}
          className={cn("min-h-12", isOver && "ring-1 ring-inset ring-border-strong")}
        >
          {renderedIds.length === 0 ? (
            <SettingsEmptyRow>Drag a button here or use its menu</SettingsEmptyRow>
          ) : (
            renderedIds.map((buttonId) => (
              <SortableButtonItem
                key={buttonId}
                buttonId={buttonId}
                isVisible={isOnToolbar(buttonId)}
                onToggle={(id) => onToggle(id, side)}
                allMetadata={allMetadata}
                moves={getMoves(buttonId, side)}
              />
            ))
          )}
        </SettingsGroup>
      </SortableContext>
    </div>
  );
}

function columnSwitchId(id: AnyToolbarButtonId): string {
  return `toolbar-column-${id}`;
}

function poolSwitchId(id: AnyToolbarButtonId): string {
  return `toolbar-pool-${id}`;
}

// Radix Select reserves the empty string for "no value", so "no default" needs its own token.
const NO_DEFAULT_SELECTION = "none";

const dropAnimation = {
  duration: UI_ANIMATION_DURATION,
  easing: EASE_OUT_EXPO,
};

function withoutDuplicates(ids: readonly AnyToolbarButtonId[]): AnyToolbarButtonId[] {
  return Array.from(new Set(ids));
}

export function ToolbarSettingsTab() {
  const layout = useToolbarPreferencesStore((s) => s.layout);
  const launcher = useToolbarPreferencesStore((s) => s.launcher);
  const setLeftButtons = useToolbarPreferencesStore((s) => s.setLeftButtons);
  const setRightButtons = useToolbarPreferencesStore((s) => s.setRightButtons);
  const moveButton = useToolbarPreferencesStore((s) => s.moveButton);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);
  const setPluginButtonPromoted = useToolbarPreferencesStore((s) => s.setPluginButtonPromoted);
  const setPanelButtonOnToolbar = useToolbarPreferencesStore((s) => s.setPanelButtonOnToolbar);
  const setLauncherItemOnToolbar = useToolbarPreferencesStore((s) => s.setLauncherItemOnToolbar);
  const positionAgentButton = useToolbarPreferencesStore((s) => s.positionAgentButton);
  const setAlwaysShowDevServer = useToolbarPreferencesStore((s) => s.setAlwaysShowDevServer);
  const setDefaultSelection = useToolbarPreferencesStore((s) => s.setDefaultSelection);
  const reset = useToolbarPreferencesStore((s) => s.reset);

  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const agentAvailability = useCliAvailabilityStore((s) => s.availability);

  // In-flight side lists while a drag is active. `null` between drags so we
  // re-render straight off the store; during a cross-side drag this holds the
  // speculative placement that drives the gap animation.
  const [dragState, setDragState] = useState<SideLists | null>(null);
  const [activeId, setActiveId] = useState<AnyToolbarButtonId | null>(null);
  const [showUninstalledAgents, setShowUninstalledAgents] = useState(false);
  const [rowHomes, setRowHomes] = useState<ReadonlyMap<AnyToolbarButtonId, RowHome>>(
    () => new Map()
  );
  // Where focus goes once a change unmounts the control that had it: a move
  // across sides remounts the row under the other column, and unpinning a
  // launcher item removes its row. Tried in order; the first that exists wins.
  const [focusTargets, setFocusTargets] = useState<readonly string[] | null>(null);

  useEffect(() => {
    if (focusTargets === null) return;
    // After the menu's own close, which tries to restore focus to a trigger
    // that no longer exists.
    const frame = requestAnimationFrame(() => {
      for (const selector of focusTargets) {
        const target = document.querySelector<HTMLElement>(selector);
        if (target) {
          target.focus();
          break;
        }
      }
      setFocusTargets(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTargets]);
  const uninstalledAgentListId = useId();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = usePluginToolbarButtons();

  // The launcher stays the one place anything gets pinned (#12217); this page's
  // job for those rows is to show what the user pinned so they can find it,
  // reorder it and unpin it — the same job it does for a promoted plugin
  // button. So it enumerates the pin map, not a second copy of the launcher's
  // inventory, which would also drag the panel definition registry and the
  // action service into a settings tab.
  //
  // An id whose source is not currently here — an uninstalled plugin, a deleted
  // recipe, a recipe belonging to another project — resolves to no metadata and
  // renders nothing, matching the toolbar's own registry gate. Its pin is left
  // alone rather than swept: "not live in this project" is not "gone".
  const recipes = useRecipeStore((s) => s.recipes);
  const currentProjectId = useRecipeStore((s) => s.currentProjectId);
  // `resolveLauncherItemMetadata` reads both registries, so the rows have to
  // re-derive when either mutates. Without these the tab keeps a stale label,
  // icon and row for a plugin panel or agent that unloaded while Settings was
  // open, while the toolbar — which does subscribe — has already dropped it.
  const panelKindRegistry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const pluginAgentRegistry = useSyncExternalStore(
    subscribeToPluginAgentRegistry,
    getPluginAgentRegistrySnapshot,
    getPluginAgentRegistrySnapshot
  );
  // The plugin snapshot is only one of the three tiers `getAgentConfig` merges;
  // a user-defined agent lives here, so without this its row keeps a stale name
  // and icon after an edit.
  const userAgentRegistry = useUserAgentRegistryStore((s) => s.registry);
  const launcherItemMetadata = useMemo(() => {
    // Referenced, not merely listed as dependencies. `resolveLauncherItemMetadata`
    // reads both registries itself, so these snapshots exist only to invalidate
    // this memo when one mutates — and a value the body never mentions is one
    // the React Compiler is free to drop, which would restore the stale row
    // they are here to prevent.
    void panelKindRegistry;
    void pluginAgentRegistry;
    void userAgentRegistry;
    const entries: Array<[LauncherItemToolbarButtonId, ToolbarButtonMetadata]> = [];
    // `Object.entries` plus the guard rather than a filter over `Object.keys`:
    // both hand back a bare `string`, but only the guard narrows it, and the
    // filtering form would need an assertion per access — which the lint
    // ratchet scores per rule.
    for (const [id, isPinned] of Object.entries(layout.pinnedButtons)) {
      if (isPinned !== true) continue;
      if (!isLauncherItemToolbarButtonId(id)) continue;
      const metadata = resolveLauncherItemMetadata(id, recipes, currentProjectId);
      if (metadata) entries.push([id, metadata]);
    }
    return Object.fromEntries(entries);
  }, [
    layout.pinnedButtons,
    recipes,
    currentProjectId,
    panelKindRegistry,
    pluginAgentRegistry,
    userAgentRegistry,
  ]);

  const resolveGroup = useCallback(
    (id: AnyToolbarButtonId) => getToolbarButtonGroup(id, pluginConfigs.has(id)),
    [pluginConfigs]
  );

  // Both sides of the toolbar render grouped (#11681) — launcher, agents,
  // panels, then the rest — so both columns show the same order; otherwise they
  // would invite the user to arrange a row the toolbar will never draw.
  const groupedLeft = useMemo(
    () => orderToolbarButtonsByGroup(layout.leftButtons, resolveGroup),
    [layout.leftButtons, resolveGroup]
  );

  // A promoted plugin button with no stored position still gets a slot: the
  // toolbar appends it on the right. Listing it here is what lets the user see
  // and move it; its position is only persisted once they do.
  const groupedRight = useMemo(() => {
    const positioned = new Set([...layout.leftButtons, ...layout.rightButtons]);
    const unpositioned = pluginButtonIds.filter(
      (id) => !positioned.has(id) && layout.pinnedButtons[id] === true
    );
    return orderToolbarButtonsByGroup(
      withoutDuplicates([...layout.rightButtons, ...unpositioned]),
      resolveGroup
    );
  }, [
    layout.leftButtons,
    layout.rightButtons,
    layout.pinnedButtons,
    pluginButtonIds,
    resolveGroup,
  ]);

  const liveLeft = dragState?.left ?? groupedLeft;
  const liveRight = dragState?.right ?? groupedRight;

  const allMetadata = useMemo(
    () =>
      ({
        ...TOOLBAR_BUTTON_METADATA,
        ...buildPluginToolbarMeta(pluginButtonIds, pluginConfigs),
        ...launcherItemMetadata,
      }) as AllMetadata,
    [pluginButtonIds, pluginConfigs, launcherItemMetadata]
  );

  const getToolbarButtonLabel = useCallback(
    (id: UniqueIdentifier) => allMetadata[toButtonId(id)]?.label,
    [allMetadata]
  );
  const toolbarButtonAnnouncements = useMemo(
    () => makeSortableAnnouncements(getToolbarButtonLabel, "toolbar button"),
    [getToolbarButtonLabel]
  );

  const placementState: ToolbarButtonPlacementState = useMemo(
    () => ({
      pinnedButtons: layout.pinnedButtons,
      leftButtons: layout.leftButtons,
      rightButtons: layout.rightButtons,
      agentSettings,
      agentAvailability,
      isPluginContribution: (id) => pluginConfigs.has(id),
    }),
    [
      layout.pinnedButtons,
      layout.leftButtons,
      layout.rightButtons,
      agentSettings,
      agentAvailability,
      pluginConfigs,
    ]
  );

  // The one "is it on the toolbar" answer for every kind of button, read
  // through the resolver that owns its category — the same one the toolbar's
  // right-click menu reads (#12355), so the two surfaces can't disagree.
  const isOnToolbar = useCallback(
    (id: AnyToolbarButtonId) => isToolbarButtonOnToolbar(id, placementState),
    [placementState]
  );

  // Every button has exactly one switch on the page. A button on the toolbar is
  // in its column — unless it was just switched on from the list below, where
  // it stays until the user moves on — and a row switched off in a column
  // stays there, off.
  const inArrangement = (id: AnyToolbarButtonId) =>
    rowHomes.get(id) === "arrangement" || (isOnToolbar(id) && rowHomes.get(id) !== "pool");
  // Anything without a column row lands in the list below: including a button
  // that reads as on but has no slot (a promoted panel button whose position a
  // sibling view's write dropped), and a slotless plugin button just demoted,
  // whose column row has nowhere left to render.
  const hasColumnRow = (id: AnyToolbarButtonId) =>
    (groupedLeft.includes(id) || groupedRight.includes(id)) && inArrangement(id);
  const inPool = (id: AnyToolbarButtonId) => rowHomes.get(id) === "pool" || !hasColumnRow(id);

  // Rows switched on from the list below move up into their columns once the
  // user is done there: the pointer has left the section and focus isn't in it.
  // A switch that still has focus hands it to the same button's column switch.
  const poolSectionRef = useRef<HTMLDivElement>(null);
  const settlePoolRows = () => {
    const settling = [...rowHomes].filter(([, home]) => home === "pool").map(([id]) => id);
    if (settling.length === 0) return;
    const focused = settling.find(
      (id) => document.activeElement?.id === poolSwitchId(id) && isOnToolbar(id)
    );
    if (focused) setFocusTargets([`#${window.CSS.escape(columnSwitchId(focused))}`]);
    setRowHomes((prev) => new Map([...prev].filter(([, home]) => home !== "pool")));
  };

  const rememberHome = (id: AnyToolbarButtonId, home: RowHome) => {
    setRowHomes((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, home);
      return next;
    });
  };

  const findContainer = (id: UniqueIdentifier, lists: SideLists): ToolbarSide | null => {
    if (id === "left" || id === "right") return id;
    const buttonId = toButtonId(id);
    if (lists.left.includes(buttonId)) return "left";
    if (lists.right.includes(buttonId)) return "right";
    return null;
  };

  // Prefer pointer-based hit testing (precise at the two-group boundary) and
  // fall back to closest-corners when the pointer sits in neither column —
  // closestCenter jitters at horizontal edges.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerHits = pointerWithin(args);
    return pointerHits.length > 0 ? pointerHits : closestCorners(args);
  }, []);

  const setSide = (side: ToolbarSide, ids: AnyToolbarButtonId[]) =>
    side === "left" ? setLeftButtons(ids) : setRightButtons(ids);

  // `moveButton` splices out of the stored array, so a button shown on the right
  // only because it is promoted (no stored slot yet) needs one before it can move.
  const ensureStoredOnRight = (id: AnyToolbarButtonId) => {
    if (!layout.rightButtons.includes(id) && groupedRight.includes(id)) {
      setRightButtons(groupedRight);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(toButtonId(event.active.id));
    setDragState({ left: groupedLeft, right: groupedRight });
  };

  // Speculatively relocate the dragged button across columns so the target's
  // gap animation renders live. Same-column moves are left to the sortable
  // strategy and committed in `handleDragEnd`.
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeButtonId = toButtonId(active.id);

    setDragState((prev) => {
      const base = prev ?? { left: groupedLeft, right: groupedRight };
      const activeContainer = findContainer(active.id, base);
      const overContainer = findContainer(over.id, base);
      if (!activeContainer || !overContainer || activeContainer === overContainer) {
        return base;
      }

      const overItems = base[overContainer];
      const overIndex = overItems.indexOf(toButtonId(over.id));

      let newIndex: number;
      if (over.id === overContainer) {
        newIndex = overItems.length;
      } else {
        // Rows stack vertically, so "after" is decided on the vertical axis: the
        // dragged row's centre below the hovered row's centre.
        const translated = active.rect.current.translated;
        const isAfterOver =
          translated != null &&
          translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2;
        newIndex = overIndex >= 0 ? overIndex + (isAfterOver ? 1 : 0) : overItems.length;
      }

      const relocated = [
        ...overItems.slice(0, newIndex),
        activeButtonId,
        ...overItems.slice(newIndex),
      ];

      return {
        ...base,
        [activeContainer]: base[activeContainer].filter((id) => id !== activeButtonId),
        // Regroup live so the gap opens where the button will actually land —
        // dropping a panel among the agents snaps it into the panel block
        // during the drag rather than jumping after the release.
        [overContainer]: orderToolbarButtonsByGroup(relocated, resolveGroup),
      };
    });
  };

  const clearDrag = () => {
    setDragState(null);
    setActiveId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const activeButtonId = toButtonId(active.id);

    if (!over) {
      clearDrag();
      return;
    }

    const live = dragState ?? { left: groupedLeft, right: groupedRight };
    const overContainer = findContainer(over.id, live);
    const originalContainer: ToolbarSide | null = groupedLeft.includes(activeButtonId)
      ? "left"
      : groupedRight.includes(activeButtonId)
        ? "right"
        : null;

    if (!overContainer || !originalContainer) {
      clearDrag();
      return;
    }

    if (originalContainer === overContainer) {
      // Same-side reorder — `onDragOver` leaves same-side drags untouched, so
      // the dragged item is still in its original slot here; reorder toward
      // the hovered item.
      const items = live[overContainer];
      const oldIndex = items.indexOf(activeButtonId);
      const newIndex =
        over.id === overContainer ? items.length - 1 : items.indexOf(toButtonId(over.id));
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
        clearDrag();
        return;
      }
      // Regroup before writing: a drag across a group boundary snaps back into
      // the button's own group, and a drop that only crossed a boundary
      // therefore changes nothing — skip the write rather than churn persist.
      const grouped = orderToolbarButtonsByGroup(
        arrayMove(items, oldIndex, newIndex),
        resolveGroup
      );
      const current = overContainer === "left" ? groupedLeft : groupedRight;
      const unchanged =
        grouped.length === current.length && grouped.every((id, i) => id === current[i]);
      if (!unchanged) setSide(overContainer, grouped);
    } else {
      // Cross-side move — `onDragOver` already relocated the item into the
      // target list at its drop position, so its index in `dragState` IS the
      // final target index. Re-running `arrayMove` here would invert it.
      if (live[overContainer].indexOf(activeButtonId) === -1) {
        clearDrag();
        return;
      }
      if (originalContainer === "right") ensureStoredOnRight(activeButtonId);
      // `moveButton` splices into the stored array, which may still be
      // interleaved, so a grouped index can't be handed over directly —
      // translate it into one that survives grouping (#11681).
      const stored =
        overContainer === "left"
          ? useToolbarPreferencesStore.getState().layout.leftButtons
          : useToolbarPreferencesStore.getState().layout.rightButtons;
      moveButton(
        activeButtonId,
        originalContainer,
        overContainer,
        getGroupedInsertionIndex(stored, live[overContainer], activeButtonId, resolveGroup)
      );
    }

    clearDrag();
  };

  const handleDragCancel = (_event: DragCancelEvent) => {
    clearDrag();
  };

  // Routed through the same helper as the toolbar's own right-click menu
  // (#12355), so the two surfaces cannot disagree about which setter owns an id.
  const handleToggle = (buttonId: AnyToolbarButtonId, side: ToolbarSide) => {
    setToolbarButtonOnToolbar(
      buttonId,
      side,
      !isToolbarButtonOnToolbar(buttonId, placementState),
      placementState,
      {
        setAgentPinned,
        toggleButtonVisibility,
        positionAgentButton,
        setPluginButtonPromoted,
        setPanelButtonOnToolbar,
        setLauncherItemOnToolbar,
      }
    );
  };

  // The same moves a drag can make, as menu items: up and down step past the
  // neighbouring button on the toolbar (only within the button's own group,
  // which is all a drag can achieve either), and across lands at the end of the
  // button's group on the other side, exactly as a drop there would.
  const getMoves = (buttonId: AnyToolbarButtonId, side: ToolbarSide): ButtonMoves => {
    const list = side === "left" ? groupedLeft : groupedRight;
    // Step past buttons the toolbar actually draws. Stepping past a hidden id
    // would reorder the arrays while changing nothing the user can see.
    const isOnToolbarRow = (id: AnyToolbarButtonId) =>
      allMetadata[id] !== undefined && isOnToolbar(id);
    const stepTo = (offset: -1 | 1) => {
      const next = stepToolbarButton(list, buttonId, offset, isOnToolbarRow, resolveGroup);
      if (!next) return undefined;
      return () => setSide(side, next);
    };
    const across: ToolbarSide = side === "left" ? "right" : "left";

    return {
      onMoveUp: stepTo(-1),
      onMoveDown: stepTo(1),
      acrossLabel: side === "left" ? "Move to right side" : "Move to left side",
      onMoveAcross: () => {
        setFocusTargets([`[data-move-trigger="${window.CSS.escape(buttonId)}"]`]);
        if (side === "right") ensureStoredOnRight(buttonId);
        const target = across === "left" ? groupedLeft : groupedRight;
        const projected = orderToolbarButtonsByGroup([...target, buttonId], resolveGroup);
        const stored = useToolbarPreferencesStore.getState().layout;
        moveButton(
          buttonId,
          side,
          across,
          getGroupedInsertionIndex(
            across === "left" ? stored.leftButtons : stored.rightButtons,
            projected,
            buttonId,
            resolveGroup
          )
        );
      },
    };
  };

  // A switched-off row normally stays put (its home is remembered), but some
  // switches take the row with them — unpinning a launcher item or demoting an
  // unpositioned plugin button drops the id from the list. Focus goes to the
  // row's own switch if it survived, else to its neighbour.
  const handleColumnToggle = (buttonId: AnyToolbarButtonId, side: ToolbarSide) => {
    const list = side === "left" ? groupedLeft : groupedRight;
    const rendered = list.filter((id) => allMetadata[id] !== undefined && inArrangement(id));
    const at = rendered.indexOf(buttonId);
    const neighbours = [rendered[at + 1], rendered[at - 1]].filter(
      (id): id is AnyToolbarButtonId => id !== undefined
    );
    setFocusTargets([
      `#${window.CSS.escape(columnSwitchId(buttonId))}`,
      `#${window.CSS.escape(poolSwitchId(buttonId))}`,
      ...neighbours.map((id) => `#${window.CSS.escape(columnSwitchId(id))}`),
      '#toolbar-left-buttons [role="switch"]',
      '#toolbar-right-buttons [role="switch"]',
      '#toolbar-hidden-buttons [role="switch"]',
      '#toolbar-launcher [role="switch"]',
    ]);
    rememberHome(buttonId, "arrangement");
    handleToggle(buttonId, side);
  };

  const handlePoolToggle = (buttonId: AnyToolbarButtonId, side: ToolbarSide) => {
    rememberHome(buttonId, "pool");
    handleToggle(buttonId, side);
  };

  const activeMetadata = activeId ? allMetadata[activeId] : undefined;

  // Everything not on the toolbar, by kind. Built-ins and panels come off the
  // side arrays or the fixed panel list; agents and plugin buttons off their
  // registries, since an unpinned one usually has no position at all.
  const poolAgents = LAUNCHABLE_AGENT_IDS.filter(inPool);
  // The inventory rule: agents whose CLI isn't on this machine are the healthy
  // remainder, disclosed on request. One the user toggled this visit stays out.
  const isUninstalledAgent = (id: AnyToolbarButtonId) =>
    agentAvailability != null &&
    (agentAvailability[id] === undefined || agentAvailability[id] === "missing") &&
    !rowHomes.has(id);
  const uninstalledAgentCount = poolAgents.filter(isUninstalledAgent).length;
  const listedPoolAgents = showUninstalledAgents
    ? poolAgents
    : poolAgents.filter((id) => !isUninstalledAgent(id));
  const poolPanels = LAUNCHER_PANEL_BUTTON_IDS.filter(inPool);
  const poolPlugins = pluginButtonIds.filter(inPool);
  const poolBuiltIns = withoutDuplicates([...groupedLeft, ...groupedRight]).filter(
    (id) =>
      !isBuiltInAgentId(id) &&
      !isLauncherPanelButtonId(id) &&
      !isLauncherItemToolbarButtonId(id) &&
      !pluginConfigs.has(id) &&
      allMetadata[id] !== undefined &&
      inPool(id)
  );
  const hasPool =
    poolAgents.length + poolPanels.length + poolPlugins.length + poolBuiltIns.length > 0;
  const sideOf = (id: AnyToolbarButtonId): ToolbarSide =>
    layout.leftButtons.includes(id) ? "left" : "right";

  const defaultSelectionOptions = [
    { value: NO_DEFAULT_SELECTION, label: "None (first available)" },
    { value: "terminal", label: "Terminal" },
    ...LAUNCHABLE_AGENT_IDS.map((id) => ({ value: id, label: getAgentConfig(id)?.name ?? id })),
    { value: "browser", label: "Browser" },
    { value: "dev-server", label: "Dev preview" },
  ];

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Toolbar buttons"
        description="Drag a button, or use its menu, to reorder it or move it to the other side. Each side keeps its groups in order: launcher, agents, panels, then the rest."
      >
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          accessibility={{ announcements: toolbarButtonAnnouncements }}
        >
          {/* Side by side while each column still fits a full label beside its
              controls; stacked below that, so a narrow dialog never pushes a
              name under the switch. */}
          <div className="@container/toolbar-columns">
            <div className="grid grid-cols-1 gap-4 @min-[36rem]/toolbar-columns:grid-cols-2">
              <ToolbarSideColumn
                id="toolbar-left-buttons"
                side="left"
                label="Left side"
                buttonIds={liveLeft}
                rendersRow={inArrangement}
                allMetadata={allMetadata}
                isOnToolbar={isOnToolbar}
                onToggle={handleColumnToggle}
                getMoves={getMoves}
              />
              <ToolbarSideColumn
                id="toolbar-right-buttons"
                side="right"
                label="Right side"
                buttonIds={liveRight}
                rendersRow={inArrangement}
                allMetadata={allMetadata}
                isOnToolbar={isOnToolbar}
                onToggle={handleColumnToggle}
                getMoves={getMoves}
              />
            </div>
          </div>
          <DragOverlay dropAnimation={dropAnimation}>
            {activeId && activeMetadata ? (
              <SettingsGroup className="shadow-md cursor-grabbing">
                <ToolbarButtonCard
                  buttonId={activeId}
                  metadata={activeMetadata}
                  isVisible={isOnToolbar(activeId)}
                  draggable
                />
              </SettingsGroup>
            ) : null}
          </DragOverlay>
        </DndContext>
      </SettingsSection>

      {/*
        Everything with no toolbar button, in one place, so each button has
        exactly one row on the page: on the toolbar it is in a column above,
        off it is here. Agents and panels still list every id regardless of the
        side arrays — since #11680 and v13 a fresh profile holds none of the
        agents and neither `browser` nor `dev-server` (#11667), and the
        launcher's "Customize toolbar…" footer has to land on a page where every
        one of them can be pinned.
      */}
      {hasPool && (
        <div
          ref={poolSectionRef}
          onPointerLeave={() => {
            if (!poolSectionRef.current?.contains(document.activeElement)) settlePoolRows();
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && poolSectionRef.current?.contains(next)) return;
            if (!poolSectionRef.current?.matches(":hover")) settlePoolRows();
          }}
        >
          <SettingsSection
            id="toolbar-hidden-buttons"
            title="Not on the toolbar"
            description="Switch one on to give it a toolbar button. Agents and panels stay in the launcher either way, and plugin buttons in the plugin tray."
          >
            {poolAgents.length > 0 && (
              <SettingsGroup label="Agents" id={uninstalledAgentListId}>
                {listedPoolAgents.map((buttonId) => (
                  <PoolButtonRow
                    key={buttonId}
                    buttonId={buttonId}
                    isVisible={isOnToolbar(buttonId)}
                    onToggle={(id) => handlePoolToggle(id, "left")}
                    metadata={allMetadata[buttonId]}
                  />
                ))}
                {uninstalledAgentCount > 0 && (
                  <div>
                    <button
                      type="button"
                      aria-expanded={showUninstalledAgents}
                      aria-controls={uninstalledAgentListId}
                      onClick={() => setShowUninstalledAgents((v) => !v)}
                      className={cn(
                        "group flex w-full items-center gap-2 py-2.5 pl-4 pr-4 text-left",
                        "text-sm text-text-secondary hover:text-text-primary transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          "w-3.5 h-3.5 shrink-0 transition-transform duration-150",
                          showUninstalledAgents ? "rotate-90" : "rotate-0"
                        )}
                        aria-hidden="true"
                      />
                      {showUninstalledAgents
                        ? "Hide agents that aren't installed"
                        : `Show ${uninstalledAgentCount} ${uninstalledAgentCount === 1 ? "agent" : "agents"} that aren't installed`}
                    </button>
                  </div>
                )}
              </SettingsGroup>
            )}
            {poolPanels.length > 0 && (
              <SettingsGroup label="Panels">
                {poolPanels.map((buttonId) => (
                  <PoolButtonRow
                    key={buttonId}
                    buttonId={buttonId}
                    isVisible={isOnToolbar(buttonId)}
                    onToggle={(id) => handlePoolToggle(id, "left")}
                    metadata={allMetadata[buttonId]}
                  />
                ))}
              </SettingsGroup>
            )}
            {poolPlugins.length > 0 && (
              <SettingsGroup label="Plugin buttons">
                {poolPlugins.map((buttonId) => (
                  <PoolButtonRow
                    key={buttonId}
                    buttonId={buttonId}
                    isVisible={isOnToolbar(buttonId)}
                    onToggle={(id) => handlePoolToggle(id, "right")}
                    metadata={allMetadata[buttonId]}
                    showDescription
                  />
                ))}
              </SettingsGroup>
            )}
            {poolBuiltIns.length > 0 && (
              <SettingsGroup label="Other buttons">
                {poolBuiltIns.map((buttonId) => (
                  <PoolButtonRow
                    key={buttonId}
                    buttonId={buttonId}
                    isVisible={isOnToolbar(buttonId)}
                    onToggle={(id) => handlePoolToggle(id, sideOf(id))}
                    metadata={allMetadata[buttonId]}
                  />
                ))}
              </SettingsGroup>
            )}
          </SettingsSection>
        </div>
      )}

      <SettingsSection id="toolbar-launcher" title="Launcher palette">
        <SettingsGroup>
          <SettingsSwitchCard
            title="Always show dev server in launcher"
            subtitle="Show dev server option even if no command is configured in project settings"
            isEnabled={launcher.alwaysShowDevServer}
            onChange={() => setAlwaysShowDevServer(!launcher.alwaysShowDevServer)}
            isModified={launcher.alwaysShowDevServer}
            onReset={() => setAlwaysShowDevServer(false)}
          />
          <SettingsSelect
            label="Default selection"
            description="Option highlighted when the launcher palette opens"
            value={launcher.defaultSelection ?? NO_DEFAULT_SELECTION}
            onValueChange={(value) =>
              setDefaultSelection(
                value === NO_DEFAULT_SELECTION
                  ? undefined
                  : (value as typeof launcher.defaultSelection)
              )
            }
            options={defaultSelectionOptions}
            isModified={launcher.defaultSelection !== undefined}
            onReset={() => setDefaultSelection(undefined)}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsGroup id="toolbar-reset" className="scroll-mt-6">
        <SettingsRow
          label="Reset toolbar"
          description="Restores the default buttons, order and launcher palette options"
          control={({ labelId, descriptionId, disabled }) => (
            <Button
              type="button"
              variant="ghost-danger"
              size="sm"
              onClick={reset}
              disabled={disabled}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
            >
              Reset
            </Button>
          )}
        />
      </SettingsGroup>
    </div>
  );
}
