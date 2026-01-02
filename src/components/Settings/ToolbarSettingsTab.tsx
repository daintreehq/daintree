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
  PanelLeft,
  Terminal,
  Globe,
  Rocket,
  AlertTriangle,
  StickyNote,
  Copy,
  Settings,
  AlertCircle,
  PanelRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToolbarPreferencesStore } from "@/store";
import type { ToolbarButtonId } from "@/../../shared/types/domain";
import { Bot } from "lucide-react";

const BUTTON_METADATA: Record<
  ToolbarButtonId,
  { label: string; icon: React.ReactNode; description: string; fixed?: boolean }
> = {
  "sidebar-toggle": {
    label: "Sidebar Toggle",
    icon: <PanelLeft className="h-4 w-4" />,
    description: "Toggle sidebar visibility",
    fixed: true,
  },
  claude: {
    label: "Claude Agent",
    icon: <Bot className="h-4 w-4" />,
    description: "Launch Claude AI agent",
  },
  gemini: {
    label: "Gemini Agent",
    icon: <Bot className="h-4 w-4" />,
    description: "Launch Gemini AI agent",
  },
  codex: {
    label: "Codex Agent",
    icon: <Bot className="h-4 w-4" />,
    description: "Launch Codex AI agent",
  },
  opencode: {
    label: "OpenCode Agent",
    icon: <Bot className="h-4 w-4" />,
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
    icon: <Rocket className="h-4 w-4" />,
    description: "Start development server",
  },
  "github-stats": {
    label: "GitHub Stats",
    icon: <AlertTriangle className="h-4 w-4" />,
    description: "GitHub issues, PRs, and commits",
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
  "sidecar-toggle": {
    label: "Sidecar Toggle",
    icon: <PanelRight className="h-4 w-4" />,
    description: "Toggle sidecar panel",
    fixed: true,
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
    disabled: metadata.fixed,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border border-divider bg-canopy-sidebar/30",
        metadata.fixed && "opacity-60"
      )}
    >
      {!metadata.fixed && (
        <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      {metadata.fixed && <div className="w-4" />}
      <div className="flex items-center gap-2 flex-1">
        <div className="text-canopy-text">{metadata.icon}</div>
        <div className="flex-1">
          <div className="text-sm font-medium text-canopy-text">{metadata.label}</div>
          <div className="text-xs text-muted-foreground">{metadata.description}</div>
        </div>
      </div>
      {!metadata.fixed && (
        <input
          type="checkbox"
          checked={isVisible}
          onChange={() => onToggle(buttonId)}
          aria-label={`Toggle ${metadata.label} visibility`}
          className="w-4 h-4 rounded border-divider bg-canopy-sidebar text-canopy-accent focus:ring-canopy-accent focus:ring-2"
        />
      )}
      {metadata.fixed && <div className="text-xs text-muted-foreground">Always visible</div>}
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

  const leftButtonsWithFixed = useMemo(
    () => ["sidebar-toggle" as ToolbarButtonId, ...layout.leftButtons],
    [layout.leftButtons]
  );

  const rightButtonsWithFixed = useMemo(
    () => [...layout.rightButtons, "sidecar-toggle" as ToolbarButtonId],
    [layout.rightButtons]
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
    <div className="space-y-6 overflow-y-auto pr-2">
      <div>
        <h2 className="text-lg font-semibold text-canopy-text mb-1">Toolbar Customization</h2>
        <p className="text-sm text-muted-foreground">
          Configure which buttons appear in the toolbar and their order. Drag to reorder, uncheck to
          hide.
        </p>
      </div>

      <div className="space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-canopy-text">Left Side Buttons</label>
            <span className="text-xs text-muted-foreground">
              {layout.leftButtons.length + 1} buttons
            </span>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleLeftDragEnd}
          >
            <SortableContext items={leftButtonsWithFixed} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {leftButtonsWithFixed.map((buttonId) => (
                  <SortableButtonItem
                    key={buttonId}
                    buttonId={buttonId}
                    isVisible={
                      buttonId === "sidebar-toggle" || layout.leftButtons.includes(buttonId)
                    }
                    onToggle={handleToggleLeft}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-canopy-text">Right Side Buttons</label>
            <span className="text-xs text-muted-foreground">
              {layout.rightButtons.length + 1} buttons
            </span>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleRightDragEnd}
          >
            <SortableContext items={rightButtonsWithFixed} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {rightButtonsWithFixed.map((buttonId) => (
                  <SortableButtonItem
                    key={buttonId}
                    buttonId={buttonId}
                    isVisible={
                      buttonId === "sidecar-toggle" || layout.rightButtons.includes(buttonId)
                    }
                    onToggle={handleToggleRight}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        <div className="border-t border-divider pt-6">
          <h3 className="text-sm font-medium text-canopy-text mb-3">Launcher Palette</h3>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="always-show-dev-server"
                checked={launcher.alwaysShowDevServer}
                onChange={(e) => setAlwaysShowDevServer(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-divider bg-canopy-sidebar text-canopy-accent focus:ring-canopy-accent focus:ring-2"
              />
              <div className="flex-1">
                <label
                  htmlFor="always-show-dev-server"
                  className="text-sm font-medium text-canopy-text cursor-pointer"
                >
                  Always show dev server in launcher
                </label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Show dev server option even if no command is configured in project settings
                </p>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-canopy-text mb-2 block">
                Default selection
              </label>
              <select
                value={launcher.defaultSelection ?? ""}
                onChange={(e) =>
                  setDefaultSelection(
                    e.target.value
                      ? (e.target.value as typeof launcher.defaultSelection)
                      : undefined
                  )
                }
                className="w-full px-3 py-2 text-sm rounded-lg border border-divider bg-canopy-sidebar/30 text-canopy-text"
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
              <p className="text-xs text-muted-foreground mt-1.5">
                Default option to highlight when opening the launcher palette
              </p>
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t border-divider">
          <button
            onClick={reset}
            className="px-3 py-1.5 text-sm rounded-lg border border-divider bg-canopy-sidebar/30 text-canopy-text hover:bg-white/[0.06] transition-colors"
          >
            Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  );
}
