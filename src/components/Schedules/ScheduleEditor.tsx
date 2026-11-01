import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsDependents, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { SettingsTextarea } from "@/components/Settings/SettingsTextarea";
import { SettingsSelect, type SettingsSelectOption } from "@/components/Settings/SettingsSelect";
import { SettingsPresetGroup } from "@/components/Settings/SettingsPresetGroup";
import { SettingsCheckbox } from "@/components/Settings/SettingsCheckbox";
import { resolveAgentIcon } from "@/config/agentIcons";
import { pluralize } from "@/lib/pluralize";
import { actionService } from "@/services/ActionService";
import { schedulesClient } from "@/clients/schedulesClient";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { machineTimeZone } from "@shared/utils/cron";
import { describeParsedCron } from "@shared/utils/cronDescription";
import { createSchedule, validateCadence } from "@shared/utils/scheduledRuns";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  Schedule,
  ScheduleDonePolicy,
  ScheduleMissedRunPolicy,
  ScheduleOverlapPolicy,
} from "@shared/types/scheduledRuns";
import type { ScheduleIssue } from "@shared/utils/scheduleValidation";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { logError } from "@/utils/logger";
import { useFirstAgentOptions } from "@/components/Worktree/hooks/useFirstAgentOptions";
import { useScheduleLaunchOptions } from "./useScheduleLaunchOptions";
import {
  DONE_CONSEQUENCE,
  DONE_OPTIONS,
  MISSED_RUN_CONSEQUENCE,
  MISSED_RUN_OPTIONS,
  OVERLAP_CONSEQUENCE,
  OVERLAP_OPTIONS,
  formatNextRunRelative,
  formatRunInstant,
  nextRunAt,
} from "./scheduleWords";

export interface WorktreeChoice {
  /** Null is the project's main checkout. */
  id: string | null;
  label: string;
}

/** What leaving the page would cost, read by the dialog before it lets the page go. */
export interface EditorLeaveState {
  dirty: boolean;
  saving: boolean;
  isNew: boolean;
  name: string;
}

interface Draft {
  name: string;
  agentId: string;
  presetId: string | null;
  prompt: string;
  worktreeId: string | null;
  cron: string;
  missedRuns: ScheduleMissedRunPolicy;
  overlap: ScheduleOverlapPolicy;
  checkFirst: boolean;
  checkCommand: string;
  onDone: ScheduleDonePolicy;
}

function draftFrom(schedule: Schedule): Draft {
  return {
    name: schedule.name,
    agentId: schedule.launch.agentId,
    presetId: schedule.launch.presetId,
    prompt: schedule.launch.prompt,
    worktreeId: schedule.launch.worktreeId,
    cron: schedule.cadence.cron,
    missedRuns: schedule.policies.missedRuns,
    overlap: schedule.policies.overlap,
    checkFirst: schedule.policies.precondition !== null,
    checkCommand: schedule.policies.precondition?.command ?? "",
    onDone: schedule.policies.onDone,
  };
}

/** A new schedule's draft carries #15974's defaults, read from the one place they live. */
function blankDraft(agentId: string): Draft {
  return draftFrom(
    createSchedule({ id: "", projectId: "", name: "", launch: { agentId, prompt: "" } })
  );
}

const DRAFT_KEYS: readonly (keyof Draft)[] = [
  "name",
  "agentId",
  "presetId",
  "prompt",
  "worktreeId",
  "cron",
  "missedRuns",
  "overlap",
  "checkFirst",
  "checkCommand",
  "onDone",
];

function sameDraft(a: Draft, b: Draft): boolean {
  return DRAFT_KEYS.every((key) => a[key] === b[key]);
}

type FieldKey = "name" | "agentId" | "prompt" | "cron" | "checkCommand";

/** Form order, so a failed save lands on the first problem a reader would reach. */
const FIELD_ORDER: readonly FieldKey[] = ["name", "agentId", "prompt", "cron", "checkCommand"];

const FIELD_ROW: Record<FieldKey, string> = {
  name: "schedule-field-name",
  agentId: "schedule-field-agent",
  prompt: "schedule-field-prompt",
  cron: "schedule-field-cadence",
  checkCommand: "schedule-field-check-command",
};

