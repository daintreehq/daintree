import { useCallback, useMemo } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, LayoutGrid, Rocket, RotateCcw } from "lucide-react";
import { useToolbarPreferencesStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import {
  TOOLBAR_BUTTON_METADATA,
  isToolbarButtonVisible,
  type ToolbarButtonMetadata,
} from "@/components/Layout/toolbarButtonMetadata";
import { getAgentConfig } from "@/config/agents";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { McpServerIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { DRAG_GHOST_OPACITY } from "@/lib/animationUtils";
import { dispatchToolbarVisibility } from "@/lib/toolbarVisibilityDispatch";
import { makeSortableAnnouncements } from "@/components/DragDrop/sortableAnnouncements";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

interface SortableButtonItemProps {
  buttonId: AnyToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: AnyToolbarButtonId) => void;
  allMetadata: Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>;
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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? DRAG_GHOST_OPACITY : isVisible ? 1 : 0.5,
  };

  if (!metadata) return null;
  const Icon = metadata.icon;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30"
    >
      <div
        {...(isVisible ? { ...attributes, ...listeners } : {})}
        className={cn(isVisible ? "cursor-grab active:cursor-grabbing" : "cursor-default")}
      >
        <GripVertical
          className={cn("h-4 w-4", isVisible ? "text-daintree-text/50" : "text-daintree-text/20")}
        />
      </div>
      <div className="flex items-center gap-2 flex-1">
        <div className="text-daintree-text">
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-daintree-text">{metadata.label}</div>
          <div className="text-xs text-daintree-text/50 select-text">{metadata.description}</div>
        </div>
      </div>
      <input
        type="checkbox"
        checked={isVisible}
        onChange={() => onToggle(buttonId)}
        aria-label={`Toggle ${metadata.label} visibility`}
        className="w-4 h-4 rounded border-border-strong bg-daintree-bg text-daintree-accent focus:ring-daintree-accent focus:ring-2"
      />
    </div>
  );
}

interface PluginButtonRowProps {
  buttonId: AnyToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: AnyToolbarButtonId) => void;
  metadata: ToolbarButtonMetadata | undefined;
}

// Plugin buttons are hide-only — they're never persisted into
// `layout.rightButtons`, so they get no drag handle. Reusing
// `SortableButtonItem` would call `useSortable` outside a `SortableContext`
// and crash; this is a plain non-sortable row mirroring its visual structure.
function PluginButtonRow({ buttonId, isVisible, onToggle, metadata }: PluginButtonRowProps) {
  if (!metadata) return null;
  const Icon = metadata.icon;

  return (
    <div
      style={{ opacity: isVisible ? 1 : 0.5 }}
      className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30"
    >
      <div className="flex items-center gap-2 flex-1">
        <div className="text-daintree-text">
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-daintree-text">{metadata.label}</div>
          <div className="text-xs text-daintree-text/50 select-text">{metadata.description}</div>
        </div>
      </div>
      <input
        type="checkbox"
        checked={isVisible}
        onChange={() => onToggle(buttonId)}
        aria-label={`Toggle ${metadata.label} visibility`}
        className="w-4 h-4 rounded border-border-strong bg-daintree-bg text-daintree-accent focus:ring-daintree-accent focus:ring-2"
      />
    </div>
  );
}

