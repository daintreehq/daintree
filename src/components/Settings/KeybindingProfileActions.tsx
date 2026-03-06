import { useState } from "react";
import { Upload, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { keybindingService } from "@/services/KeybindingService";
import { useNotificationStore } from "@/store/notificationStore";
import type { KeybindingImportResult } from "@shared/types/ipc/api";

interface KeybindingProfileActionsProps {
  onImportComplete: () => void;
}

export function KeybindingProfileActions({ onImportComplete }: KeybindingProfileActionsProps) {
  const [isLoading, setIsLoading] = useState(false);
  const addNotification = useNotificationStore((state) => state.addNotification);

  const handleExport = async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const saved = await window.electron.keybinding.exportProfile();
      if (saved) {
        addNotification({
          type: "success",
          title: "Shortcuts exported",
          message: "Keybinding profile saved successfully.",
        });
      }
    } catch {
      addNotification({
        type: "error",
        title: "Export failed",
        message: "Could not save the keybinding profile.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const result: KeybindingImportResult = await window.electron.keybinding.importProfile();
      if (!result.ok) {
        if (result.errors[0] === "Cancelled") return;
        addNotification({
          type: "error",
          title: "Import failed",
          message: result.errors[0] ?? "Unknown error",
        });
        return;
      }

      await keybindingService.loadOverrides();
      onImportComplete();

      const parts: string[] = [];
      if (result.applied > 0) {
        parts.push(`Applied ${result.applied} shortcut${result.applied !== 1 ? "s" : ""}`);
      }
      if (result.skipped > 0) {
        parts.push(`skipped ${result.skipped} unknown action${result.skipped !== 1 ? "s" : ""}`);
      }

      addNotification({
        type: "success",
        title: "Shortcuts imported",
        message: parts.length > 0 ? parts.join(", ") + "." : "No shortcuts were applied.",
      });
    } catch {
      addNotification({
        type: "error",
        title: "Import failed",
        message: "Could not read the keybinding profile.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleExport}
        disabled={isLoading}
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 text-sm border border-canopy-border rounded transition-colors",
          isLoading
            ? "opacity-50 cursor-not-allowed text-canopy-text/40"
            : "text-canopy-text/60 hover:text-canopy-text hover:border-canopy-accent"
        )}
      >
        <Download className="w-3.5 h-3.5" />
        Export
      </button>
      <button
        onClick={handleImport}
        disabled={isLoading}
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 text-sm border border-canopy-border rounded transition-colors",
          isLoading
            ? "opacity-50 cursor-not-allowed text-canopy-text/40"
            : "text-canopy-text/60 hover:text-canopy-text hover:border-canopy-accent"
        )}
      >
        <Upload className="w-3.5 h-3.5" />
        Import
      </button>
    </div>
  );
}
