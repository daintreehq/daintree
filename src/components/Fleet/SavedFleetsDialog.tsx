import { useLayoutEffect, useRef, type ReactElement } from "react";
import { Trash2 } from "lucide-react";
import type { FleetSavedScope } from "@shared/types";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { cn } from "@/lib/utils";
import { useSavedFleets } from "./useSavedFleets";
import { deleteSavedFleetWithUndo } from "./deleteSavedFleet";
import { describeRule, formatSavedFleetCount, savedFleetAccessibleName } from "./savedFleetMeta";

interface SavedFleetsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  restoreFocusTo?: RestoreFocusTarget;
}

/**
 * Every saved fleet with its two actions as ordinary buttons: Arm and Delete.
 * The selection menu stays the fast path for recall, but a menu row can hold
 * only one action, and the menu only exists once two panes are armed — so this
 * is where cleanup lives, reachable from the menu and from the cold-start
 * picker alike.
 */
export function SavedFleetsDialog({
  isOpen,
  onClose,
  restoreFocusTo,
}: SavedFleetsDialogProps): ReactElement {
  const { snapshotUsable, snapshotStale, rules, countById } = useSavedFleets();
  const snapshots = [...snapshotUsable, ...snapshotStale];
  const isEmpty = snapshots.length + rules.length === 0;

  // The Delete button goes with its row, so focus moves to the next row's
  // Delete, or the one before it, or the close button once the list is empty.
  // Repaired when the row actually leaves (the delete is optimistic, the save
  // is not) and only if focus went down with it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<{ deletedId: string; neighbourId: string | null } | null>(null);
  const listedIds = [...snapshots, ...rules].map((s) => s.id);
  const listedKey = listedIds.join("\n");
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || listedKey.split("\n").includes(pending.deletedId)) return;
    pendingFocusRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const dialog = bodyRef.current?.closest('[role="dialog"]');
    const target =
      (pending.neighbourId !== null &&
        dialog?.querySelector<HTMLElement>(
          `[data-fleet-delete="${CSS.escape(pending.neighbourId)}"]`
        )) ||
      dialog?.querySelector<HTMLElement>('button[aria-label="Close dialog"]');
    target?.focus();
  }, [listedKey]);

  const handleDelete = (scope: FleetSavedScope) => {
    const at = listedIds.indexOf(scope.id);
    pendingFocusRef.current = {
      deletedId: scope.id,
      neighbourId: listedIds[at + 1] ?? listedIds[at - 1] ?? null,
    };
    void deleteSavedFleetWithUndo(scope).finally(() => {
      // A delete that never landed leaves the row, and its focus, where they were.
      if (pendingFocusRef.current?.deletedId === scope.id) pendingFocusRef.current = null;
    });
  };

  const renderRow = (scope: FleetSavedScope) => {
    const count = countById[scope.id] ?? 0;
    const unavailable = count === 0;
    return (
      <li
        key={scope.id}
        className="flex h-9 items-center gap-3 border-t border-border-subtle first:border-t-0"
        data-testid="fleet-saved-manage-row"
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            unavailable ? "text-text-secondary" : "text-text-primary"
          )}
          title={scope.name}
        >
          {scope.name}
        </span>
        <span className="flex shrink-0 items-center gap-3 text-xs text-text-secondary">
          {scope.kind === "predicate" && <span>{describeRule(scope)}</span>}
          <span className="tabular-nums">{formatSavedFleetCount(scope, count)}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={unavailable}
          aria-label={`Arm ${savedFleetAccessibleName(scope, count)}`}
          onClick={() => {
            void actionService.dispatch(
              "fleet.recallNamedFleet",
              { id: scope.id },
              { source: "user" }
            );
            onClose();
          }}
          data-testid="fleet-saved-manage-arm"
        >
          Arm
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete fleet "${scope.name}"`}
          onClick={() => handleDelete(scope)}
          data-testid="fleet-saved-manage-delete"
          data-fleet-delete={scope.id}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </li>
    );
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      restoreFocusTo={restoreFocusTo}
      data-testid="fleet-saved-manage-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Saved fleets</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div ref={bodyRef}>
          {isEmpty ? (
            <p className="text-sm text-text-secondary">
              Arm two or more panes, then choose Save as fleet… from the fleet menu.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {snapshots.length > 0 && (
                <section aria-labelledby="fleet-saved-manage-snapshots">
                  <h3
                    id="fleet-saved-manage-snapshots"
                    className="mb-1 text-xs font-medium text-text-secondary"
                  >
                    Snapshots
                  </h3>
                  <ul>{snapshots.map(renderRow)}</ul>
                </section>
              )}
              {rules.length > 0 && (
                <section aria-labelledby="fleet-saved-manage-rules">
                  <h3
                    id="fleet-saved-manage-rules"
                    className="mb-1 text-xs font-medium text-text-secondary"
                  >
                    Live rules
                  </h3>
                  <ul>{rules.map(renderRow)}</ul>
                </section>
              )}
            </div>
          )}
        </div>
      </AppDialog.Body>
    </AppDialog>
  );
}
