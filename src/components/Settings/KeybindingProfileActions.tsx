import { useState } from "react";
import { Button } from "@/components/ui/button";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { KeybindingImportResult } from "@shared/types/ipc/api";

interface KeybindingProfileActionsProps {
  onImportComplete: () => void;
}

export function KeybindingProfileActions({ onImportComplete }: KeybindingProfileActionsProps) {
  // The pressed button stays focusable while the system file dialog runs, so the
  // keyboard is still on it when the dialog closes; native `disabled` would drop
  // focus to the page. The other button is blocked outright.
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  const handleExport = async () => {
    if (busy) return;
    setBusy("export");
    try {
      await window.electron.keybinding.exportProfile();
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Export failed",
        message:
          "Couldn't save the profile. The destination may be read-only. Try a different location.",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    if (busy) return;
    setBusy("import");
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

      if (result.applied === 0) {
        notify({
          type: "info",
          title: "No shortcuts imported",
          priority: "high",
          context: { eventKind: "settings" },
          message: "No shortcuts were applied",
          transient: true,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleExport}
        loading={busy === "export"}
        disabled={busy === "import"}
      >
        Export
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleImport}
        loading={busy === "import"}
        disabled={busy === "export"}
      >
        Import
      </Button>
    </div>
  );
}
