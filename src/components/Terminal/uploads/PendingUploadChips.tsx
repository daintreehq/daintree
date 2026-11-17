import { useCallback, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cn } from "@/lib/utils";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { usePendingUploads, type FolderUploadStage, type PendingUpload } from "./pendingUploads";

export function uploadChipLabel(fraction: number | null): string {
  return fraction === null ? "uploading" : `uploading ${Math.round(fraction * 100)}%`;
}

export function folderUploadChipLabel(stage: FolderUploadStage): string {
  switch (stage.phase) {
    case "waiting":
      return "waiting";
    case "reading":
      return "reading";
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

function UploadChip({
  upload,
  onMount,
  onLeave,
}: {
  upload: PendingUpload;
  onMount: (id: number, button: HTMLButtonElement) => void;
  onLeave: (id: number, hadFocus: boolean) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { id } = upload;
  // A layout cleanup runs while the chip is still in the document, so it can
  // still see whether its button holds focus: once the node is gone, focus
  // has already fallen to the body and nothing says where it was.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    onMount(id, button);
    return () => onLeave(id, button.ownerDocument.activeElement === button);
  }, [id, onMount, onLeave]);

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border-default bg-surface-panel-elevated py-0.5 pl-2.5 pr-1 text-xs text-text-secondary",
        // A folder's phase label runs longer than a file's, so it gets the room
        // to keep some of the name beside "unpacking 1,204 of 3,000". `min-w-0`
        // lets a long name give way inside a row narrower than the chip.
        upload.folder ? "max-w-80" : "max-w-64"
      )}
    >
      {/* Pointer only: the cancel button is the chip's one tab stop, and its
          accessible name already carries the whole name. */}
      <TruncatedTooltip content={upload.name} focusable={false}>
        <span className="min-w-0 truncate text-text-primary">{upload.name}</span>
      </TruncatedTooltip>
      <ChipProgress upload={upload} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            variant="ghost"
            size="icon-xs"
            // A 20px circle that fits the pill, with an invisible 24px hit area
            // (WCAG 2.5.8) reaching only into the chip's own padding.
            className="h-5 w-5 shrink-0 rounded-full after:absolute after:-inset-0.5 after:content-['']"
            // A press leaves focus where the user was working (the composer,
            // the terminal, the tree), so a stray Enter or Space afterwards
            // can't cancel the next upload.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              upload.cancel();
            }}
            aria-label={`Cancel ${upload.folder ? "sending" : "uploading"} ${upload.name}`}
          >
            <X aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{upload.folder ? "Cancel sending" : "Cancel upload"}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * The uploads still on their way to the host for one surface, each with its
 * progress and a cancel button. Renders nothing until an upload has been
 * running long enough to be worth showing.
 *
 * A chip leaves when its upload settles, a moment after its cancel, or on its
 * own when the upload finishes. If its cancel button held focus, focus moves to
 * the next chip's cancel, else the previous one's, else `onReturnFocus`, rather
 * than falling to the document.
 */
export function PendingUploadChips({
  surface,
  className,
  onReturnFocus,
}: {
  surface: string;
  className?: string;
  /** Puts focus back in the surface the chips belong to once the last one leaves. */
  onReturnFocus?: () => void;
}) {
  const uploads = usePendingUploads(surface).filter((upload) => upload.visible);
  const buttonsRef = useRef(new Map<number, HTMLButtonElement>());
  const orderRef = useRef<readonly number[]>([]);
  const strandedRef = useRef<number | null>(null);

  const onMount = useCallback((id: number, button: HTMLButtonElement) => {
    buttonsRef.current.set(id, button);
  }, []);
  const onLeave = useCallback((id: number, hadFocus: boolean) => {
    buttonsRef.current.delete(id);
    if (hadFocus) strandedRef.current = id;
  }, []);

  // Every commit: the chips' cleanups have run, so a chip that left holding
  // focus has said so, and the order it left from is still the last one seen.
  useLayoutEffect(() => {
    const left = strandedRef.current;
    strandedRef.current = null;
    const before = orderRef.current;
    orderRef.current = uploads.map((upload) => upload.id);
    if (left === null || buttonsRef.current.has(left)) return;
    // Something else took focus in the meantime; it stays there.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const at = before.indexOf(left);
    const neighbours = at < 0 ? [] : [...before.slice(at + 1), ...before.slice(0, at).reverse()];
    for (const id of neighbours) {
      const button = buttonsRef.current.get(id);
      if (!button) continue;
      // The handoff is not the user arriving at that button, so its tooltip
      // stays shut.
      armTooltipFocusSuppression();
      button.focus();
      return;
    }
    onReturnFocus?.();
  });

  if (uploads.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-pending-uploads={surface}
    >
      {uploads.map((upload) => (
        <UploadChip key={upload.id} upload={upload} onMount={onMount} onLeave={onLeave} />
      ))}
    </div>
  );
}
