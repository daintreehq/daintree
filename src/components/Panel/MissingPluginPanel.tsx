import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MissingPluginPanelProps {
  kind: string;
  onRemove: () => void;
}

export function MissingPluginPanel({ kind, onRemove }: MissingPluginPanelProps) {
  return (
    <div
      className="flex flex-1 items-center justify-center bg-surface-panel p-6"
      data-testid="missing-plugin-panel"
      data-kind={kind}
    >
      <div
        className={cn(
          "flex max-w-md flex-col items-center gap-3 rounded-[var(--radius-lg)] p-5 text-center",
          "bg-[color-mix(in_oklab,var(--color-status-warning)_12%,transparent)]",
          "border border-status-warning/30"
        )}
      >
        <TriangleAlert className="size-8 text-status-warning" aria-hidden="true" />

        <div className="space-y-1">
          <p className="text-sm font-semibold text-status-warning">Plugin not available</p>
          <p className="text-xs text-daintree-text/80">
            The plugin that provides this panel is disabled or missing. The panel's state is
            preserved — re-enable the plugin to restore it.
          </p>
          <p className="mt-2 font-mono text-xs text-daintree-text/50">Kind: {kind}</p>
        </div>

        <button
          type="button"
          onClick={onRemove}
          data-testid="missing-plugin-panel-remove"
          className="rounded bg-daintree-border px-3 py-1.5 text-xs text-daintree-text transition-colors hover:bg-daintree-border/80"
        >
          Remove panel
        </button>
      </div>
    </div>
  );
}
