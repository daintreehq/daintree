import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import {
  CONSULT_MAX,
  OVERRIDE_MAX_MS,
  STALE_TEXT,
  WAITING_TEXT,
  draftIssue,
  localDateTime,
  type InvolvementDraft,
} from "./decisionsInvolvementModel";
import {
  InvolvementDetail,
  InvolvementFacts,
  InvolvementValue,
  MODE_OPTIONS,
} from "./InvolvementPreferenceParts";
import { useInvolvementPreference, type InvolvementLoad } from "./useInvolvementPreference";

interface DecisionsInvolvementSectionProps {
  /** The inbox is open and Decisions is on: nothing is read otherwise. */
  active: boolean;
  /** The inbox opening this belongs to: nothing of an earlier one is shown. */
  opening: number;
  /** Decisions' status revision: a change in the connection reads the preference again. */
  statusRevision: number | null;
}

/**
 * The person's involvement preference under the inbox's questions (#17237):
 * one quiet line saying what agents are told now, with Change on the owner
 * computer while connected (#18060). What the mode asks of agents, and where
 * it was set and confirmed, show only while it is being changed, or when
 * something keeps it from applying or from being changed here. Settings →
 * Decisions holds the same preference.
 */
export function DecisionsInvolvementSection({
  active,
  opening,
  statusRevision,
}: DecisionsInvolvementSectionProps) {
  const headingId = useId();
  const involvement = useInvolvementPreference({ active, opening, statusRevision });
  const { load, read, now, draft, notice } = involvement;
  const editing = draft !== null;
  const stale = read !== null && read.preference.stale;
  const problem = involvement.readOnly ?? (involvement.waiting ? WAITING_TEXT : null);
  const explained = read !== null && (editing || stale || problem !== null);

  return (
    <section
      ref={involvement.sectionRef}
      // The keyboard's last resort once a save settles with nothing here left to take it.
      tabIndex={-1}
      aria-labelledby={headingId}
      // Bounded, so an open form on a short window scrolls here rather than pushing Save out of the dialog.
      // One quiet line under the queue: a preference set now and then, never a rival to the questions.
      className="flex max-h-[50%] min-h-0 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-t border-divider px-4 py-2.5"
      data-testid="decisions-involvement"
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={headingId} className="shrink-0 text-xs font-medium text-text-secondary">
          Involvement
        </h3>
        <div className="min-w-0 flex-1 text-xs">
          <Summary load={load} now={now} full={explained} retry={involvement.reload} />
        </div>
        {involvement.canStart && (
          <Button
            ref={involvement.changeRef}
            variant="outline"
            size="xs"
            onClick={involvement.startEditing}
            data-testid="decisions-involvement-change"
          >
            {read?.preference.status === "available" ? "Change" : "Set preference"}
          </Button>
        )}
      </div>
      {explained && (
        <div className="flex flex-col gap-0.5 text-xs text-text-secondary">
          {problem !== null && <p data-testid="decisions-involvement-read-only">{problem}</p>}
          {stale && <p data-testid="decisions-involvement-stale">{STALE_TEXT}</p>}
          {editing && <InvolvementDetail read={read} now={now} />}
          <InvolvementFacts read={read} now={now} />
        </div>
      )}
      {/* Announced once when a save settles. Kept mounted to announce; out of the footer's rhythm while it says nothing. */}
      <div role="status" className="empty:-mt-2">
        {notice !== null && (
          <Callout severity={notice.severity} size="compact" data-testid="decisions-involvement-notice">
            {notice.text}
          </Callout>
        )}
      </div>
      {draft !== null && (
        <InvolvementEditor
          formRef={involvement.formRef}
          saveRef={involvement.saveRef}
          draft={draft}
          now={now}
          saving={involvement.busy}
          onChange={involvement.change}
          onUntilChange={involvement.changeUntil}
          onSave={() => void involvement.save()}
          onCancel={involvement.cancel}
        />
      )}
    </section>
  );
}

