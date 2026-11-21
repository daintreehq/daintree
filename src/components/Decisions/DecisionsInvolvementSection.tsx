import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { cn } from "@/lib/utils";
import {
  CONSULT_MAX,
  MODE_HINT,
  MODE_LABEL,
  OVERRIDE_MAX_MS,
  STALE_TEXT,
  WAITING_TEXT,
  afterText,
  countApplies,
  draftIssues,
  earliestUntil,
  localDateTime,
  type InvolvementDraft,
} from "./decisionsInvolvementModel";
import { InvolvementFacts, InvolvementValue, MODE_OPTIONS } from "./InvolvementPreferenceParts";
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
 * A label on the footer's rail: the same column as the heading, so every value starts on one line.
 * As tall as the control's first line, so a hint or error under the control never pulls it off it.
 */
const RAIL_LABEL = "flex min-h-7 items-center text-xs text-text-secondary";
/** The first line of a control on the rail, as tall as its label. */
const RAIL_LINE = "flex min-h-7 items-center";

/**
 * The person's involvement preference under the inbox's questions (#17237):
 * one quiet line saying what agents are told now, with Change on the owner
 * computer while connected (#18060). Where it was set and confirmed shows
 * only while it is being changed, or when something keeps it from applying or
 * from being changed here; the form itself says what each choice asks of
 * agents. Settings → Decisions holds the same preference.
 */
