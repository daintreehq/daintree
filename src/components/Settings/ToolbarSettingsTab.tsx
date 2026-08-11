import { useCallback, useMemo, useState } from "react";
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
import { GripVertical, LayoutGrid, Rocket, RotateCcw } from "lucide-react";
import { LayoutPanelTop, Plus } from "@/components/icons";
import { useToolbarPreferencesStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type {
  AnyToolbarButtonId,
  LauncherPanelButtonId,
  PluginToolbarButtonId,
} from "@/../../shared/types/toolbar";
// `@shared/...` because these are value imports — the type-only spelling above
// is erased at compile time and never has to resolve at runtime.
import {
  LAUNCHER_PANEL_BUTTON_IDS,
  isPanelButtonOnToolbar,
  isLauncherPanelButtonId,
} from "@shared/types/toolbar";
import { LAUNCHABLE_AGENT_IDS, isBuiltInAgentId } from "@shared/config/agentIds";
import { isAgentButtonOnToolbar } from "../../../shared/utils/agentPinned";
import {
  TOOLBAR_BUTTON_METADATA,
  getToolbarButtonGroup,
  isToolbarButtonVisible,
  type ToolbarButtonMetadata,
} from "@/components/Layout/toolbarButtonMetadata";
import {
  getGroupedInsertionIndex,
  orderToolbarButtonsByGroup,
} from "@/components/Layout/toolbarButtonGrouping";
import { getAgentConfig } from "@/config/agents";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { DEFAULT_PLUGIN_ICON } from "@/components/icons/pluginIconRegistry";
import { buildPluginToolbarMeta } from "@/components/Layout/pluginToolbarMeta";
import { cn } from "@/lib/utils";
import { DRAG_GHOST_OPACITY, EASE_OUT_EXPO, UI_ANIMATION_DURATION } from "@/lib/animationUtils";
import { dispatchToolbarVisibility } from "@/lib/toolbarVisibilityDispatch";
import { makeSortableAnnouncements } from "@/components/DragDrop/sortableAnnouncements";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

type ToolbarSide = "left" | "right";

type AllMetadata = Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>;

interface SideLists {
  left: AnyToolbarButtonId[];
  right: AnyToolbarButtonId[];
}

// dnd-kit ids are `UniqueIdentifier` (string | number); toolbar button ids are
// a string subset. Narrow in one place so the unavoidable assertion lives here.
function toButtonId(id: UniqueIdentifier): AnyToolbarButtonId {
  return id as AnyToolbarButtonId;
}

// Plugin button ids are namespaced `{pluginId}.{buttonId}` by main, so the dot
// is structural — this narrows without an unsafe assertion.
function isPluginToolbarButtonId(id: AnyToolbarButtonId): id is PluginToolbarButtonId {
  return id.includes(".");
}

interface ToolbarButtonCardProps {
  metadata: ToolbarButtonMetadata;
  isVisible: boolean;
  onToggle?: () => void;
  /** Spread onto the grip handle — attributes + listeners from `useSortable`. */
  gripProps?: Record<string, unknown>;
  draggable: boolean;
  /** Rendered inside `DragOverlay` — drops the live opacity/transition chrome. */
  isOverlay?: boolean;
}

// Presentational chip shared by the sortable rows and the drag overlay. It
// never calls `useSortable` so it is safe to render inside `DragOverlay`
// (which mounts outside any `SortableContext`).
function ToolbarButtonCard({
  metadata,
  isVisible,
  onToggle,
  gripProps,
  draggable,
  isOverlay,
}: ToolbarButtonCardProps) {
  const Icon = metadata.icon;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 transition-colors",
        isOverlay && "shadow-md bg-daintree-bg cursor-grabbing"
      )}
    >
      {/* When draggable, gripProps carries dnd-kit's role/tabIndex/describedby —
          the grip must stay in the accessibility tree (aria-hidden on a
          focusable element is an axe violation) and needs an accessible name. */}
      <div
        {...(draggable && gripProps ? gripProps : {})}
        className={cn(
          draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
          "shrink-0"
        )}
        aria-hidden={draggable && gripProps ? undefined : true}
        aria-label={draggable && gripProps ? `Reorder ${metadata.label}` : undefined}
      >
        <GripVertical
          aria-hidden="true"
          className={cn("h-4 w-4", draggable ? "text-daintree-text/50" : "text-daintree-text/20")}
        />
      </div>
      <div className="text-daintree-text shrink-0">
        <Icon className="h-4 w-4" />
      </div>
      <span className="text-sm font-medium text-daintree-text truncate min-w-0 flex-1">
        {metadata.label}
      </span>
      <SettingsSwitch
        checked={isVisible}
        onCheckedChange={() => onToggle?.()}
        aria-label={`Toggle ${metadata.label} visibility`}
        className="shrink-0"
      />
    </div>
  );
}

