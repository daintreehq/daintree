import { useCallback, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import {
  buildFleetTargetPreviews,
  executeFleetBroadcast,
  type FleetTargetPreview,
} from "./fleetExecution";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetComposerStore } from "@/store/fleetComposerStore";
import { getFleetBroadcastHistoryKey } from "./fleetBroadcast";
import { useProjectStore } from "@/store/projectStore";

interface FleetDryRunDialogProps {
  draft: string;
  onSend: (failedIds?: string[]) => void;
  onClose: () => void;
}

export function FleetDryRunDialog({
  draft,
  onSend,
  onClose,
}: FleetDryRunDialogProps): ReactElement {
  useFleetArmingStore((s) => s.armOrder); // subscribe so re-renders when armed set changes
  const previews = buildFleetTargetPreviews(draft);
  const eligible = previews.filter((p) => !p.excluded);

  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [isSending, setIsSending] = useState(false);

  const handleOverrideChange = useCallback((terminalId: string, value: string) => {
    setOverrides((prev) => ({ ...prev, [terminalId]: value }));
  }, []);

  const handleSend = useCallback(async () => {
    if (isSending) return;
    setIsSending(true);
    try {
      const currentPreviews = buildFleetTargetPreviews(draft);
      const targetIds = currentPreviews.filter((p) => !p.excluded).map((p) => p.terminalId);
      const result = await executeFleetBroadcast(draft, targetIds, overrides);

      const armedIds = Array.from(useFleetArmingStore.getState().armedIds);
      const projectId = useProjectStore.getState().currentProject?.id;
      const historyKey = getFleetBroadcastHistoryKey(projectId);
      useCommandHistoryStore.getState().recordPrompt(historyKey, draft, null, { armedIds });

      if (result.successCount > 0) {
        useFleetComposerStore.getState().clearDraft();
      }

      onSend(result.failureCount > 0 ? result.failedIds : undefined);
    } finally {
      setIsSending(false);
    }
  }, [draft, overrides, isSending, onSend]);

  return (
    <div
      role="dialog"
      aria-label="Dry-run preview"
      data-testid="fleet-dry-run-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-4 w-full max-w-2xl rounded-lg border border-daintree-border bg-daintree-sidebar shadow-2xl">
        <div className="flex items-center justify-between border-b border-daintree-border px-4 py-3">
          <h2 className="text-sm font-medium text-daintree-text">
            Dry-run preview — {eligible.length} target{eligible.length === 1 ? "" : "s"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[11px] text-daintree-text/60 hover:bg-tint/[0.08] hover:text-daintree-text"
          >
            Cancel
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          <div className="flex flex-col gap-3">
            {previews.map((preview) => (
              <FleetDryRunTargetRow
                key={preview.terminalId}
                preview={preview}
                override={overrides[preview.terminalId]}
                onOverrideChange={handleOverrideChange}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-daintree-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] px-3 py-1.5 text-[11px] text-daintree-text/70 hover:bg-tint/[0.08]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={eligible.length === 0 || isSending}
            className={cn(
              "rounded-[var(--radius-md)] bg-daintree-accent px-3 py-1.5 text-[11px] text-text-inverse transition-colors",
              "hover:bg-daintree-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
            )}
          >
            {isSending ? "Sending…" : `Send to ${eligible.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function FleetDryRunTargetRow({
  preview,
  override,
  onOverrideChange,
}: {
  preview: FleetTargetPreview;
  override: string | undefined;
  onOverrideChange: (id: string, value: string) => void;
}): ReactElement {
  const displayText = override ?? preview.resolvedPayload;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        preview.excluded
          ? "border-daintree-border/50 bg-daintree-bg/50 opacity-60"
          : "border-daintree-border bg-daintree-bg"
      )}
      data-testid={`fleet-dry-run-target-${preview.terminalId}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium text-daintree-text">{preview.title}</span>
        {preview.excluded && (
          <span className="text-[10px] text-daintree-text/50">{preview.exclusionReason}</span>
        )}
        {preview.unresolvedVars.length > 0 && (
          <span className="text-[10px] text-amber-400">
            Missing: {preview.unresolvedVars.join(", ")}
          </span>
        )}
      </div>
      {!preview.excluded && (
        <textarea
          value={displayText}
          onChange={(e) => onOverrideChange(preview.terminalId, e.target.value)}
          rows={Math.min(4, Math.max(1, displayText.split("\n").length))}
          className="w-full resize-none rounded border border-daintree-border bg-daintree-sidebar px-2 py-1 text-[11px] text-daintree-text focus:border-daintree-accent focus:outline-none"
        />
      )}
    </div>
  );
}