export function ToolbarSettingsTab() {
  const layout = useToolbarPreferencesStore((s) => s.layout);
  const launcher = useToolbarPreferencesStore((s) => s.launcher);
  const setLeftButtons = useToolbarPreferencesStore((s) => s.setLeftButtons);
  const setRightButtons = useToolbarPreferencesStore((s) => s.setRightButtons);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);
  const setAlwaysShowDevServer = useToolbarPreferencesStore((s) => s.setAlwaysShowDevServer);
  const setDefaultSelection = useToolbarPreferencesStore((s) => s.setDefaultSelection);
  const reset = useToolbarPreferencesStore((s) => s.reset);

  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const agentAvailability = useCliAvailabilityStore((s) => s.availability);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = usePluginToolbarButtons();

  const allMetadata = useMemo(() => {
    const pluginMeta: Record<string, ToolbarButtonMetadata> = {};
    for (const id of pluginButtonIds) {
      const config = pluginConfigs.get(id);
      if (config) {
        pluginMeta[id] = {
          label: config.label,
          icon: McpServerIcon,
          description: `Plugin button (${config.pluginId})`,
        };
      }
    }
    return { ...TOOLBAR_BUTTON_METADATA, ...pluginMeta };
  }, [pluginButtonIds, pluginConfigs]);

  const getToolbarButtonLabel = useCallback(
    (id: UniqueIdentifier) => {
      const meta = allMetadata as Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>;
      return meta[id as AnyToolbarButtonId]?.label;
    },
    [allMetadata]
  );
  const toolbarButtonAnnouncements = useMemo(
    () => makeSortableAnnouncements(getToolbarButtonLabel, "toolbar button"),
    [getToolbarButtonLabel]
  );

  const handleLeftDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = layout.leftButtons.indexOf(active.id as AnyToolbarButtonId);
    const newIndex = layout.leftButtons.indexOf(over.id as AnyToolbarButtonId);

    if (oldIndex === -1 || newIndex === -1) return;

    const newButtons = [...layout.leftButtons];
    newButtons.splice(oldIndex, 1);
    newButtons.splice(newIndex, 0, active.id as AnyToolbarButtonId);

    setLeftButtons(newButtons);
  };

  const handleRightDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = layout.rightButtons.indexOf(active.id as AnyToolbarButtonId);
    const newIndex = layout.rightButtons.indexOf(over.id as AnyToolbarButtonId);

    if (oldIndex === -1 || newIndex === -1) return;

    const newButtons = [...layout.rightButtons];
    newButtons.splice(oldIndex, 1);
    newButtons.splice(newIndex, 0, active.id as AnyToolbarButtonId);

    setRightButtons(newButtons);
  };

  const handleToggleLeft = (buttonId: AnyToolbarButtonId) =>
    dispatchToolbarVisibility(buttonId, "left", {
      agentSettings,
      agentAvailability,
      setAgentPinned,
      toggleButtonVisibility,
    });

  const handleToggleRight = (buttonId: AnyToolbarButtonId) =>
    dispatchToolbarVisibility(buttonId, "right", {
      agentSettings,
      agentAvailability,
      setAgentPinned,
      toggleButtonVisibility,
    });

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={LayoutGrid}
        title="Left side buttons"
        description={`Drag to reorder, uncheck to hide. ${layout.leftButtons.filter((id) => isToolbarButtonVisible(id, layout.pinnedButtons, agentSettings, agentAvailability)).length} of ${layout.leftButtons.length} visible.`}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleLeftDragEnd}
          accessibility={{ announcements: toolbarButtonAnnouncements }}
        >
          <SortableContext items={layout.leftButtons} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {layout.leftButtons.map((buttonId) => (
                <SortableButtonItem
                  key={buttonId}
                  buttonId={buttonId}
                  isVisible={isToolbarButtonVisible(
                    buttonId,
                    layout.pinnedButtons,
                    agentSettings,
                    agentAvailability
                  )}
                  onToggle={handleToggleLeft}
                  allMetadata={allMetadata}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </SettingsSection>

      <SettingsSection
        icon={LayoutGrid}
        title="Right side buttons"
        description={`Drag to reorder, uncheck to hide. ${layout.rightButtons.filter((id) => isToolbarButtonVisible(id, layout.pinnedButtons, agentSettings, agentAvailability)).length} of ${layout.rightButtons.length} visible.`}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleRightDragEnd}
          accessibility={{ announcements: toolbarButtonAnnouncements }}
        >
          <SortableContext items={layout.rightButtons} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {layout.rightButtons.map((buttonId) => (
                <SortableButtonItem
                  key={buttonId}
                  buttonId={buttonId}
                  isVisible={isToolbarButtonVisible(
                    buttonId,
                    layout.pinnedButtons,
                    agentSettings,
                    agentAvailability
                  )}
                  onToggle={handleToggleRight}
                  allMetadata={allMetadata}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </SettingsSection>

      {pluginButtonIds.length > 0 && (
        <SettingsSection
          icon={McpServerIcon}
          title="Plugin buttons"
          description={`Uncheck to hide. ${pluginButtonIds.filter((id) => isToolbarButtonVisible(id, layout.pinnedButtons, agentSettings, agentAvailability)).length} of ${pluginButtonIds.length} visible.`}
        >
          <div className="space-y-2">
            {pluginButtonIds.map((buttonId) => (
              <PluginButtonRow
                key={buttonId}
                buttonId={buttonId}
                isVisible={isToolbarButtonVisible(
                  buttonId,
                  layout.pinnedButtons,
                  agentSettings,
                  agentAvailability
                )}
                onToggle={(id) => toggleButtonVisibility(id, "right")}
                metadata={
                  (allMetadata as Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>)[
                    buttonId
                  ]
                }
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
              {BUILT_IN_AGENT_IDS.map((id) => (
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
