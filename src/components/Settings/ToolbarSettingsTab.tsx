import { useCallback, useMemo } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  SquareTerminal,
  Globe,
  Monitor,
  AlertTriangle,
  Settings,
  AlertCircle,
  Bell,
  Mic,
  LayoutGrid,
  Rocket,
  RotateCcw,
  StickyNote,
  Puzzle,
} from "lucide-react";
import { CopyTreeIcon } from "@/components/icons";
import { useToolbarPreferencesStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import type { AgentSettings } from "@shared/types";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { isAgentPinnedById } from "../../../shared/utils/agentPinned";
import { getAgentConfig } from "@/config/agents";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { McpServerIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

type ButtonMetadata = { label: string; icon: React.ReactNode; description: string };

// Agent-ID writes and reads for visibility go through `agentSettingsStore`
// (the authoritative IPC-persisted store). `toolbarPreferencesStore.hiddenButtons`
// is the source of truth only for non-agent buttons. A `version: 5` migration
// strips stale agent IDs from persisted `hiddenButtons` so they can't shadow
// the canonical pinned state.
const AGENT_ID_SET = new Set<string>(BUILT_IN_AGENT_IDS);

function isEffectivelyVisible(
  buttonId: AnyToolbarButtonId,
  hiddenButtons: string[],
  agentSettings: AgentSettings | null
): boolean {
  if (AGENT_ID_SET.has(buttonId)) return isAgentPinnedById(agentSettings, buttonId);
  return !hiddenButtons.includes(buttonId);
}

const BUTTON_METADATA: Partial<Record<AnyToolbarButtonId, ButtonMetadata>> = {
  "agent-tray": {
    label: "Agent Tray",
    icon: <Puzzle className="h-4 w-4" />,
    description: "Overflow tray for installed-but-unpinned agents and setup links",
  },
  ...Object.fromEntries(
    BUILT_IN_AGENT_IDS.map((id) => {
      const cfg = getAgentConfig(id);
      const Icon = cfg?.icon;
      const name = cfg?.name ?? id;
      return [
        id,
        {
          label: `${name} Agent`,
          icon: Icon ? <Icon className="h-4 w-4" /> : <SquareTerminal className="h-4 w-4" />,
          description: `Launch ${name} AI agent`,
        },
      ];
    })
  ),
  terminal: {
    label: "Terminal",
    icon: <SquareTerminal className="h-4 w-4" />,
    description: "Open new terminal",
  },
  browser: {
    label: "Browser",
    icon: <Globe className="h-4 w-4" />,
    description: "Open browser panel",
  },
  "dev-server": {
    label: "Dev Preview",
    icon: <Monitor className="h-4 w-4" />,
    description: "Open dev preview panel",
  },
  "voice-recording": {
    label: "Voice Recording",
    icon: <Mic className="h-4 w-4" />,
    description: "Persistent dictation indicator shown while recording is active",
  },
  "github-stats": {
    label: "GitHub Stats",
    icon: <AlertTriangle className="h-4 w-4" />,
    description: "GitHub issues, PRs, and commits",
  },
  "notification-center": {
    label: "Notifications",
    icon: <Bell className="h-4 w-4" />,
    description: "Notification history dropdown",
  },
  notes: {
    label: "Notes",
    icon: <StickyNote className="h-4 w-4" />,
    description: "Open notes palette",
  },
  "copy-tree": {
    label: "Copy Context",
    icon: <CopyTreeIcon className="h-4 w-4" />,
    description: "Copy project context to clipboard",
  },
  settings: {
    label: "Settings",
    icon: <Settings className="h-4 w-4" />,
    description: "Open settings dialog",
  },
  problems: {
    label: "Problems",
    icon: <AlertCircle className="h-4 w-4" />,
    description: "Show problems panel",
  },
};

interface SortableButtonItemProps {
  buttonId: AnyToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: AnyToolbarButtonId) => void;
  allMetadata: Partial<Record<AnyToolbarButtonId, ButtonMetadata>>;
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
    opacity: isDragging ? 0.5 : isVisible ? 1 : 0.5,
  };

  if (!metadata) return null;

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
        <div className="text-daintree-text">{metadata.icon}</div>
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

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = usePluginToolbarButtons();

  const allMetadata = useMemo(() => {
    const pluginMeta: Record<string, ButtonMetadata> = {};
    for (const id of pluginButtonIds) {
      const config = pluginConfigs.get(id);
      if (config) {
        pluginMeta[id] = {
          label: config.label,
          icon: <McpServerIcon className="h-4 w-4" />,
          description: `Plugin button (${config.pluginId})`,
        };
      }
    }
    return { ...BUTTON_METADATA, ...pluginMeta };
  }, [pluginButtonIds, pluginConfigs]);

  const handleLeftDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = layout.leftButtons.indexOf(active.id as AnyToolbarButtonId);
      const newIndex = layout.leftButtons.indexOf(over.id as AnyToolbarButtonId);

      if (oldIndex === -1 || newIndex === -1) return;

      const newButtons = [...layout.leftButtons];
      newButtons.splice(oldIndex, 1);
      newButtons.splice(newIndex, 0, active.id as AnyToolbarButtonId);

      setLeftButtons(newButtons);
    },
    [layout.leftButtons, setLeftButtons]
  );

  const handleRightDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = layout.rightButtons.indexOf(active.id as AnyToolbarButtonId);
      const newIndex = layout.rightButtons.indexOf(over.id as AnyToolbarButtonId);

      if (oldIndex === -1 || newIndex === -1) return;

      const newButtons = [...layout.rightButtons];
      newButtons.splice(oldIndex, 1);
      newButtons.splice(newIndex, 0, active.id as AnyToolbarButtonId);

      setRightButtons(newButtons);
    },
    [layout.rightButtons, setRightButtons]
  );

  const handleToggleLeft = useCallback(
    (buttonId: AnyToolbarButtonId) => {
      if (AGENT_ID_SET.has(buttonId)) {
        void setAgentPinned(buttonId, !isAgentPinnedById(agentSettings, buttonId));
        return;
      }
      toggleButtonVisibility(buttonId, "left");
    },
    [agentSettings, setAgentPinned, toggleButtonVisibility]
  );

  const handleToggleRight = useCallback(
    (buttonId: AnyToolbarButtonId) => {
      if (AGENT_ID_SET.has(buttonId)) {
        void setAgentPinned(buttonId, !isAgentPinnedById(agentSettings, buttonId));
        return;
      }
      toggleButtonVisibility(buttonId, "right");
    },
    [agentSettings, setAgentPinned, toggleButtonVisibility]
  );

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={LayoutGrid}
        title="Left Side Buttons"
        description={`Drag to reorder, uncheck to hide. ${layout.leftButtons.filter((id) => isEffectivelyVisible(id, layout.hiddenButtons, agentSettings)).length} of ${layout.leftButtons.length} visible.`}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleLeftDragEnd}
        >
          <SortableContext items={layout.leftButtons} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {layout.leftButtons.map((buttonId) => (
                <SortableButtonItem
                  key={buttonId}
                  buttonId={buttonId}
                  isVisible={isEffectivelyVisible(buttonId, layout.hiddenButtons, agentSettings)}
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
        title="Right Side Buttons"
        description={`Drag to reorder, uncheck to hide. ${layout.rightButtons.filter((id) => isEffectivelyVisible(id, layout.hiddenButtons, agentSettings)).length} of ${layout.rightButtons.length} visible.`}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleRightDragEnd}
        >
          <SortableContext items={layout.rightButtons} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {layout.rightButtons.map((buttonId) => (
                <SortableButtonItem
                  key={buttonId}
                  buttonId={buttonId}
                  isVisible={isEffectivelyVisible(buttonId, layout.hiddenButtons, agentSettings)}
                  onToggle={handleToggleRight}
                  allMetadata={allMetadata}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </SettingsSection>

      <SettingsSection
        icon={Rocket}
        title="Launcher Palette"
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
              className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent focus:outline-none transition-colors"
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
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
