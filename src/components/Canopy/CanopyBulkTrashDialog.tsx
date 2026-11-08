import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { pluralize } from "@/lib/pluralize";
import { CANOPY_TRASH_LIMIT } from "@shared/config/trash";
import type {
  CanopyInputLineReading,
  CanopyRunTarget,
  CanopyTrashOutcome,
} from "@shared/types/ipc/canopy";
import { itemSubject, type CanopyItem } from "./canopyModel";
import {
  BULK_TRASH_HOLD_LABEL,
  bulkTrashHold,
  bulkTrashTarget,
  inputLinesByRun,
  type BulkTrashHold,
} from "./canopyBulkTrash";

/** How long the review waits on the hosts' input-line reads before it stops asking. */
export const BULK_TRASH_CHECK_MS = 5_000;

/** One search result as the review opened on it. */
export interface BulkTrashEntry {
  item: CanopyItem;
  /** The host it runs on, by name, when the panel shows more than the window's own. */
  host: string | null;
  /** The panel's reply holds text for it. */
  replyDraft: boolean;
}

type Phase = "checking" | "review" | "running" | "done";

interface Review {
  holds: ReadonlyMap<string, BulkTrashHold>;
  /** Runs whose input line no host answered for. */
  unchecked: ReadonlySet<string>;
}

/**
 * The search's results, reviewed before they go to the Trash: each run named
 * with its project, host and observed state, ticked unless something seen
 * says the person may still want it. The results are the ones listed when it
 * opened: a run matching later is not in this review.
 */
