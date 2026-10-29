import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { describeHeardAsConflicts } from "@/lib/heardAsConflictCopy";
import type { HeardAsConflict } from "@shared/types";
import { SettingsRowActions } from "./SettingsGroup";

/** The question the prompt asks, for a live region that outlives it to announce. */
export function heardAsMoveQuestion(term: string, conflicts: readonly HeardAsConflict[]): string {
  return `${describeHeardAsConflicts(conflicts)}. Move ${conflicts.length === 1 ? "it" : "them"} to ${term}?`;
}

/**
 * Asks before a dictionary add or edit takes heard-as phrases from the terms
 * they fire for. A phrase fires for one term only, so saving it beside
 * another would be a rule that never fires.
 */
export function HeardAsMovePrompt({
  term,
  conflicts,
  takesFocus = false,
  onMove,
  onCancel,
}: {
  term: string;
  conflicts: readonly HeardAsConflict[];
  /** Puts the keyboard on Cancel: the question replaced the control it was on. */
  takesFocus?: boolean;
  onMove: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Also when the keyboard was on nothing, as when the question arrives with a
  // Retry banner going away: it never moves focus the user put somewhere.
  useEffect(() => {
    const active = document.activeElement;
    if (takesFocus || !active || active === document.body) cancelRef.current?.focus();
  }, [takesFocus]);

  return (
    // Escape answers the question rather than reaching the dialog around it.
    <div
      className="space-y-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p className="text-sm text-text-secondary">{heardAsMoveQuestion(term, conflicts)}</p>
      <SettingsRowActions>
        <Button ref={cancelRef} size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="contrast" onClick={onMove}>
          {conflicts.length === 1 ? "Move phrase" : "Move phrases"}
        </Button>
      </SettingsRowActions>
    </div>
  );
}
