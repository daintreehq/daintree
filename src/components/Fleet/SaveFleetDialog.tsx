import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { TriangleAlert } from "lucide-react";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { FIELD_CONTROL_SIZE, FIELD_INPUT, FormGrid, FormRow } from "@/components/Worktree/views";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { actionService } from "@/services/ActionService";
import { computeSavedScopePaneCount } from "@/services/actions/definitions/fleetActions";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { PredicateFleetSavedScope } from "@shared/types";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import { pluralize } from "@/lib/pluralize";

type SaveFleetKind = "snapshot" | "predicate";
type RuleState = PredicateFleetSavedScope["stateFilter"];
type RuleScope = PredicateFleetSavedScope["scope"];

interface SaveFleetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  armedCount: number;
  restoreFocusTo?: RestoreFocusTarget;
}

function savedIds(): Set<string> {
  const scopes = useProjectSettingsStore.getState().settings?.fleetSavedScopes ?? [];
  return new Set(scopes.map((s) => s.id));
}

/**
 * Names the armed selection (a snapshot) or a state filter (a live rule) for
 * later recall. A dialog rather than a form inside the selection menu: a menu
 * owns arrows, Space, Tab and typeahead, so the inline form was unreachable
 * from the keyboard and fought the menu for every key it did receive.
 */
export function SaveFleetDialog({
  isOpen,
  onClose,
  armedCount,
  restoreFocusTo,
}: SaveFleetDialogProps): ReactElement {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SaveFleetKind>("snapshot");
  const [ruleState, setRuleState] = useState<RuleState>("waiting");
  const [ruleScope, setRuleScope] = useState<RuleScope>("current");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const stateId = useId();
  const scopeId = useId();
  const kindHintId = useId();

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setKind("snapshot");
    setFailed(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen]);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && (kind !== "snapshot" || armedCount > 0) && !saving;

  // What the rule would select right now, so the user sees the result of the
  // filter before naming it — the same count the saved row will show.
  // A primitive-valued selection over the panel registry, plus the active
  // worktree the "this worktree" scope reads — the preview has to move on its
  // own, since the ribbon that hosts this dialog may no longer be rendering.
  useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const ruleMatchCount = usePanelStore(() =>
    kind === "predicate"
      ? computeSavedScopePaneCount({
          kind: "predicate",
          id: "",
          name: "",
          scope: ruleScope,
          stateFilter: ruleState,
          createdAt: 0,
        })
      : 0
  );

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setFailed(false);
    const before = savedIds();
    const args =
      kind === "snapshot"
        ? { kind: "snapshot" as const, name: trimmed }
        : { kind: "predicate" as const, name: trimmed, scope: ruleScope, stateFilter: ruleState };
    try {
      await actionService.dispatch("fleet.saveNamedFleet", args, { source: "user" });
    } catch {
      // Reported by the dispatcher; the unchanged list below reads as a failure.
    }
    // Always unlocks: the dialog can't be dismissed while this is set.
    setSaving(false);
    // The action rolls its in-memory append back when the write fails, so a
    // new id surviving the await is the success signal. Keep the draft on
    // failure rather than discarding what the user typed.
    const after = savedIds();
    const added = [...after].some((id) => !before.has(id));
    if (added) {
      onClose();
    } else {
      setFailed(true);
    }
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      dismissible={!saving}
      initialFocus="none"
      restoreFocusTo={restoreFocusTo}
      data-testid="fleet-save-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Save fleet</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <FormGrid>
          <FormRow label="Name" htmlFor={nameId}>
            <input
              ref={inputRef}
              id={nameId}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFailed(false);
              }}
              onKeyDown={(e) => {
                if (isEnterToSubmit(e)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              className={FIELD_INPUT}
              data-testid="fleet-save-form-name"
            />
          </FormRow>

          <FormRow
            label="Type"
            selfLabelled
            hint={
              <p id={kindHintId} className="text-xs text-text-secondary">
                {kind === "snapshot"
                  ? `The ${pluralize(armedCount, "pane")} armed now. Panes you close drop out of it.`
                  : `Whichever panes match when you recall it. ${pluralize(ruleMatchCount, "pane matches", "panes match")} now.`}
              </p>
            }
          >
            <SegmentedRadioGroup<SaveFleetKind>
              aria-label="Fleet type"
              aria-describedby={kindHintId}
              options={[
                { value: "snapshot", label: "Snapshot" },
                { value: "predicate", label: "Live rule" },
              ]}
              value={kind}
              onChange={setKind}
              fullWidth
            />
          </FormRow>

          {kind === "predicate" && (
            <>
              <FormRow label="Panes" htmlFor={stateId}>
                <Select
                  value={ruleState}
                  onValueChange={(v) => {
                    if (v === "all" || v === "waiting" || v === "working" || v === "finished") {
                      setRuleState(v);
                    }
                  }}
                >
                  <SelectTrigger
                    id={stateId}
                    className={FIELD_CONTROL_SIZE}
                    data-testid="fleet-save-rule-state"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="waiting">Waiting</SelectItem>
                    <SelectItem value="working">Working</SelectItem>
                    <SelectItem value="finished">Finished</SelectItem>
                    <SelectItem value="all">All panes</SelectItem>
                  </SelectContent>
                </Select>
              </FormRow>
              <FormRow label="In" htmlFor={scopeId}>
                <Select
                  value={ruleScope}
                  onValueChange={(v) => {
                    if (v === "current" || v === "all") setRuleScope(v);
                  }}
                >
                  <SelectTrigger
                    id={scopeId}
                    className={FIELD_CONTROL_SIZE}
                    data-testid="fleet-save-rule-scope"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current">This worktree (whichever is active)</SelectItem>
                    <SelectItem value="all">All worktrees</SelectItem>
                  </SelectContent>
                </Select>
              </FormRow>
            </>
          )}
        </FormGrid>

        {failed && (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-text-secondary">
            <TriangleAlert
              className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
              aria-hidden="true"
            />
            <span>Couldn&apos;t save the fleet. Try again.</span>
          </p>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        hint={
          kind === "snapshot" && armedCount === 0
            ? "Arm panes to save a snapshot"
            : trimmed.length === 0
              ? "Name the fleet to save it"
              : undefined
        }
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: saving }}
        primaryAction={{
          label: "Save fleet",
          onClick: () => void submit(),
          disabled: !canSave,
          loading: saving,
        }}
      />
    </AppDialog>
  );
}