function Summary({
  load,
  now,
  full,
  retry,
}: {
  load: InvolvementLoad;
  now: number;
  full: boolean;
  retry: () => void;
}) {
  if (load.state === "loading") return null;
  if (load.state === "not-running") {
    return (
      <p className="text-text-secondary" data-testid="decisions-involvement-summary">
        This computer isn&apos;t connected to the relay: agents use their usual behaviour.
      </p>
    );
  }
  if (load.state === "failed") {
    return (
      <div className="flex items-center gap-2" data-testid="decisions-involvement-failed">
        <p className="text-text-secondary">The preference couldn&apos;t be read.</p>
        <Button variant="outline" size="xs" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <p data-testid="decisions-involvement-summary">
      <InvolvementValue read={load.read} now={now} full={full} />
    </p>
  );
}

interface InvolvementEditorProps {
  formRef: React.Ref<HTMLFormElement>;
  saveRef: React.Ref<HTMLButtonElement>;
  draft: InvolvementDraft;
  /** The section's clock: the field's bounds and the draft's check are taken from it. */
  now: number;
  saving: boolean;
  onChange: (next: Partial<InvolvementDraft>) => void;
  onUntilChange: (until: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function InvolvementEditor({
  formRef,
  saveRef,
  draft,
  now,
  saving,
  onChange,
  onUntilChange,
  onSave,
  onCancel,
}: InvolvementEditorProps) {
  const temporaryId = useId();
  const issue = draftIssue(draft, now);
  return (
    <form
      ref={formRef}
      // The draft is checked here, against the protocol's limits, rather than by the browser's bubbles.
      noValidate
      className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-border-default p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      data-testid="decisions-involvement-editor"
    >
      {/* Locked while the change is in flight, so what was sent is what the form shows. */}
      <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-primary">Usually</span>
            <SegmentedRadioGroup
              options={MODE_OPTIONS}
              value={draft.normalMode}
              onChange={(normalMode) => onChange({ normalMode })}
              aria-label="Usually"
              testId="decisions-involvement-normal-mode"
            />
          </div>
          <Field className="w-44">
            <FieldLabel>Other agents to consult</FieldLabel>
            <Input
              type="number"
              density="compact"
              min={1}
              max={CONSULT_MAX}
              step={1}
              value={Number.isNaN(draft.consultCount) ? "" : String(draft.consultCount)}
              onChange={(event) => onChange({ consultCount: event.currentTarget.valueAsNumber })}
              data-testid="decisions-involvement-consult-count"
            />
            {issue?.field === "count" && (
              <FieldError data-testid="decisions-involvement-issue">{issue.text}</FieldError>
            )}
          </Field>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id={temporaryId}
              size="sm"
              checked={draft.temporary}
              onCheckedChange={(value) => onChange({ temporary: value === true })}
              data-testid="decisions-involvement-temporary"
            />
            <label htmlFor={temporaryId} className="text-xs text-text-primary">
              For a while
            </label>
          </div>
          {draft.temporary && (
            <div className="flex flex-wrap items-start gap-x-6 gap-y-3 pl-6">
              <SegmentedRadioGroup
                options={MODE_OPTIONS}
                value={draft.temporaryMode}
                onChange={(temporaryMode) => onChange({ temporaryMode })}
                aria-label="Mode for a while"
                testId="decisions-involvement-temporary-mode"
              />
              <Field className="w-56">
                <FieldLabel>Until</FieldLabel>
                <Input
                  type="datetime-local"
                  density="compact"
                  min={localDateTime(now)}
                  max={localDateTime(now + OVERRIDE_MAX_MS)}
                  value={draft.until}
                  onChange={(event) => onUntilChange(event.currentTarget.value)}
                  data-testid="decisions-involvement-until"
                />
                {issue?.field === "until" && (
                  <FieldError data-testid="decisions-involvement-issue">{issue.text}</FieldError>
                )}
              </Field>
            </div>
          )}
        </div>
      </fieldset>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          ref={saveRef}
          type="submit"
          variant="outline"
          size="xs"
          loading={saving}
          aria-disabled={issue !== null || undefined}
          data-testid="decisions-involvement-save"
        >
          Save
        </Button>
      </div>
    </form>
  );
}