interface SortableButtonItemProps {
  buttonId: AnyToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: AnyToolbarButtonId) => void;
  allMetadata: AllMetadata;
}

function SortableButtonItem({
  buttonId,
  isVisible,
  onToggle,
  allMetadata,
}: SortableButtonItemProps) {
  const metadata = allMetadata[buttonId];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: buttonId,
    disabled: !isVisible,
  });

  // Keep the dnd-kit transform/transition/opacity on this single node (the
  // drag-source). Nesting a second transform-holding wrapper would fight the
  // sortable transform — see #9029.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? DRAG_GHOST_OPACITY : isVisible ? 1 : 0.5,
  };

  if (!metadata) return null;

  return (
    <div ref={setNodeRef} style={style} className="shrink-0">
      <ToolbarButtonCard
        metadata={metadata}
        isVisible={isVisible}
        onToggle={() => onToggle(buttonId)}
        gripProps={{ ...attributes, ...listeners }}
        draggable={isVisible}
      />
    </div>
  );
}

interface TrayButtonRowProps {
  buttonId: AnyToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: AnyToolbarButtonId) => void;
  metadata: ToolbarButtonMetadata | undefined;
}

// Tray-backed buttons toggle promotion, not visibility — they always remain
// reachable in their tray, whether that's the plugin tray (#11304) or the panel
// tray (#11667). A plugin contribution is never persisted into the position
// arrays at all, and a panel button may or may not be, so neither gets a drag
// handle or takes part in cross-side movement. Reusing `SortableButtonItem`
// would call `useSortable` outside a `SortableContext` and crash; this is a
// plain non-sortable row.
function TrayButtonRow({ buttonId, isVisible, onToggle, metadata }: TrayButtonRowProps) {
  if (!metadata) return null;
  const Icon = metadata.icon;

  return (
    <div
      style={{ opacity: isVisible ? 1 : 0.5 }}
      className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30"
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="text-daintree-text shrink-0">
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-daintree-text truncate">{metadata.label}</div>
          <div className="text-xs text-daintree-text/50 select-text truncate">
            {metadata.description}
          </div>
        </div>
      </div>
      <SettingsSwitch
        checked={isVisible}
        onCheckedChange={() => onToggle(buttonId)}
        aria-label={`Show ${metadata.label} in toolbar`}
        className="shrink-0"
      />
    </div>
  );
}

interface ToolbarSideColumnProps {
  side: ToolbarSide;
  label: string;
  buttonIds: AnyToolbarButtonId[];
  allMetadata: AllMetadata;
  isVisible: (id: AnyToolbarButtonId) => boolean;
  onToggle: (buttonId: AnyToolbarButtonId, side: ToolbarSide) => void;
}