const ISSUE_FIELD: Record<string, FieldKey> = {
  name: "name",
  "launch.prompt": "prompt",
  "launch.agentId": "agentId",
  "cadence.cron": "cron",
  "policies.precondition.command": "checkCommand",
};

/** The same reasons main gives, checked here so a field says what's wrong before Save. */
function localIssues(draft: Draft): Partial<Record<FieldKey, string>> {
  const issues: Partial<Record<FieldKey, string>> = {};
  if (draft.name.trim() === "") issues.name = "Name the schedule";
  if (draft.agentId === "") issues.agentId = "Choose an agent";
  if (draft.prompt.trim() === "") issues.prompt = "Enter a prompt for the agent";
  const cron = validateCadence({ cron: draft.cron, timeZone: "UTC" });
  if (!cron.ok) issues.cron = cron.error.message;
  if (draft.checkFirst && draft.checkCommand.trim() === "") {
    issues.checkCommand = "Enter a command, or turn the check off";
  }
  return issues;
}

function focusField(key: FieldKey): void {
  const row = document.getElementById(FIELD_ROW[key]);
  row?.querySelector<HTMLElement>("input, textarea, button")?.focus();
}

interface ScheduleEditorProps {
  /** Null for a new schedule. */
  schedule: Schedule | null;
  defaultAgentId: string;
  worktrees: readonly WorktreeChoice[];
  now: number;
  /** Kept current every render, so the dialog can guard Back, Cancel and dismissal. */
  leaveStateRef: RefObject<EditorLeaveState | null>;
  onSaved: (snapshot: SchedulesSnapshot, scheduleId: string) => void;
  onDeleted: (snapshot: SchedulesSnapshot, deletedId: string) => void;
  onCancel: () => void;
}

const MAIN_CHECKOUT_VALUE = "__main__";
/** How long the cadence must sit still before its words or error are read out. */
const CADENCE_ANNOUNCE_SETTLE_MS = 600;
const NO_PRESET_VALUE = "__none__";

