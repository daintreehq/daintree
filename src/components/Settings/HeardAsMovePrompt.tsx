import { Button } from "@/components/ui/button";
import { describeHeardAsConflicts } from "@/lib/heardAsConflictCopy";
import type { HeardAsConflict } from "@shared/types";
import { SettingsRowActions } from "./SettingsGroup";

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
  /** Puts the keyboard on Cancel when the question replaces the control it was on. */
  takesFocus?: boolean;
  onMove: () => void;
  onCancel: () => void;
}) {
  const one = conflicts.length === 1;
  return (
    <div className="space-y-2">
      <p className="text-sm text-text-secondary">
        {describeHeardAsConflicts(conflicts)}. Move {one ? "it" : "them"} to {term}?
      </p>
      <SettingsRowActions>
        <Button size="sm" variant="outline" onClick={onCancel} autoFocus={takesFocus}>
          Cancel
        </Button>
        <Button size="sm" variant="contrast" onClick={onMove}>
          {one ? "Move phrase" : "Move phrases"}
        </Button>
      </SettingsRowActions>
    </div>
  );
}
