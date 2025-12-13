import { useState, useEffect, useCallback, useMemo } from "react";
import { Search, RotateCcw, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { keybindingService, KeybindingConfig } from "@/services/KeybindingService";

interface ShortcutBinding extends KeybindingConfig {
  effectiveCombo: string;
  isOverridden: boolean;
}

interface KeyRecorderProps {
  onCapture: (combo: string) => void;
  onCancel: () => void;
  conflicts: KeybindingConfig[];
}

function KeyRecorder({ onCapture, onCancel, conflicts }: KeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [capturedCombo, setCapturedCombo] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const parts: string[] = [];
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

      if (isMac && e.metaKey) parts.push("Cmd");
      if (!isMac && e.ctrlKey) parts.push("Cmd");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");

      const key = normalizeKey(e.key);
      if (!["Meta", "Control", "Alt", "Shift"].includes(key)) {
        parts.push(key);
        const combo = parts.join("+");
        setCapturedCombo(combo);
        setRecording(false);
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [recording]);

  const handleStartRecording = () => {
    setCapturedCombo(null);
    setRecording(true);
  };

  const handleSave = () => {
    if (capturedCombo) {
      onCapture(capturedCombo);
    }
  };

  const handleClear = () => {
    onCapture("");
  };

  return (
    <div className="bg-canopy-bg/50 border border-canopy-border rounded-[var(--radius-lg)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        {recording ? (
          <div className="flex-1 px-4 py-2 border border-canopy-accent rounded bg-canopy-accent/10 text-canopy-accent animate-pulse text-center">
            Press key combination...
          </div>
        ) : capturedCombo ? (
          <div className="flex-1 px-4 py-2 border border-canopy-border rounded bg-canopy-bg text-canopy-text text-center font-mono">
            {keybindingService.formatComboForDisplay(capturedCombo)}
          </div>
        ) : (
          <button
            onClick={handleStartRecording}
            className="flex-1 px-4 py-2 border border-canopy-border rounded bg-canopy-bg text-canopy-text/60 hover:text-canopy-text hover:border-canopy-accent transition-colors"
          >
            Click to record shortcut
          </button>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="flex items-start gap-2 text-amber-400 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Conflicts with: {conflicts.map((c) => c.description || c.actionId).join(", ")}
          </span>
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-canopy-text/60 hover:text-canopy-text transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleClear}
          className="px-3 py-1.5 text-sm text-canopy-text/60 hover:text-canopy-text transition-colors"
        >
          Clear
        </button>
        {capturedCombo && (
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-sm bg-canopy-accent text-white rounded hover:bg-canopy-accent/90 transition-colors"
          >
            Save
          </button>
        )}
      </div>
    </div>
  );
}

function normalizeKey(key: string): string {
  const keyMap: Record<string, string> = {
    " ": "Space",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    backspace: "Backspace",
    delete: "Delete",
  };
  return keyMap[key.toLowerCase()] || key;
}

interface ShortcutRowProps {
  binding: ShortcutBinding;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (combo: string) => void;
  onCancel: () => void;
  onReset: () => void;
}

