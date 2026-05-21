import { useState } from "react";
import { Upload, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { KeybindingImportResult } from "@shared/types/ipc/api";

interface KeybindingProfileActionsProps {
  onImportComplete: () => void;
}

export function KeybindingProfileActions({ onImportComplete }: KeybindingProfileActionsProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleExport = async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const saved = await window.electron.keybinding.exportProfile();
      if (saved) {
        notify({
          type: "success",
          title: "Shortcuts exported",
          message: "Profile saved to disk",
          transient: true,
        });
      }
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Export failed",
        message:
          "Couldn't save the profile. The destination may be read-only. Try a different location.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      let result: KeybindingImportResult;
      try {
        result = await window.electron.keybinding.importProfile();
      } catch {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Import failed",
          message: "Couldn't read the profile. The file may be missing or invalid JSON.",
        });
        return;
      }

      if (!result.ok) {
        if (result.errors[0] === "Cancelled") return;
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Import failed",
          message: result.errors[0] ?? "Unknown error",
        });
        return;
      }

      await keybindingService.loadOverrides();
      onImportComplete();

      notify({
        type: "success",
        title: "Shortcuts imported",
        message:
          result.applied > 0
            ? `Applied ${result.applied} shortcut${result.applied !== 1 ? "s" : ""}`
            : "No shortcuts were applied",
        transient: true,
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
          "flex items-center gap-1.5 px-3 py-2 text-sm border border-daintree-border rounded transition-colors",
          isLoading
            ? "opacity-50 cursor-not-allowed text-daintree-text/40"
            : "text-daintree-text/60 hover:text-daintree-text hover:border-daintree-border"
        )}
      >
        <Download className="w-3.5 h-3.5" />
        Export
      </button>
      <button
        onClick={handleImport}
        disabled={isLoading}
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 text-sm border border-daintree-border rounded transition-colors",
          isLoading
            ? "opacity-50 cursor-not-allowed text-daintree-text/40"
            : "text-daintree-text/60 hover:text-daintree-text hover:border-daintree-border"
        )}
      >
        <Upload className="w-3.5 h-3.5" />
        Import
      </button>
    </div>
  );
}