export function ScheduleEditor({
  schedule,
  defaultAgentId,
  worktrees,
  now,
  leaveStateRef,
  onSaved,
  onDeleted,
  onCancel,
}: ScheduleEditorProps) {
  const [base, setBase] = useState<Schedule | null>(schedule);
  const initial = useMemo(
    () => (base ? draftFrom(base) : blankDraft(defaultAgentId)),
    [base, defaultAgentId]
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [serverIssues, setServerIssues] = useState<ScheduleIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Schedule | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [submitSummary, setSubmitSummary] = useState("");
  const loadLatestRef = useRef<HTMLButtonElement>(null);

  const agents = useFirstAgentOptions();
  const { presets, preset, stopsAtPrompts } = useScheduleLaunchOptions(
    draft.agentId,
    draft.presetId
  );

  const isNew = base === null;
  const dirty = !sameDraft(draft, initial);
  const issues = localIssues(draft);

  useEffect(() => {
    leaveStateRef.current = { dirty, saving, isNew, name: base?.name ?? draft.name };
  });
  useEffect(() => () => void (leaveStateRef.current = null), [leaveStateRef]);

  useEffect(() => {
    if (conflict) loadLatestRef.current?.focus();
  }, [conflict]);

  const serverError = (key: FieldKey) =>
    serverIssues.find((issue) => ISSUE_FIELD[issue.path] === key)?.message;
  const errorFor = (key: FieldKey): string | undefined =>
    serverError(key) ?? (attempted || touched[key] ? issues[key] : undefined);
  const markTouched = (key: FieldKey) => setTouched((prev) => ({ ...prev, [key]: true }));
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setServerIssues((prev) => prev.filter((issue) => ISSUE_FIELD[issue.path] !== key));
    setSaveError(null);
    setSubmitSummary("");
  };

  const timeZone = base?.cadence.timeZone ?? machineTimeZone();
  const cadence = validateCadence({ cron: draft.cron, timeZone });
  const cadenceWordsNow = cadence.ok ? describeParsedCron(cadence.cron) : null;
  const nextRun = cadence.ok ? nextRunAt({ cron: draft.cron, timeZone }, now) : null;
  const cadenceDescription = (() => {
    if (!cadence.ok) return "Five fields: minute, hour, day of month, month, day of week";
    const parts = [
      cadenceWordsNow,
      nextRun === null ? null : `next ${formatRunInstant(nextRun, timeZone)}`,
      `times in ${timeZone}`,
    ].filter(Boolean);
    const sentence = parts.join(" · ");
    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
  })();

  // Read out once typing settles: the cadence in words while it's valid, and which
  // cron field is wrong while it isn't, so a change between two bad values is heard.
  const cronError = errorFor("cron");
  const cadenceLive = cadence.ok ? cadenceDescription : cronError ? `Cadence: ${cronError}` : "";
  const [settledCadenceLive, setSettledCadenceLive] = useState(cadenceLive);
  useEffect(() => {
    const timer = setTimeout(() => setSettledCadenceLive(cadenceLive), CADENCE_ANNOUNCE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [cadenceLive]);

  const agentOptions: SettingsSelectOption[] = agents.map((agent) => ({
    value: agent.id,
    label: agent.name,
    icon: resolveAgentIcon(agent.iconId),
  }));
  if (draft.agentId && !agents.some((agent) => agent.id === draft.agentId)) {
    const config = getEffectiveAgentConfig(draft.agentId);
    agentOptions.push({
      value: draft.agentId,
      label: `${config?.name ?? draft.agentId} (not installed)`,
      icon: resolveAgentIcon(config?.iconId ?? draft.agentId),
    });
  }

  // Radix Select can't hold an empty value, so "no preset" travels as a sentinel.
  const presetOptions: SettingsSelectOption[] = [
    { value: NO_PRESET_VALUE, label: "No preset" },
    ...presets.map((p) => ({ value: p.id, label: p.name })),
  ];
  const presetMissing = draft.presetId !== null && preset === undefined;
  if (presetMissing) {
    presetOptions.push({ value: draft.presetId!, label: "Missing preset" });
  }

  const worktreeOptions: SettingsSelectOption[] = worktrees.map((choice) => ({
    value: choice.id ?? MAIN_CHECKOUT_VALUE,
    label: choice.label,
  }));
  if (draft.worktreeId !== null && !worktrees.some((choice) => choice.id === draft.worktreeId)) {
    worktreeOptions.push({ value: draft.worktreeId, label: "Missing worktree" });
  }

  const agentName = getEffectiveAgentConfig(draft.agentId)?.name ?? "This agent";

  const save = async () => {
    setAttempted(true);
    const invalid = FIELD_ORDER.filter((key) => issues[key] !== undefined);
    if (invalid.length > 0) {
      setSubmitSummary(
        `Fix ${pluralize(invalid.length, "field")} to ${isNew ? "create this schedule" : "save your changes"}`
      );
      focusField(invalid[0]!);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSubmitSummary("");
    const policies = {
      missedRuns: draft.missedRuns,
      overlap: draft.overlap,
      precondition: draft.checkFirst ? { command: draft.checkCommand } : null,
      onDone: draft.onDone,
    };
    const launch = {
      agentId: draft.agentId,
      presetId: draft.presetId,
      prompt: draft.prompt,
      worktreeId: draft.worktreeId,
    };
    const refused = (found: ScheduleIssue[]) => {
      setServerIssues(found);
      const first = FIELD_ORDER.find((key) =>
        found.some((issue) => ISSUE_FIELD[issue.path] === key)
      );
      setSubmitSummary(`Fix ${pluralize(found.length, "field")} to save this schedule`);
      if (first) requestAnimationFrame(() => focusField(first));
    };
    try {
      if (base === null) {
        const outcome = await schedulesClient.create({
          name: draft.name,
          launch,
          cron: draft.cron,
          policies,
        });
        if (outcome.status === "invalid") refused(outcome.issues);
        else onSaved(outcome.snapshot, outcome.schedule.id);
      } else {
        const outcome = await schedulesClient.update(base.id, base.updatedAt, {
          name: draft.name,
          cadence: { cron: draft.cron, timeZone: base.cadence.timeZone },
          launch,
          policies: { ...policies, runWhenClosed: base.policies.runWhenClosed },
        });
        switch (outcome.status) {
          case "saved":
            onSaved(outcome.snapshot, outcome.schedule.id);
            break;
          case "invalid":
            refused(outcome.issues);
            break;
          case "conflict":
            setConflict(outcome.schedule);
            break;
          case "not-found":
            setSaveError("This schedule was deleted in another window, so there's nothing to save");
            break;
        }
      }
    } catch (error) {
      logError("Failed to save schedule", error);
      setSaveError(formatErrorMessage(error, "Couldn't save the schedule"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!base) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const outcome = await schedulesClient.remove(base.id);
      setConfirmingDelete(false);
      onDeleted(outcome.snapshot, base.id);
    } catch (error) {
      logError("Failed to delete schedule", error);
      setDeleteError(formatErrorMessage(error, "Couldn't delete the schedule"));
    } finally {
      setDeleting(false);
    }
  };

  const takeConflict = () => {
    if (!conflict) return;
    setBase(conflict);
    setDraft(draftFrom(conflict));
    setConflict(null);
    setServerIssues([]);
    setSubmitSummary("");
  };

  const formIssue = serverIssues.find((issue) => !(issue.path in ISSUE_FIELD));
  // What Create commits, said where the button is: the default cadence sits
  // below the fold of a new form, and a schedule starts on.
  const newSummary =
    isNew && cadence.ok
      ? `${cadenceWordsNow ?? draft.cron} · first run ${
          nextRun === null ? "never" : formatNextRunRelative(nextRun, now, timeZone)
        }`
      : undefined;
  const hint =
    saveError ??
    (conflict ? "Changed in another window. Load the latest version first" : undefined) ??
    formIssue?.message ??
    (submitSummary || undefined) ??
    newSummary ??
    (!isNew && !dirty ? "No changes to save" : undefined);

  return (
    <>
      <AppDialog.Body>
        {/* A save in flight holds the form, so nothing typed now is lost or half-sent. */}
        <fieldset disabled={saving} className="min-w-0 space-y-8">
          {/* Validation and save failures both land here, so a failed save is heard, not only seen. */}
          <p role="status" className="sr-only">
            {saveError ?? submitSummary}
          </p>
          <p aria-live="polite" className="sr-only">
            {settledCadenceLive}
          </p>
          {conflict && (
            <Callout
              severity="warning"
              title="This schedule changed in another window"
              action={
                <Button ref={loadLatestRef} variant="outline" size="sm" onClick={takeConflict}>
                  Load latest
                </Button>
              }
            >
              Saving now would overwrite those changes. Load the latest version, then make your
              edits again.
            </Callout>
          )}

          <SettingsSection title="What runs">
            <SettingsGroup>
              <SettingsInput
                rowId={FIELD_ROW.name}
                label="Name"
                layout="inline"
                controlWidth="wide"
                value={draft.name}
                maxLength={200}
                data-schedule-focus="name"
                onChange={(event) => update("name", event.target.value)}
                onBlur={() => markTouched("name")}
                error={errorFor("name")}
              />
              <SettingsSelect
                id={FIELD_ROW.agentId}
                label="Agent"
                controlWidth="wide"
                value={draft.agentId}
                onValueChange={(value) => {
                  update("agentId", value);
                  update("presetId", null);
                }}
                options={agentOptions}
                placeholder="Choose an agent"
                error={errorFor("agentId")}
              />
              <SettingsSelect
                label="Preset"
                description="The agent's saved launch settings: model, flags and permissions"
                controlWidth="wide"
                value={draft.presetId ?? NO_PRESET_VALUE}
                onValueChange={(value) =>
                  update("presetId", value === NO_PRESET_VALUE ? null : value)
                }
                options={presetOptions}
                error={presetMissing ? "This preset no longer exists for this agent" : undefined}
              />
              {stopsAtPrompts && (
                <div className="px-4 py-3">
                  <Callout
                    severity="warning"
                    title="This run will stop at permission prompts"
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void actionService.dispatch(
                            "app.settings.openTab",
                            { tab: "agents" },
                            { source: "user" }
                          )
                        }
                      >
                        Agent settings
                      </Button>
                    }
                  >
                    {agentName} asks before it runs commands or edits files with{" "}
                    {preset ? `the ${preset.name} preset` : "no preset"}, and nobody will be there
                    to answer. Choose a preset that skips permission prompts, or the run waits until
                    you open it.
                  </Callout>
                </div>
              )}
              <SettingsSelect
                label="Worktree"
                description="Where the agent works. The main checkout is the project folder itself"
                controlWidth="wide"
                value={draft.worktreeId ?? MAIN_CHECKOUT_VALUE}
                onValueChange={(value) =>
                  update("worktreeId", value === MAIN_CHECKOUT_VALUE ? null : value)
                }
                options={worktreeOptions}
              />
              <SettingsTextarea
                rowId={FIELD_ROW.prompt}
                label="Prompt"
                description="Sent to the agent as written when each run starts"
                rows={5}
                value={draft.prompt}
                placeholder="Check for outdated dependencies, update the safe ones, and open a pull request"
                onChange={(event) => update("prompt", event.target.value)}
                onBlur={() => markTouched("prompt")}
                error={errorFor("prompt")}
              />
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title="When it runs">
            <SettingsGroup>
              <SettingsInput
                rowId={FIELD_ROW.cron}
                label="Cadence"
                layout="inline"
                controlWidth="wide"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
                value={draft.cron}
                placeholder="0 9 * * *"
                onChange={(event) => update("cron", event.target.value)}
                onBlur={() => markTouched("cron")}
                description={cadenceDescription}
                error={cronError}
              />
              <SettingsPresetGroup
                label="Missed runs"
                description={MISSED_RUN_CONSEQUENCE[draft.missedRuns]}
                options={MISSED_RUN_OPTIONS}
                value={draft.missedRuns}
                onChange={(value) => update("missedRuns", value)}
              />
              <SettingsPresetGroup
                label="If the last run is still going"
                description={OVERLAP_CONSEQUENCE[draft.overlap]}
                options={OVERLAP_OPTIONS}
                value={draft.overlap}
                onChange={(value) => update("overlap", value)}
              />
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title="Before and after each run">
            <SettingsGroup>
              <SettingsCheckbox
                label="Check a command first"
                description="The run goes ahead only when the command exits with 0"
                checked={draft.checkFirst}
                onChange={(value) => update("checkFirst", value)}
              />
              {/* The command is the check's whole configuration, so it shows only while the check is on. */}
              {draft.checkFirst && (
                <SettingsDependents>
                  <SettingsInput
                    rowId={FIELD_ROW.checkCommand}
                    label="Command"
                    description="Runs in a shell in the schedule's worktree"
                    className="font-mono"
                    spellCheck={false}
                    autoComplete="off"
                    value={draft.checkCommand}
                    placeholder="git fetch -q && ! git diff --quiet HEAD @{u}"
                    onChange={(event) => update("checkCommand", event.target.value)}
                    onBlur={() => markTouched("checkCommand")}
                    error={errorFor("checkCommand")}
                  />
                </SettingsDependents>
              )}
              <SettingsPresetGroup
                label="When the agent reports done"
                description={DONE_CONSEQUENCE[draft.onDone]}
                options={DONE_OPTIONS}
                value={draft.onDone}
                onChange={(value) => update("onDone", value)}
              />
            </SettingsGroup>
          </SettingsSection>
        </fieldset>
      </AppDialog.Body>

      <AppDialog.Footer
        leadingAction={
          isNew
            ? undefined
            : {
                label: "Delete schedule…",
                intent: "destructive",
                onClick: () => setConfirmingDelete(true),
                disabled: saving,
              }
        }
        hint={hint}
        secondaryAction={{ label: "Cancel", onClick: onCancel, disabled: saving }}
        primaryAction={{
          label: isNew ? "Create schedule" : "Save changes",
          onClick: () => void save(),
          loading: saving,
          disabled: !isNew && !dirty,
        }}
      />

      {base && (
        <ConfirmDialog
          isOpen={confirmingDelete}
          variant="destructive"
          title={`Delete '${base.name}'?`}
          description="It stops running, and its settings and prompt are gone from this machine. Terminals its past runs opened stay open."
          confirmLabel={deleteError ? "Retry delete" : "Delete schedule"}
          isBusy={deleting}
          onConfirm={() => void remove()}
          onClose={() => {
            setConfirmingDelete(false);
            setDeleteError(null);
          }}
        >
          {deleteError && <InlineError role="alert">{deleteError}</InlineError>}
        </ConfirmDialog>
      )}
    </>
  );
}
