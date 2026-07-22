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
import { useToolbarPreferencesStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { AnyToolbarButtonId, PluginToolbarButtonId } from "@/../../shared/types/toolbar";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import {
  TOOLBAR_BUTTON_METADATA,
  isToolbarButtonVisible,
  type ToolbarButtonMetadata,
} from "@/components/Layout/toolbarButtonMetadata";
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

interface PluginButtonRowProps {
  buttonId: PluginToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: PluginToolbarButtonId) => void;
  metadata: ToolbarButtonMetadata | undefined;
}

// Plugin buttons toggle promotion, not visibility — they always remain
// reachable in the plugin tray (#11304), and they're never persisted into the
// position arrays, so they get no drag handle and stay out of cross-side
// movement. Reusing `SortableButtonItem` would call `useSortable` outside a
// `SortableContext` and crash; this is a plain non-sortable row.
function PluginButtonRow({ buttonId, isVisible, onToggle, metadata }: PluginButtonRowProps) {
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

  const liveLeft = dragState?.left ?? layout.leftButtons;
  const liveRight = dragState?.right ?? layout.rightButtons;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = usePluginToolbarButtons();

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
    setDragState({ left: layout.leftButtons, right: layout.rightButtons });
  };

  // Speculatively relocate the dragged button across columns so the target's
  // gap animation renders live. Same-column moves are left to the sortable
  // strategy and committed in `handleDragEnd`.
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeButtonId = toButtonId(active.id);

    setDragState((prev) => {
      const base = prev ?? { left: layout.leftButtons, right: layout.rightButtons };
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

      return {
        ...base,
        [activeContainer]: base[activeContainer].filter((id) => id !== activeButtonId),
        [overContainer]: [
          ...overItems.slice(0, newIndex),
          activeButtonId,
          ...overItems.slice(newIndex),
        ],
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

    const live = dragState ?? { left: layout.leftButtons, right: layout.rightButtons };
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
        setLeftButtons(reordered);
      } else {
        setRightButtons(reordered);
      }
    } else {
      // Cross-side move — `onDragOver` already relocated the item into the
      // target list at its drop position, so its index in `dragState` IS the
      // final target index. Re-running `arrayMove` here would invert it.
      const toIndex = live[overContainer].indexOf(activeButtonId);
      if (toIndex === -1) {
        clearDrag();
        return;
      }
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
    dispatchToolbarVisibility(buttonId, side, {
      agentSettings,
      agentAvailability,
      setAgentPinned,
      toggleButtonVisibility,
    });
  };

  const activeMetadata = activeId ? allMetadata[activeId] : undefined;

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={LayoutGrid}
        title="Toolbar buttons"
        description="Drag to reorder within a side or move a button between the left and right groups. Toggle to show or hide."
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

      {pluginButtonIds.length > 0 && (
        <SettingsSection
          icon={DEFAULT_PLUGIN_ICON}
          title="Plugin buttons"
          description={`Every plugin button lives in the plugin tray. Promote one to give it its own toolbar button too. ${pluginButtonIds.filter((id) => isVisible(id)).length} of ${pluginButtonIds.length} promoted.`}
        >
          <div className="space-y-2">
            {pluginButtonIds.map((buttonId) => (
              <PluginButtonRow
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
              className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent focus:outline-hidden transition-colors"
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
