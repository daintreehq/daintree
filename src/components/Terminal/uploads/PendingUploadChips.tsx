import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePendingUploads } from "./pendingUploads";

export function uploadChipLabel(fraction: number | null): string {
  return fraction === null ? "uploading" : `uploading ${Math.round(fraction * 100)}%`;
}

/**
 * The uploads still on their way to the host for one surface, each with its
 * progress and a cancel button. Renders nothing until an upload has been
 * running long enough to be worth showing.
 */
export function PendingUploadChips({
  surface,
  className,
}: {
  surface: string;
  className?: string;
}) {
  const uploads = usePendingUploads(surface).filter((upload) => upload.visible);
  if (uploads.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-pending-uploads={surface}
    >
      {uploads.map((upload) => (
        <span
          key={upload.id}
          className="inline-flex max-w-64 items-center gap-1.5 rounded-full border border-border-default bg-surface-panel-elevated py-0.5 pl-2.5 pr-1 text-xs text-text-secondary"
        >
          <span className="min-w-0 truncate text-text-primary">{upload.name}</span>
          <span className="shrink-0 tabular-nums">{uploadChipLabel(upload.fraction)}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              upload.cancel();
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-overlay-subtle hover:text-text-primary"
            aria-label={`Cancel uploading ${upload.name}`}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}
