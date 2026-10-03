import { cn } from "@/lib/utils";
import { LIST_DETAIL_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { CountBadge } from "@/components/ui/badge";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import type { TriageCategory } from "@shared/types/ipc/triage";
import type { TriageItem } from "./triageModel";

/** What a run is doing when the readers have nothing better to say. */
export const KIND_LABEL: Record<TriageCategory, string> = {
  approval: "Wants approval",
  question: "Asking you",
  error: "Stopped on an error",
  finished: "Finished",
  working: "Working",
  running: "Running",
  idle: "Idle",
};

/** The row's headline: what is needed, or what is happening. */
export function rowStatus(item: TriageItem): string {
  const card = item.card;
  if (card?.headline) return card.headline;
  if (card?.question) return card.question;
  if ((item.kind === "working" || item.kind === "running") && card?.activity) return card.activity;
  return KIND_LABEL[item.kind];
}

interface TriageRowProps {
  item: TriageItem;
  domId: string;
  isSelected: boolean;
  /** Needs the user and not opened since it was last read off the screen. */
  unread: boolean;
  onSelect: () => void;
  /** A click on the row: the user opened it. */
  onClick: () => void;
  onOpen: () => void;
}

/**
 * One agent in the inbox, laid out like Pilot's run rows: state and agent on
 * the left; who and where, what it needs, and the readers' summary under that;
 * its priority and age on the right. A click opens its terminal beside the list.
 */
export function TriageRow({
  item,
  domId,
  isSelected,
  unread,
  onSelect,
  onClick,
  onOpen,
}: TriageRowProps) {
  const { row } = item;
  const status = rowStatus(item);
  const summary = item.card?.summary ?? null;
  // Only the models' reading is a priority; a run not read yet shows none.
  const priority = item.card?.priority ?? null;
  const where = [item.workspace.name, row.worktreeLabel].filter(Boolean).join(" · ");
  const accessibleName = [
    row.title,
    where,
    status,
    summary,
    priority === null ? null : `priority ${priority}`,
    row.agePhrase,
    unread ? "unread" : null,
  ]
    .filter((part): part is string => part !== null && part !== undefined && part !== "")
    .join(", ");

  return (
    <div
      id={domId}
      role="option"
      aria-selected={isSelected}
      aria-label={accessibleName}
      tabIndex={isSelected ? 0 : -1}
      data-triage-card=""
      data-kind={item.kind}
      data-unread={unread ? "true" : undefined}
      onFocus={() => {
        if (!isSelected) onSelect();
      }}
      onClick={() => {
        onSelect();
        onClick();
      }}
      onDoubleClick={onOpen}
      className={cn(
        LIST_DETAIL_ROW_CLASS,
        "flex w-full shrink-0 cursor-pointer items-start gap-2 rounded-[var(--radius-md)] py-2 pr-3 pl-3 text-left",
        // The neutral menu-row ring, inset because the list scrolls: never the
        // accent on a list that holds focus the whole time the panel is open.
        "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:-outline-offset-2"
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center self-start pt-1">
        {/* Daintree's own observation, never the classifier's reading. */}
        <PilotRunState band={row.band} agentState={row.run.agentState} />
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center self-start pt-0.5">
        <TerminalIcon
          chrome={row.chrome}
          className="h-4 w-4"
          brandColor={row.presetColor ?? row.chrome.color}
        />
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm leading-5">
          <span
            className={cn(
              "min-w-0 shrink truncate",
              unread ? "font-semibold text-text-primary" : "text-text-secondary"
            )}
          >
            {row.title}
          </span>
          <span className="min-w-0 shrink-[2] truncate text-xs text-text-secondary">{where}</span>
        </span>
        <span
          className={cn(
            "line-clamp-2 text-xs leading-4",
            unread ? "text-text-primary" : "text-text-secondary"
          )}
        >
          {status}
        </span>
        {summary !== null && summary !== status && (
          <span className="line-clamp-2 text-xs leading-4 text-text-secondary">{summary}</span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="flex min-w-[3.5rem] shrink-0 flex-col items-end gap-1 pt-0.5 text-right"
      >
        <span className="text-2xs leading-none whitespace-nowrap text-text-secondary tabular-nums">
          {row.age ?? ""}
        </span>
        {priority !== null && <CountBadge>{priority}</CountBadge>}
      </span>
    </div>
  );
}