export function CanopyBulkTrashDialog({
  isOpen,
  onClose,
  query,
  entries,
  more,
  readInputLines,
  onTrash,
  restoreFocusTo,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** The search the results are for, as typed. */
  query: string;
  entries: readonly BulkTrashEntry[];
  /** Results past the Trash's limit, left out of this review. */
  more: number;
  readInputLines: (targets: CanopyRunTarget[]) => Promise<CanopyInputLineReading[]>;
  onTrash: (items: readonly CanopyItem[]) => Promise<CanopyTrashOutcome[]>;
  restoreFocusTo?: () => HTMLElement | null;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [review, setReview] = useState<Review | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  // Each opening is a generation: an answer for an earlier one changes nothing.
  const generationRef = useRef(0);
  const readEntries = useEffectEvent(() => ({ entries, readInputLines }));

  useEffect(() => {
    if (!isOpen) return;
    const generation = ++generationRef.current;
    const { entries: shown, readInputLines: read } = readEntries();
    setPhase("checking");
    setReview(null);
    setTicked(new Set());
    setFailures(new Map());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), BULK_TRASH_CHECK_MS);
    });
    void Promise.race([
      read(shown.map(({ item }) => bulkTrashTarget(item))).catch(() => null),
      timedOut,
    ]).then((readings) => {
      if (generationRef.current !== generation) return;
      const lines = inputLinesByRun(readings ?? []);
      const holds = new Map<string, BulkTrashHold>();
      const unchecked = new Set<string>();
      const ticks = new Set<string>();
      for (const { item, replyDraft } of shown) {
        if (!lines.has(item.runId)) unchecked.add(item.runId);
        const hold = bulkTrashHold(item, lines.get(item.runId), replyDraft);
        if (hold === null) ticks.add(item.runId);
        else holds.set(item.runId, hold);
      }
      setReview({ holds, unchecked });
      setTicked(ticks);
      setPhase("review");
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      generationRef.current += 1;
    };
  }, [isOpen]);

  const toggle = (runId: string, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(runId);
      else next.delete(runId);
      return next;
    });
  const allTicked = entries.length > 0 && ticked.size === entries.length;
  const tickAll = (on: boolean) =>
    setTicked(on ? new Set(entries.map(({ item }) => item.runId)) : new Set());

  const trash = () => {
    const chosen = entries.filter(({ item }) => ticked.has(item.runId)).map(({ item }) => item);
    if (chosen.length === 0) return;
    const generation = generationRef.current;
    setPhase("running");
    void onTrash(chosen).then((outcomes) => {
      if (generationRef.current !== generation) return;
      const failed = new Map(
        outcomes.flatMap((outcome) =>
          "error" in outcome ? [[outcome.runId, outcome.error] as const] : []
        )
      );
      // All of them went: the panel's undo line says so, and the list shows it.
      if (failed.size === 0) {
        onClose();
        return;
      }
      setFailures(failed);
      setPhase("done");
    });
  };

  const reviewing = phase === "review";
  const sent = entries.filter(({ item }) => ticked.has(item.runId)).length;
  const trashedCount = sent - failures.size;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      dismissible={phase !== "running"}
      size="md"
      zIndex="nested"
      hasPreview
      restoreFocusTo={restoreFocusTo}
      // The rows it was opened from may be among those trashed, so the
      // caller's choice comes first, not the trigger.
      preferRestoreFocusTo={restoreFocusTo !== undefined}
    >
      <AppDialog.Header>
        <AppDialog.Title>{`Trash results for '${query}'?`}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-3">
        {phase !== "done" && (
          <AppDialog.Description>
            Ticked agents move to the Trash, where Restore brings each one back. Agents seen
            working, or with text typed or drafted, start unticked.
          </AppDialog.Description>
        )}
        {phase === "done" && (
          <p role="status" className="text-sm text-text-primary">
            Trashed {trashedCount} of {pluralize(sent, "agent")}. The rest are listed with why.
          </p>
        )}
        {phase !== "done" && entries.length > 1 && (
          <label className="flex items-center gap-2.5 text-sm text-text-primary">
            <Checkbox
              checked={allTicked ? true : ticked.size > 0 ? "indeterminate" : false}
              onCheckedChange={(state) => tickAll(state === true)}
              disabled={!reviewing}
              data-bulk-trash-all=""
            />
            Select all {entries.length}
          </label>
        )}
        <ul className="flex flex-col gap-1" data-bulk-trash-runs="">
          {entries.map(({ item, host }) => {
            const hold = review?.holds.get(item.runId);
            const failure = failures.get(item.runId);
            const went = phase === "done" && ticked.has(item.runId) && failure === undefined;
            const where = [item.row.statusLabel, item.workspace.name, host]
              .filter((part) => part !== null && part !== "")
              .join(" · ");
            const note =
              phase === "done"
                ? went
                  ? "Trashed"
                  : failure !== undefined
                    ? `Not trashed: ${failure}`
                    : "Left out"
                : hold !== undefined
                  ? BULK_TRASH_HOLD_LABEL[hold]
                  : review?.unchecked.has(item.runId)
                    ? "Its input couldn't be checked"
                    : null;
            return (
              <li
                key={item.runId}
                data-run-id={item.runId}
                data-hold={hold}
                data-outcome={
                  phase === "done" ? (went ? "trashed" : failure ? "failed" : "left") : undefined
                }
              >
                <label className="flex items-start gap-2.5 py-1">
                  <Checkbox
                    className="mt-0.5"
                    checked={ticked.has(item.runId)}
                    onCheckedChange={(state) => toggle(item.runId, state === true)}
                    disabled={!reviewing}
                    aria-label={itemSubject(item)}
                  />
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                    <PilotRunState band={item.row.band} agentState={item.row.run.agentState} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-text-primary">{itemSubject(item)}</span>
                    <span className="truncate text-xs text-text-secondary">{where}</span>
                    {note !== null && <span className="text-xs text-text-secondary">{note}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {more > 0 && phase !== "done" && (
          <p className="text-xs text-text-secondary">
            The Trash holds {CANOPY_TRASH_LIMIT} at a time, so {pluralize(more, "more result")}{" "}
            {more === 1 ? "isn't" : "aren't"} listed. Trash these first.
          </p>
        )}
      </AppDialog.Body>
      <AppDialog.Footer
        hint={phase === "checking" ? "Checking each terminal's input…" : undefined}
        secondaryAction={{
          label: phase === "done" ? "Close" : "Cancel",
          onClick: onClose,
          disabled: phase === "running",
        }}
        primaryAction={
          phase === "done"
            ? undefined
            : {
                label: `Trash ${pluralize(sent, "agent")}`,
                onClick: trash,
                disabled: !reviewing || sent === 0,
                loading: phase === "running",
              }
        }
      />
    </AppDialog>
  );
}
