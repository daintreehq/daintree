import { useRef, useState } from "react";
import { Cable, CircleX, Unplug } from "@/components/icons";
import { RefreshCw } from "lucide-react";
import type { ProjectAttachmentObservation, WorktreeAttachment } from "@shared/types/worktree";
import { cn } from "@/lib/utils";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { failureLabel, visibleAttachmentChips, type AttachmentChipState } from "./attachmentState";

export interface WorktreeAttachmentChipsProps {
  attachments: readonly WorktreeAttachment[] | undefined;
  onAction: (name: string, action: "detach" | "status") => void;
}

const OBSERVATION_VERB: Record<ProjectAttachmentObservation["action"], string> = {
  attach: "Attached",
  detach: "Detached",
  status: "Checked",
  removed: "Removed",
};

function ObservationOutput({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs text-text-secondary">{label}</span>
      {/* The vertical padding sits outside the scroller so overflowing text
          never paints into it. */}
      <div className="rounded-[var(--radius-md)] border border-border-default bg-surface-canvas py-1.5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-primary">
        <pre
          tabIndex={0}
          role="region"
          aria-label={label}
          // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the well wrapper paints this region's focus ring via has-[:focus-visible]; a ring on the scroller would sit inside the wrapper's border and double it
          className="max-h-[10lh] overflow-y-auto whitespace-pre-wrap break-words px-2 font-mono text-2xs leading-relaxed text-text-primary outline-hidden"
        >
          {text}
        </pre>
      </div>
    </div>
  );
}

function ObservationBlock({
  observation,
  outputLabel,
}: {
  observation: ProjectAttachmentObservation;
  outputLabel: string;
}) {
  const failed = observation.state !== "success";
  const output = observation.output?.trim();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-text-secondary">
        {failed && <CircleX className="size-3.5 shrink-0 text-status-error" aria-hidden="true" />}
        <span className={cn(failed && "font-medium text-text-primary")}>
          {failed ? failureLabel(observation) : OBSERVATION_VERB[observation.action]}
        </span>
        <TimeAgo timestamp={observation.at} className="text-text-secondary" />
      </div>
      {failed && observation.error && (
        <p className="break-words text-text-secondary">{observation.error}</p>
      )}
      {output && <ObservationOutput label={outputLabel} text={output} />}
    </div>
  );
}

function AttachmentChip({
  attachment,
  state,
  showName,
  onAction,
}: {
  attachment: WorktreeAttachment;
  state: AttachmentChipState;
  /** Off when several chips share the header; the tooltip and label still name it. */
  showName: boolean;
  onAction: WorktreeAttachmentChipsProps["onAction"];
}) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerLabel = `${attachment.name} attachment: ${state.label}`;
  const busy = !!attachment.busy;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-no-dnd
              aria-label={triggerLabel}
              className="-my-[5px] inline-flex h-6 min-w-0 max-w-28 shrink items-center gap-1 rounded-[var(--radius-sm)] px-1 text-xs text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              {state.tone === "error" ? (
                <CircleX className="size-3.5 shrink-0 text-status-error" aria-hidden="true" />
              ) : (
                <Cable
                  className={cn(
                    "size-3.5 shrink-0",
                    state.tone === "working"
                      ? "animate-activity-pulse text-activity-working"
                      : "text-text-secondary"
                  )}
                  aria-hidden="true"
                />
              )}
              {showName && <span className="min-w-0 truncate">{attachment.name}</span>}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{`${attachment.name} · ${state.label}`}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] p-0 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        aria-label={`${attachment.name} attachment`}
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="flex items-baseline justify-between gap-3 px-3 pt-3">
          <span className="min-w-0 truncate font-semibold text-text-primary">
            {attachment.name}
          </span>
          <span className="shrink-0 font-medium text-text-secondary">{state.label}</span>
        </div>
        <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
          {attachment.lastResult && (
            <ObservationBlock observation={attachment.lastResult} outputLabel="Command output" />
          )}
          {attachment.status && (
            <ObservationBlock observation={attachment.status} outputLabel="Status output" />
          )}
          {attachment.heldHere && (
            <div className="-ml-3 flex items-center gap-1">
              {attachment.hasStatusCommand && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="focus-visible:-outline-offset-2"
                  disabled={busy}
                  onClick={() => onAction(attachment.name, "status")}
                >
                  <RefreshCw aria-hidden="true" />
                  Check status
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="focus-visible:-outline-offset-2"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onAction(attachment.name, "detach");
                }}
              >
                <Unplug aria-hidden="true" />
                Detach
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The card's attachment chips: one for each attachment this worktree holds,
 * and one for a command that failed here, so a failed attach stays visible on
 * the worktree it was meant for rather than vanishing (#13703).
 */
export function WorktreeAttachmentChips({ attachments, onAction }: WorktreeAttachmentChipsProps) {
  const chips = visibleAttachmentChips(attachments);
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map(({ attachment, state }) => (
        <AttachmentChip
          key={attachment.name}
          attachment={attachment}
          state={state}
          showName={chips.length === 1}
          onAction={onAction}
        />
      ))}
    </>
  );
}