function ShortcutRow({ binding, isEditing, onEdit, onSave, onCancel, onReset }: ShortcutRowProps) {
  const [pendingCombo, setPendingCombo] = useState<string | null>(null);

  const conflicts = useMemo(() => {
    if (!pendingCombo) return [];
    return keybindingService.findConflicts(pendingCombo, binding.actionId);
  }, [pendingCombo, binding.actionId]);

  const handleCapture = (combo: string) => {
    if (combo === "") {
      onSave("");
    } else {
      setPendingCombo(combo);
      onSave(combo);
    }
    setPendingCombo(null);
  };

  if (isEditing) {
    return (
      <div className="py-2 border-b border-canopy-border/50">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-canopy-text">
            {binding.description || binding.actionId}
          </span>
        </div>
        <KeyRecorder onCapture={handleCapture} onCancel={onCancel} conflicts={conflicts} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-canopy-border/50 group">
      <span className="text-sm text-canopy-text">{binding.description || binding.actionId}</span>
      <div className="flex items-center gap-2">
        {binding.effectiveCombo ? (
          <span
            className={cn(
              "px-2 py-0.5 text-xs font-mono rounded",
              binding.isOverridden
                ? "bg-canopy-accent/20 text-canopy-accent"
                : "bg-canopy-border text-canopy-text"
            )}
          >
            {keybindingService.formatComboForDisplay(binding.effectiveCombo)}
          </span>
        ) : (
          <span className="text-xs text-canopy-text/60 italic">unbound</span>
        )}
        <button
          onClick={onEdit}
          className="px-2 py-0.5 text-xs text-canopy-text/60 hover:text-canopy-text opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Edit
        </button>
        {binding.isOverridden && (
          <button
            onClick={onReset}
            className="p-0.5 text-canopy-text/60 hover:text-canopy-text opacity-0 group-hover:opacity-100 transition-opacity"
            title="Reset to default"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export function KeyboardShortcutsTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [bindings, setBindings] = useState<ShortcutBinding[]>([]);
  const [, setUpdateKey] = useState(0);

  const loadBindings = useCallback(() => {
    const allBindings = keybindingService.getAllBindingsWithEffectiveCombos();
    setBindings(
      allBindings.map((b) => ({
        ...b,
        isOverridden: keybindingService.hasOverride(b.actionId),
      }))
    );
  }, []);

  useEffect(() => {
    keybindingService.loadOverrides().then(loadBindings);

    const unsubscribe = keybindingService.subscribe(() => {
      loadBindings();
      setUpdateKey((k) => k + 1);
    });

    return unsubscribe;
  }, [loadBindings]);

  const filteredBindings = useMemo(() => {
    if (!searchQuery.trim()) return bindings;

    const query = searchQuery.toLowerCase();
    return bindings.filter(
      (b) =>
        (b.description?.toLowerCase().includes(query) ?? false) ||
        b.actionId.toLowerCase().includes(query) ||
        b.effectiveCombo.toLowerCase().includes(query) ||
        (b.category?.toLowerCase().includes(query) ?? false)
    );
  }, [bindings, searchQuery]);

  const groupedBindings = useMemo(() => {
    const groups = new Map<string, ShortcutBinding[]>();
    filteredBindings.forEach((binding) => {
      const category = binding.category || "Other";
      if (!groups.has(category)) {
        groups.set(category, []);
      }
      groups.get(category)!.push(binding);
    });
    return groups;
  }, [filteredBindings]);

  const handleSaveShortcut = async (actionId: string, combo: string) => {
    if (combo === "") {
      await keybindingService.setOverride(actionId, []);
    } else {
      await keybindingService.setOverride(actionId, [combo]);
    }
    setEditingActionId(null);
    loadBindings();
  };

  const handleResetShortcut = async (actionId: string) => {
    await keybindingService.removeOverride(actionId);
    loadBindings();
  };

  const handleResetAll = async () => {
    await keybindingService.resetAllOverrides();
    loadBindings();
  };

  const hasOverrides = bindings.some((b) => b.isOverridden);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-canopy-text/60" />
          <input
            type="text"
            placeholder="Search shortcuts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-canopy-bg border border-canopy-border rounded text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:border-canopy-accent"
          />
        </div>
        {hasOverrides && (
          <button
            onClick={handleResetAll}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-canopy-text/60 hover:text-canopy-text border border-canopy-border rounded hover:border-canopy-accent transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset All
          </button>
        )}
      </div>

      <div className="space-y-4">
        {Array.from(groupedBindings.entries()).map(([category, categoryBindings]) => (
          <div key={category}>
            <h4 className="text-xs font-semibold text-canopy-text/60 uppercase tracking-wider mb-2">
              {category}
            </h4>
            <div className="space-y-0">
              {categoryBindings.map((binding) => (
                <ShortcutRow
                  key={binding.actionId}
                  binding={binding}
                  isEditing={editingActionId === binding.actionId}
                  onEdit={() => setEditingActionId(binding.actionId)}
                  onSave={(combo) => handleSaveShortcut(binding.actionId, combo)}
                  onCancel={() => setEditingActionId(null)}
                  onReset={() => handleResetShortcut(binding.actionId)}
                />
              ))}
            </div>
          </div>
        ))}

        {filteredBindings.length === 0 && (
          <div className="text-center py-8 text-canopy-text/60">
            No shortcuts found matching "{searchQuery}"
          </div>
        )}
      </div>
    </div>
  );
}