export function DecisionsInvolvementSection({
  active,
  opening,
  statusRevision,
}: DecisionsInvolvementSectionProps) {
  const headingId = useId();
  // Last in the dialog, so a focusable footer would let Tab out of its trap: the dialog takes it.
  // The refs apart from the rest, so reading the rest during render reads no ref.
  const { sectionRef, changeRef, formRef, saveRef, ...involvement } = useInvolvementPreference({
    active,
    opening,
    statusRevision,
    fallback: "dialog",
  });
  const { load, read, now, draft, notice } = involvement;
  const editing = draft !== null;
  const stale = read !== null && read.preference.stale;
  const problem = involvement.readOnly ?? (involvement.waiting ? WAITING_TEXT : null);
  const explained = read !== null && (editing || stale || problem !== null);

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      // Bounded, so an open form on a short window scrolls here rather than pushing Save out of the dialog.
      // One quiet line under the queue: a preference set now and then, never a rival to the questions.
      // One grid for the line and the form, so the form's labels share the heading's column.
      className="grid max-h-[50%] min-h-0 shrink-0 grid-cols-[max-content_minmax(0,1fr)] content-start items-start gap-x-3 overflow-y-auto overscroll-contain border-t border-divider px-4 py-2.5"
      data-testid="decisions-involvement"
    >
      <h3
        id={headingId}
        className="flex min-h-6 items-center text-xs font-medium text-text-secondary"
      >
        Involvement
      </h3>
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {/* Not stretched, so Change follows the value it changes rather than sitting a dialog's width away. */}
        <div className="min-w-0 text-xs">
          <Summary load={load} now={now} full={explained} retry={involvement.reload} />
        </div>
        {involvement.canStart && (
          <Button
            ref={changeRef}
            variant="outline"
            size="xs"
            onClick={involvement.startEditing}
            data-testid="decisions-involvement-change"
          >
            {read?.preference.status === "available" ? "Change" : "Set preference"}
          </Button>
        )}
      </div>
      {/* Announced once when a save settles. Kept mounted to announce; takes no room while it says nothing.
          Above the explanation, so why it was refused comes before what happens meanwhile. */}
      <div role="status" className="col-start-2 max-w-2xl [&:not(:empty)]:mt-2">
        {notice !== null && (
          <Callout
            severity={notice.severity}
            size="compact"
            data-testid="decisions-involvement-notice"
          >
            {notice.text}
          </Callout>
        )}
      </div>
      {explained && (
        <div className="col-start-2 mt-1 flex flex-col gap-0.5 text-xs text-text-secondary">
          {problem !== null && <p data-testid="decisions-involvement-read-only">{problem}</p>}
          {stale && <p data-testid="decisions-involvement-stale">{STALE_TEXT}</p>}
          <InvolvementFacts read={read} now={now} />
        </div>
      )}
      {draft !== null && (
        <InvolvementEditor
          formRef={formRef}
          saveRef={saveRef}
          headingId={headingId}
          draft={draft}
          now={now}
          saving={involvement.busy}
          dirty={involvement.dirty}
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
  /** The section's heading, which names the form's fields as a group. */
  headingId: string;
  draft: InvolvementDraft;
  /** The section's clock: the field's bounds and the draft's check are taken from it. */
  now: number;
  saving: boolean;
  /** Whether saving would change anything: a first preference always does. */
  dirty: boolean;
  onChange: (next: Partial<InvolvementDraft>) => void;
  onUntilChange: (until: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * The change, on the footer's rail: the usual mode with what it asks of
 * agents, the other mode for a while with when it ends and what follows, and
 * the count only while a recommendation uses it, under the choice that does.
 */
function InvolvementEditor({
  formRef,
  saveRef,
  headingId,
  draft,
  now,
  saving,
  dirty,
  onChange,
  onUntilChange,
  onSave,
  onCancel,
}: InvolvementEditorProps) {
  const usuallyId = useId();
  const hintId = useId();
  const forAWhileId = useId();
  const temporaryId = useId();
  const insteadId = useId();
  const untilId = useId();
  const untilLabelId = useId();
  const issues = draftIssues(draft, now);
  const issueFor = (field: "count" | "until") =>
    issues.find((issue) => issue.field === field)?.text ?? null;
  const untilIssue = issueFor("until");
  const count = countApplies(draft) ? (
    <ConsultCount draft={draft} issue={issueFor("count")} onChange={onChange} />
  ) : null;
  // The count belongs to whichever choice brings a recommendation: the usual mode, or the one for a while.
  const countFollowsUsual = draft.normalMode === "recommend";
  return (
    <form
      ref={formRef}
      // The draft is checked here, against the protocol's limits, rather than by the browser's bubbles.
      noValidate
      // Further from the line above than its rows are from each other: that line is what is saved, these the change.
      className="col-span-2 mt-4 grid grid-cols-subgrid items-start gap-y-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        // Save is disabled while nothing changed; Enter in a field reaches here regardless.
        if (dirty) onSave();
      }}
      data-testid="decisions-involvement-editor"
    >
      {/* Locked while the change is in flight, so what was sent is what the form shows. */}
      <fieldset
        disabled={saving}
        aria-labelledby={headingId}
        // Its rows join the form's grid, so the labels stay on the rail; disabling still reaches every field.
        className="contents"
      >
        <span id={usuallyId} className={RAIL_LABEL}>
          Usually
        </span>
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <SegmentedRadioGroup
            options={MODE_OPTIONS}
            value={draft.normalMode}
            onChange={(normalMode) => onChange({ normalMode })}
            aria-label="Usually"
            aria-describedby={hintId}
            // Named by the visible label on the rail; the matching aria-label stays as the fallback.
            rootAttributes={{ "aria-labelledby": usuallyId }}
            testId="decisions-involvement-normal-mode"
          />
          <p
            id={hintId}
            className="text-xs text-text-secondary"
            data-testid="decisions-involvement-hint"
          >
            {MODE_HINT[draft.normalMode]}
          </p>
        </div>
        {countFollowsUsual && count}
        <label id={forAWhileId} htmlFor={temporaryId} className={RAIL_LABEL}>
          For a while
        </label>
        <div className={RAIL_LINE}>
          <Checkbox
            id={temporaryId}
            size="sm"
            // "For a while" as well as the mode: the mode alone sounds like a lasting change.
            aria-labelledby={`${forAWhileId} ${insteadId}`}
            checked={draft.temporary}
            onCheckedChange={(value) => onChange({ temporary: value === true })}
            data-testid="decisions-involvement-temporary"
          />
          {/* Padded rather than spaced from the box, so the gap between them is part of the target. */}
          <label
            id={insteadId}
            htmlFor={temporaryId}
            className="py-1 pl-2 text-xs text-text-primary"
          >
            {MODE_LABEL[draft.temporaryMode]} instead
          </label>
        </div>
        {draft.temporary && (
          <>
            {!countFollowsUsual && count}
            <label id={untilLabelId} htmlFor={untilId} className={RAIL_LABEL}>
              Until
            </label>
            <Field
              controlId={untilId}
              invalid={untilIssue !== null}
              className="items-start gap-1.5"
            >
              <div className={RAIL_LINE}>
                <Input
                  type="datetime-local"
                  density="compact"
                  className="w-52"
                  aria-labelledby={untilLabelId}
                  min={earliestUntil(now)}
                  max={localDateTime(now + OVERRIDE_MAX_MS)}
                  value={draft.until}
                  onChange={(event) => onUntilChange(event.currentTarget.value)}
                  data-testid="decisions-involvement-until"
                />
              </div>
              {untilIssue !== null && (
                <FieldError data-testid="decisions-involvement-issue">{untilIssue}</FieldError>
              )}
              <FieldDescription>{afterText(draft.normalMode)}</FieldDescription>
            </Field>
          </>
        )}
      </fieldset>
      <div className="col-start-2 mt-1 flex items-center gap-2">
        <Button
          ref={saveRef}
          type="submit"
          variant="contrast"
          size="xs"
          loading={saving}
          disabled={!dirty}
          aria-disabled={issues.length > 0 || undefined}
          data-testid="decisions-involvement-save"
        >
          Save
        </Button>
        <Button type="button" variant="outline" size="xs" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** How many other agents a recommendation consults, read as one phrase: "Consult [2] other agents". */
function ConsultCount({
  draft,
  issue,
  onChange,
}: {
  draft: InvolvementDraft;
  issue: string | null;
  onChange: (next: Partial<InvolvementDraft>) => void;
}) {
  const inputId = useId();
  const labelId = useId();
  const unitId = useId();
  const rangeId = useId();
  return (
    <>
      <label id={labelId} htmlFor={inputId} className={RAIL_LABEL}>
        Consult
      </label>
      <Field controlId={inputId} className="items-start gap-1.5">
        <div className={cn(RAIL_LINE, "gap-2")}>
          <Input
            type="number"
            density="compact"
            className="w-14"
            aria-labelledby={`${labelId} ${unitId}`}
            // The range goes while an error says it.
            aria-describedby={issue === null ? rangeId : undefined}
            min={1}
            max={CONSULT_MAX}
            step={1}
            value={Number.isNaN(draft.consultCount) ? "" : String(draft.consultCount)}
            onChange={(event) => onChange({ consultCount: event.currentTarget.valueAsNumber })}
            data-testid="decisions-involvement-consult-count"
          />
          <span id={unitId} className="text-xs text-text-primary">
            {draft.consultCount === 1 ? "other agent" : "other agents"}
          </span>
          {issue === null && (
            <span id={rangeId} className="text-xs text-text-secondary">
              (1 to {CONSULT_MAX})
            </span>
          )}
        </div>
        {issue !== null && (
          <FieldError data-testid="decisions-involvement-issue">{issue}</FieldError>
        )}
      </Field>
    </>
  );
}
