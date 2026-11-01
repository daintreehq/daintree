import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { pluralNoun } from "@/lib/pluralize";
import {
  resolveScheduleRunConfirmation,
  useScheduleRunConfirmStore,
} from "@/store/scheduleRunConfirmStore";

/**
 * Singleton dialog for a Run now that found the schedule's earlier runs still
 * open (#15980). Nothing starts until the user picks: back out, or run under
 * the schedule's overlap policy, alongside the open runs (skip) or in their
 * place (replace).
 */
export function ScheduleRunConfirmDialog() {
  const current = useScheduleRunConfirmStore((state) => state.current);

  if (current === null) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        confirmLabel="Run anyway"
        onConfirm={() => {}}
        variant="default"
      />
    );
  }

  const { requestId, scheduleName, policy, openRunCount } = current;
  const runs = pluralNoun(openRunCount, "run");
  const single = openRunCount === 1;
  const shared = {
    isOpen: true,
    onClose: () => resolveScheduleRunConfirmation(requestId, false),
    onConfirm: () => resolveScheduleRunConfirmation(requestId, true),
    cancelLabel: "Cancel",
    // Running is the thing being questioned, so a reflexive Enter backs out.
    initialFocus: "cancel" as const,
    focusResetKey: requestId,
    bodyResetKey: requestId,
  };

  if (policy === "replace") {
    return (
      <ConfirmDialog
        {...shared}
        title={`Replace the open ${runs} of '${scheduleName}'?`}
        description={
          single
            ? "Running now closes the open run's terminal, keeping its session to resume, then starts a new run."
            : "Running now closes the open runs' terminals, keeping each session to resume, then starts a new run."
        }
        confirmLabel="Replace run"
        variant="destructive"
      />
    );
  }
  return (
    <ConfirmDialog
      {...shared}
      title={`Run '${scheduleName}' alongside its open ${runs}?`}
      description={`This schedule skips a run while an earlier one is open. Running anyway starts another agent beside ${single ? "it" : "them"}.`}
      confirmLabel="Run anyway"
      variant="default"
    />
  );
}