function ToolbarSideColumn({
  side,
  label,
  buttonIds,
  allMetadata,
  isVisible,
  onToggle,
}: ToolbarSideColumnProps) {
  // The column id doubles as a droppable target so an empty side still accepts
  // a cross-side drop (a `SortableContext` registers no droppable of its own
  // when it holds zero items).
  const { setNodeRef, isOver } = useDroppable({ id: side });
  const visibleCount = buttonIds.filter(isVisible).length;

  return (
    <div className="flex-1 min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-daintree-text/60">
          {label}
        </span>
        <span className="text-xs text-daintree-text/40 tabular-nums">
          {visibleCount}/{buttonIds.length}
        </span>
      </div>
      <SortableContext items={buttonIds} strategy={rectSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            "flex flex-wrap content-start gap-2 rounded-[var(--radius-md)] bg-overlay-subtle p-2 min-h-[4rem] transition-colors",
            isOver && "ring-1 ring-inset ring-daintree-border"
          )}
        >
          {buttonIds.length === 0 ? (
            <div className="flex w-full items-center justify-center py-3 text-xs text-daintree-text/30">
              Drop a button here
            </div>
          ) : (
            buttonIds.map((buttonId) => (
              <SortableButtonItem
                key={buttonId}
                buttonId={buttonId}
                isVisible={isVisible(buttonId)}
                onToggle={(id) => onToggle(id, side)}
                allMetadata={allMetadata}
              />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  );
}

const dropAnimation = {
  duration: UI_ANIMATION_DURATION,
  easing: EASE_OUT_EXPO,
};

export function ToolbarSettingsTab() {
  const layout = useToolbarPreferencesStore((s) => s.layout);
  const launcher = useToolbarPreferencesStore((s) => s.launcher);
  const setLeftButtons = useToolbarPreferencesStore((s) => s.setLeftButtons);
  const setRightButtons = useToolbarPreferencesStore((s) => s.setRightButtons);
  const moveButton = useToolbarPreferencesStore((s) => s.moveButton);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);
  const setPluginButtonPromoted = useToolbarPreferencesStore((s) => s.setPluginButtonPromoted);
  const setPanelButtonOnToolbar = useToolbarPreferencesStore((s) => s.setPanelButtonOnToolbar);
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

  const liveRight = dragState?.right ?? layout.rightButtons;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = usePluginToolbarButtons();

  const resolveGroup = useCallback(
    (id: AnyToolbarButtonId) => getToolbarButtonGroup(id, pluginConfigs.has(id)),
    [pluginConfigs]
  );

  // The left toolbar renders its buttons grouped (#11681), so this column has
  // to show the same order — otherwise it would invite the user to arrange a
  // row the toolbar will never draw. The right side has no groups and stays in
  // persisted order.
  const groupedLeft = useMemo(
    () => orderToolbarButtonsByGroup(layout.leftButtons, resolveGroup),
    [layout.leftButtons, resolveGroup]
  );

  const liveLeft = dragState?.left ?? groupedLeft;

  const allMetadata = useMemo(
    () =>
      ({
        ...TOOLBAR_BUTTON_METADATA,
        ...buildPluginToolbarMeta(pluginButtonIds, pluginConfigs),
      }) as AllMetadata,
    [pluginButtonIds, pluginConfigs]
  );

  const getToolbarButtonLabel = useCallback(
    (id: UniqueIdentifier) => allMetadata[toButtonId(id)]?.label,
    [allMetadata]
  );
  const toolbarButtonAnnouncements = useMemo(
    () => makeSortableAnnouncements(getToolbarButtonLabel, "toolbar button"),
    [getToolbarButtonLabel]
  );

  const isVisible = useCallback(
    (id: AnyToolbarButtonId) =>
      isToolbarButtonVisible(
        id,
        layout.pinnedButtons,
        agentSettings,
        agentAvailability,
        pluginConfigs.has(id)
      ),
    [layout.pinnedButtons, agentSettings, agentAvailability, pluginConfigs]
  );

  // Launcher panel buttons need the array-aware resolver, not `isVisible`: since
  // v13 `browser`/`dev-server` carry no pin entry on a fresh profile, so
  // `isToolbarButtonVisible`'s "absent means visible" default would report both
  // as on while neither is anywhere on the toolbar (#11667). Inside the side
  // columns the two agree — a column only ever renders ids the arrays already
  // hold — but the panel section below lists all four regardless.
  const isPanelOnToolbar = useCallback(
    (id: LauncherPanelButtonId) =>
      isPanelButtonOnToolbar(id, layout.pinnedButtons, layout.leftButtons, layout.rightButtons),
    [layout.pinnedButtons, layout.leftButtons, layout.rightButtons]
  );

  // Agents need one for the same reason since #11680: `isAgentToolbarVisible`
  // resolves an unset pin to "the binary is installed", which no longer implies
  // a toolbar slot now that agent ids left `DEFAULT_LEFT_BUTTONS`. The launcher
  // reads through this same resolver, so the two surfaces can't disagree about
  // which agents are on the toolbar.
  const isAgentOnToolbar = useCallback(
    (id: AnyToolbarButtonId) =>
      isAgentButtonOnToolbar(
        agentSettings?.agents?.[id],
        agentAvailability?.[id],
        layout.leftButtons.includes(id) || layout.rightButtons.includes(id)
      ),
    [agentSettings, agentAvailability, layout.leftButtons, layout.rightButtons]
  );

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

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(toButtonId(event.active.id));
    setDragState({ left: groupedLeft, right: layout.rightButtons });
  };

  // Speculatively relocate the dragged button across columns so the target's
  // gap animation renders live. Same-column moves are left to the sortable
  // strategy and committed in `handleDragEnd`.
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeButtonId = toButtonId(active.id);

    setDragState((prev) => {
      const base = prev ?? { left: groupedLeft, right: layout.rightButtons };
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
        const translatedRight = active.rect.current.translated?.right;
        const isAfterOver =
          translatedRight != null && translatedRight > over.rect.left + over.rect.width / 2;
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
        // Regroup the left column live so the gap opens where the button will
        // actually land — dropping a panel among the agents snaps it into the
        // panel block during the drag rather than jumping after the release.
        [overContainer]:
          overContainer === "left"
            ? orderToolbarButtonsByGroup(relocated, resolveGroup)
            : relocated,
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

    const live = dragState ?? { left: groupedLeft, right: layout.rightButtons };
    const overContainer = findContainer(over.id, live);
    const originalContainer: ToolbarSide | null = layout.leftButtons.includes(activeButtonId)
      ? "left"
      : layout.rightButtons.includes(activeButtonId)
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
      const reordered = arrayMove(items, oldIndex, newIndex);
      if (overContainer === "left") {
        // Regroup before writing: a drag across a group boundary snaps back
        // into the button's own group, and a drop that only crossed a boundary
        // therefore changes nothing — skip the write rather than churn persist.
        const grouped = orderToolbarButtonsByGroup(reordered, resolveGroup);
        const unchanged =
          grouped.length === groupedLeft.length && grouped.every((id, i) => id === groupedLeft[i]);
        if (!unchanged) {
          setLeftButtons(grouped);
        }
      } else {
        setRightButtons(reordered);
      }
    } else {
      // Cross-side move — `onDragOver` already relocated the item into the
      // target list at its drop position, so its index in `dragState` IS the
      // final target index. Re-running `arrayMove` here would invert it.
      if (live[overContainer].indexOf(activeButtonId) === -1) {
        clearDrag();
        return;
      }
      // `moveButton` splices into the stored array, which may still be
      // interleaved, so a grouped index can't be handed over directly —
      // translate it into one that survives grouping (#11681).
      const toIndex =
        overContainer === "left"
          ? getGroupedInsertionIndex(layout.leftButtons, live.left, activeButtonId, resolveGroup)
          : live[overContainer].indexOf(activeButtonId);
      moveButton(activeButtonId, originalContainer, overContainer, toIndex);
    }

    clearDrag();
  };

  const handleDragCancel = (_event: DragCancelEvent) => {
    clearDrag();
  };

  const handleToggle = (buttonId: AnyToolbarButtonId, side: ToolbarSide) => {
    // A plugin id can still sit in a persisted side array (the v9 migration
    // deliberately keeps ids a user dragged there). Its switch has to route
    // through the promotion action: the generic toggle only alternates
    // `false`/absent, and under tray-default neither of those is promoted, so
    // the switch could never turn the button on (#11304).
    if (pluginConfigs.has(buttonId) && isPluginToolbarButtonId(buttonId)) {
      setPluginButtonPromoted(buttonId, !isVisible(buttonId));
      return;
    }
    // Launcher panel buttons need the same treatment for a different reason
    // (#11667). `browser` and `dev-server` are not defaults, so the generic
    // toggle's "delete the key to show" leaves nothing recording that the user
    // wants them — and a stale sibling view's write, which replaces the position
    // arrays wholesale, would then silently un-promote them with nothing left to
    // rebuild from. `setPanelButtonOnToolbar` writes the explicit `true` that
    // survives, and positions the button if it has no slot yet.
    if (isLauncherPanelButtonId(buttonId)) {
      setPanelButtonOnToolbar(buttonId, !isPanelOnToolbar(buttonId));
      return;
    }
    // The explicit next state comes from the array-aware resolver, not the
    // dispatcher's own `isAgentToolbarVisible` fallback: since #11680 an
    // installed-but-unpositioned agent reads as visible to that fallback while
    // rendering nothing, so the toggle would write `false` on a button the user
    // is trying to turn on. Non-agent ids ignore the argument.
    dispatchToolbarVisibility(
      buttonId,
      side,
      {
        agentSettings,
        agentAvailability,
        setAgentPinned,
        toggleButtonVisibility,
        positionAgentButton,
      },
      isBuiltInAgentId(buttonId) ? !isAgentOnToolbar(buttonId) : undefined
    );
  };

  const activeMetadata = activeId ? allMetadata[activeId] : undefined;

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={LayoutGrid}
        title="Toolbar buttons"
        description="Drag to reorder within a side or move a button between the left and right groups. Left-side buttons stay grouped as launcher, agents, panels, then everything else, so dragging one across a boundary snaps it back into its own group. Toggle to show or hide."
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
          <div className="flex flex-row gap-4">
            <ToolbarSideColumn
              side="left"
              label="Left side"
              buttonIds={liveLeft}
              allMetadata={allMetadata}
              isVisible={isVisible}
              onToggle={handleToggle}
            />
            <ToolbarSideColumn
              side="right"
              label="Right side"
              buttonIds={liveRight}
              allMetadata={allMetadata}
              isVisible={isVisible}
              onToggle={handleToggle}
            />
          </div>
          <DragOverlay dropAnimation={dropAnimation}>
            {activeId && activeMetadata ? (
              <ToolbarButtonCard
                metadata={activeMetadata}
                isVisible={isVisible(activeId)}
                draggable
                isOverlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </SettingsSection>

      {/*
        Its own section rather than relying on the two side columns above: those
        render `layout.leftButtons`/`layout.rightButtons`, and since #11680 no
        agent id is in either array on a fresh profile — the same reason the
        panel section below exists for `browser`/`dev-server` since v13 (#11667).
        Without this the launcher's "Customize toolbar…" footer would land the
        user on a page that lists none of the agents they were just looking at,
        leaving the launcher as the only place an agent can be pinned at all.
        Enumerating `LAUNCHABLE_AGENT_IDS` keeps the page honest regardless of
        array membership, the same way the plugin section does.
      */}
      <SettingsSection
        icon={Plus}
        title="Agent buttons"
        description={`Every agent lives in the launcher. Pin one to give it its own toolbar button too. ${LAUNCHABLE_AGENT_IDS.filter(isAgentOnToolbar).length} of ${LAUNCHABLE_AGENT_IDS.length} pinned.`}
      >
        <div className="space-y-2">
          {LAUNCHABLE_AGENT_IDS.map((buttonId) => (
            <TrayButtonRow
              key={buttonId}
              buttonId={buttonId}
              isVisible={isAgentOnToolbar(buttonId)}
              onToggle={(id) => handleToggle(id, "left")}
              metadata={allMetadata[buttonId]}
            />
          ))}
        </div>
      </SettingsSection>

      {/*
        Same reason as the agent section above: since v13 `browser` and
        `dev-server` are in neither array on a fresh profile (#11667), so the
        side columns can't be the only place these are listed. Enumerating
        `LAUNCHER_PANEL_BUTTON_IDS` keeps the page honest regardless of array
        membership.
      */}
      <SettingsSection
        icon={LayoutPanelTop}
        title="Panel buttons"
        description={`Every panel button lives in the launcher. Pin one to give it its own toolbar button too. ${LAUNCHER_PANEL_BUTTON_IDS.filter(isPanelOnToolbar).length} of ${LAUNCHER_PANEL_BUTTON_IDS.length} pinned.`}
      >
        <div className="space-y-2">
          {LAUNCHER_PANEL_BUTTON_IDS.map((buttonId) => (
            <TrayButtonRow
              key={buttonId}
              buttonId={buttonId}
              isVisible={isPanelOnToolbar(buttonId)}
              onToggle={(id) => handleToggle(id, "left")}
              metadata={allMetadata[buttonId]}
            />
          ))}
        </div>
      </SettingsSection>

      {pluginButtonIds.length > 0 && (
        <SettingsSection
          icon={DEFAULT_PLUGIN_ICON}
          title="Plugin buttons"
          description={`Every plugin button lives in the plugin tray. Promote one to give it its own toolbar button too. ${pluginButtonIds.filter((id) => isVisible(id)).length} of ${pluginButtonIds.length} promoted.`}
        >
          <div className="space-y-2">
            {pluginButtonIds.map((buttonId) => (
              <TrayButtonRow
                key={buttonId}
                buttonId={buttonId}
                isVisible={isVisible(buttonId)}
                onToggle={(id) => handleToggle(id, "right")}
                metadata={allMetadata[buttonId]}
              />
            ))}
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        icon={Rocket}
        title="Launcher palette"
        description="Configure defaults for the panel launcher palette."
      >
        <div className="space-y-4">
          <SettingsSwitchCard
            variant="compact"
            title="Always show dev server in launcher"
            subtitle="Show dev server option even if no command is configured in project settings"
            isEnabled={launcher.alwaysShowDevServer}
            onChange={() => setAlwaysShowDevServer(!launcher.alwaysShowDevServer)}
            ariaLabel="Always show dev server in launcher"
          />

          <div className="space-y-2">
            <label className="text-sm font-medium text-daintree-text block">
              Default selection
            </label>
            <select
              value={launcher.defaultSelection ?? ""}
              onChange={(e) =>
                setDefaultSelection(
                  e.target.value ? (e.target.value as typeof launcher.defaultSelection) : undefined
                )
              }
              className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent/40 focus:outline-hidden transition-colors"
            >
              <option value="">None (first available)</option>
              <option value="terminal">Terminal</option>
              {LAUNCHABLE_AGENT_IDS.map((id) => (
                <option key={id} value={id}>
                  {getAgentConfig(id)?.name ?? id}
                </option>
              ))}
              <option value="browser">Browser</option>
              <option value="dev-server">Dev Preview</option>
            </select>
            <p className="text-xs text-daintree-text/40 select-text">
              Default option to highlight when opening the launcher palette
            </p>
          </div>
        </div>
      </SettingsSection>

      <div className="flex justify-end">
        <button
          onClick={reset}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-daintree-border",
            "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/5 transition-colors"
          )}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset toolbar
        </button>
      </div>
    </div>
  );
}
