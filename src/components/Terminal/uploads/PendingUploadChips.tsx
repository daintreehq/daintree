import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePendingUploads, type FolderUploadStage, type PendingUpload } from "./pendingUploads";

export function uploadChipLabel(fraction: number | null): string {
  return fraction === null ? "uploading" : `uploading ${Math.round(fraction * 100)}%`;
}

export function folderUploadChipLabel(stage: FolderUploadStage): string {
  switch (stage.phase) {
    case "packing":
      return "packing";
    case "sending":
      return stage.percent === null ? "sending" : `sending ${stage.percent}%`;
    case "unpacking":
      return stage.filesDone === null
        ? "unpacking"
        : // Grouped as `pluralize` groups, so a chip and the question count alike.
          `unpacking ${stage.filesDone.toLocaleString()} of ${stage.filesTotal.toLocaleString()}`;
  }
}

/**
 * What the status region says for a folder's phase. Unpacking can count
 * thousands of files one by one, and each change would be spoken, so speech
 * follows it in tenths while the chip shows the exact count.
 */
export function folderUploadSpokenLabel(stage: FolderUploadStage): string {
  if (stage.phase !== "unpacking" || stage.filesDone === null || stage.filesTotal <= 0) {
    return folderUploadChipLabel(stage);
  }
  return `unpacking ${Math.floor((stage.filesDone / stage.filesTotal) * 10) * 10}%`;
}

function ChipProgress({ upload }: { upload: PendingUpload }) {
  if (!upload.folder) {
    return <span className="shrink-0 tabular-nums">{uploadChipLabel(upload.fraction)}</span>;
  }
  return (
    <span className="shrink-0 tabular-nums">
      <span aria-hidden="true">{folderUploadChipLabel(upload.folder)}</span>
      <span className="sr-only">{folderUploadSpokenLabel(upload.folder)}</span>
    </span>
  );
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
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border-default bg-surface-panel-elevated py-0.5 pl-2.5 pr-1 text-xs text-text-secondary",
            // A folder's phase label runs longer than a file's, so it gets the room
            // to keep some of the name beside "unpacking 1,204 of 3,000". `min-w-0`
            // lets a long name give way inside a row narrower than the chip.
            upload.folder ? "max-w-80" : "max-w-64"
          )}
        >
          <span className="min-w-0 truncate text-text-primary" title={upload.name}>
            {upload.name}
          </span>
          <ChipProgress upload={upload} />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              upload.cancel();
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-overlay-subtle hover:text-text-primary"
            aria-label={`Cancel ${upload.folder ? "sending" : "uploading"} ${upload.name}`}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}
