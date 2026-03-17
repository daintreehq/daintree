import { useCallback } from "react";
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
  Terminal,
  Globe,
  Monitor,
  AlertTriangle,
  StickyNote,
  Copy,
  Settings,
  AlertCircle,
  PackagePlus,
  Bell,
  Mic,
  LayoutGrid,
  Rocket,
  RotateCcw,
} from "lucide-react";
import { ClaudeIcon, GeminiIcon, CodexIcon, OpenCodeIcon } from "@/components/icons";
import { useToolbarPreferencesStore } from "@/store";
import type { ToolbarButtonId } from "@/../../shared/types/toolbar";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

type ButtonMetadata = { label: string; icon: React.ReactNode; description: string };

const BUTTON_METADATA: Partial<Record<ToolbarButtonId, ButtonMetadata>> = {
  "agent-setup": {
    label: "Agent Setup",
    icon: <PackagePlus className="h-4 w-4" />,
    description: "Shown only when no agents are enabled in Agent Settings",
  },
  claude: {
    label: "Claude Agent",
    icon: <ClaudeIcon className="h-4 w-4" />,
    description: "Launch Claude AI agent",
  },
  gemini: {
    label: "Gemini Agent",
    icon: <GeminiIcon className="h-4 w-4" />,
    description: "Launch Gemini AI agent",
  },
  codex: {
    label: "Codex Agent",
    icon: <CodexIcon className="h-4 w-4" />,
    description: "Launch Codex AI agent",
  },
  opencode: {
    label: "OpenCode Agent",
    icon: <OpenCodeIcon className="h-4 w-4" />,
    description: "Launch OpenCode AI agent",
  },
  terminal: {
    label: "Terminal",
    icon: <Terminal className="h-4 w-4" />,
    description: "Open new terminal",
  },
  browser: {
    label: "Browser",
    icon: <Globe className="h-4 w-4" />,
    description: "Open browser panel",
  },
  "dev-server": {
    label: "Dev Server",
    icon: <Monitor className="h-4 w-4" />,
    description: "Start development server",
  },
  "panel-palette": {
    label: "Panel Palette",
    icon: <LayoutGrid className="h-4 w-4" />,
    description: "Open the panel launcher palette",
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
    icon: <Copy className="h-4 w-4" />,
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
  buttonId: ToolbarButtonId;
  isVisible: boolean;
  onToggle: (buttonId: ToolbarButtonId) => void;
}

function SortableButtonItem({ buttonId, isVisible, onToggle }: SortableButtonItemProps) {
  const metadata = BUTTON_METADATA[buttonId];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: buttonId,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  if (!metadata) return null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30"
    >
      <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
        <GripVertical className="h-4 w-4 text-canopy-text/50" />
      </div>
      <div className="flex items-center gap-2 flex-1">
        <div className="text-canopy-text">{metadata.icon}</div>
        <div className="flex-1">
          <div className="text-sm font-medium text-canopy-text">{metadata.label}</div>
          <div className="text-xs text-canopy-text/50">{metadata.description}</div>
        </div>
      </div>
      <input
        type="checkbox"
        checked={isVisible}
        onChange={() => onToggle(buttonId)}
        aria-label={`Toggle ${metadata.label} visibility`}
        className="w-4 h-4 rounded border-canopy-border bg-canopy-bg text-canopy-accent focus:ring-canopy-accent focus:ring-2"
      />
    </div>
  );
}

export function ToolbarSettingsTab() {
  const {
    layout,
    launcher,
    setLeftButtons,
    setRightButtons,
    toggleButtonVisibility,
    setAlwaysShowDevServer,
    setDefaultSelection,
    reset,
  } = useToolbarPreferencesStore();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleLeftDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = layout.leftButtons.indexOf(active.id as ToolbarButtonId);
      const newIndex = layout.leftButtons.indexOf(over.id as ToolbarButtonId);

      if (oldIndex === -1 || newIndex === -1) return;

      const newButtons = [...layout.leftButtons];
      newButtons.splice(oldIndex, 1);
      newButtons.splice(newIndex, 0, active.id as ToolbarButtonId);

      setLeftButtons(newButtons);
    },
    [layout.leftButtons, setLeftButtons]
  );

  const handleRightDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = layout.rightButtons.indexOf(active.id as ToolbarButtonId);
      const newIndex = layout.rightButtons.indexOf(over.id as ToolbarButtonId);

      if (oldIndex === -1 || newIndex === -1) return;

      const newButtons = [...layout.rightButtons];
      newButtons.splice(oldIndex, 1);
      newButtons.splice(newIndex, 0, active.id as ToolbarButtonId);

      setRightButtons(newButtons);
    },
    [layout.rightButtons, setRightButtons]
  );

  const handleToggleLeft = useCallback(
    (buttonId: ToolbarButtonId) => {
      toggleButtonVisibility(buttonId, "left");
    },
    [toggleButtonVisibility]
  );

  const handleToggleRight = useCallback(
    (buttonId: ToolbarButtonId) => {
      toggleButtonVisibility(buttonId, "right");
    },
    [toggleButtonVisibility]
  );

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={LayoutGrid}
        title="Left Side Buttons"
        description={`Drag to reorder, uncheck to hide. ${layout.leftButtons.length} buttons configured.`}
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
                  isVisible={layout.leftButtons.includes(buttonId)}
                  onToggle={handleToggleLeft}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </SettingsSection>

      <SettingsSection
        icon={LayoutGrid}
        title="Right Side Buttons"
        description={`Drag to reorder, uncheck to hide. ${layout.rightButtons.length} buttons configured.`}
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
                  isVisible={layout.rightButtons.includes(buttonId)}
                  onToggle={handleToggleRight}
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
            <label className="text-sm font-medium text-canopy-text block">Default selection</label>
            <select
              value={launcher.defaultSelection ?? ""}
              onChange={(e) =>
                setDefaultSelection(
                  e.target.value ? (e.target.value as typeof launcher.defaultSelection) : undefined
                )
              }
              className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text focus:border-canopy-accent focus:outline-none transition-colors"
            >
              <option value="">None (first available)</option>
              <option value="terminal">Terminal</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
              <option value="browser">Browser</option>
              <option value="dev-server">Dev Server</option>
            </select>
            <p className="text-xs text-canopy-text/40">
              Default option to highlight when opening the launcher palette
            </p>
          </div>
        </div>
      </SettingsSection>

      <div className="flex justify-end">
        <button
          onClick={reset}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-canopy-border",
            "text-canopy-text/60 hover:text-canopy-text hover:bg-tint/5 transition-colors"
          )}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
