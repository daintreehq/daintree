import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { FactRun } from "@/components/ui/FactSeparator";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { decisionsClient } from "@/clients/decisionsClient";
import { scheduleFlip } from "@/utils/flipScheduler";
import type {
  DecisionsInvolvementMode,
  DecisionsInvolvementRead,
} from "@shared/types/decisionsInvolvement";
import {
  CONSULT_MAX,
  MODE_LABEL,
  OVERRIDE_MAX_MS,
  STALE_TEXT,
  UNCONFIRMED_NOTICE,
  draftFrom,
  draftIssue,
  draftPayload,
  draftUntil,
  formatUntil,
  inForce,
  localDateTime,
  modeDetail,
  msUntilChange,
  readOnlyText,
  saveNotice,
  setOnText,
  thenText,
  unavailableText,
  type InvolvementDraft,
  type SaveNotice,
} from "./decisionsInvolvementModel";

/**
 * How often the inbox reads the preference again while it is open. The
 * library takes a phone's change from the relay's hint on its own and tells
 * no one, so a read is the only way to see it; it reads this computer's copy
 * and touches no network.
 */
export const INVOLVEMENT_READ_MS = 5_000;

/** How long after a conflict a change waits for this computer to read the revision that won. */
const BEHIND_WAIT_MS = 15_000;

type Read = Extract<DecisionsInvolvementRead, { result: "read" }>;

type Load =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "read"; read: Read }
  | { state: "not-running" };

const LOADING: Load = { state: "loading" };

const MODE_OPTIONS: { value: DecisionsInvolvementMode; label: string }[] = [
  { value: "involve-early", label: MODE_LABEL["involve-early"] },
  { value: "recommend", label: MODE_LABEL.recommend },
];

/**
 * The preference while `active`, as this opening read it, read again every
 * few seconds while the window is visible, whenever `statusRevision` moves,
 * and on `reload`. A read that fails keeps the last good one. `at` is when
 * the shown read landed.
 */
function useInvolvement(
  active: boolean,
  opening: number,
  statusRevision: number | null
): { load: Load; at: number; reload: () => void } {
  const [current, setCurrent] = useState<{ opening: number; load: Load; at: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      // Settled as a value, not thrown: a read that fails keeps the last good one.
      const result = await decisionsClient.getInvolvement().then(
        (value) => value,
        () => null
      );
      reading = false;
      if (stopped) return;
      const at = Date.now();
      if (result === null) {
        setCurrent((previous) =>
          previous !== null && previous.opening === opening && previous.load.state === "read"
            ? previous
            : { opening, load: { state: "failed" }, at }
        );
        return;
      }
      const load: Load =
        result.result === "read" ? { state: "read", read: result } : { state: "not-running" };
      setCurrent({ opening, load, at });
    };
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, INVOLVEMENT_READ_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, opening, statusRevision, attempt]);
  const shown = active && current !== null && current.opening === opening ? current : null;
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load: shown?.load ?? LOADING, at: shown?.at ?? 0, reload };
}

interface Edit {
  opening: number;
  /** The revision the person reviewed: a change replaces exactly it, whatever is read meanwhile. */
  revision: number;
  draft: InvolvementDraft;
}

interface DecisionsInvolvementSectionProps {
  /** The inbox is open and Decisions is on: nothing is read otherwise. */
  active: boolean;
  /** The inbox opening this belongs to: nothing of an earlier one is shown. */
  opening: number;
  /** Decisions' status revision: a change in the connection reads the preference again. */
  statusRevision: number | null;
}

/**
 * The person's involvement preference in the Decisions inbox (#17237): what
 * agents' `get_involvement` is told now, where it was set, when this computer
 * last confirmed it, and, on the owner computer while connected, a form to
 * change it. A change replaces the revision the person reviewed, so one made
 * on a phone meanwhile is refused rather than overwritten.
 */
export function DecisionsInvolvementSection({
  active,
  opening,
  statusRevision,
}: DecisionsInvolvementSectionProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const { load, at, reload } = useInvolvement(active, opening, statusRevision);
  const read = load.state === "read" ? load.read : null;
  const preference = read?.preference ?? null;

  // A temporary mode ends without a new revision: the display flips at its
  // end, and reads again. A draft's own end wakes its check the same way.
  const [flippedAt, setFlippedAt] = useState(0);
  const now = Math.max(at, flippedAt);
  const flipIn = preference === null ? null : msUntilChange(preference, now);
  useEffect(() => {
    if (!active || flipIn === null) return;
    return scheduleFlip(flipIn, () => {
      setFlippedAt(Date.now());
      reload();
    });
  }, [active, flipIn, reload]);

  const [editing, setEditing] = useState<Edit | null>(null);
  const edit = editing !== null && editing.opening === opening ? editing : null;
  // What is open when a save settles: only the form it was sent from, still holding the keyboard, hands it on.
  const editingRef = useRef<Edit | null>(null);
  const openingRef = useRef(opening);
  const activeRef = useRef(active);
  const formRef = useRef<HTMLFormElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    editingRef.current = editing;
    openingRef.current = opening;
    activeRef.current = active;
  });

  // One save at a time in an opening: the form is locked while it is in flight, so its results can't cross.
  const [inFlight, setInFlight] = useState<{ opening: number; sent: Edit } | null>(null);
  const busy = inFlight !== null && inFlight.opening === opening;
  const [notice, setNotice] = useState<{ opening: number; notice: SaveNotice } | null>(null);
  const shownNotice = notice !== null && notice.opening === opening ? notice.notice : null;
  const [refused, setRefused] = useState<number | null>(null);
  const refusedByRelay = refused === opening;
  // After a conflict, a change waits for this computer to read the revision that won, for a while:
  // a newer record it can't verify never arrives, and a change from what it holds is refused again anyway.
  const [behind, setBehind] = useState<{ opening: number; revision: number; at: number } | null>(
    null
  );
  const waiting =
    read !== null &&
    behind !== null &&
    behind.opening === opening &&
    read.preference.revision < behind.revision &&
    now - behind.at < BEHIND_WAIT_MS;
  const [handoff, setHandoff] = useState(0);

  const readOnly = read === null ? null : readOnlyText(read, refusedByRelay);
  const canEdit = read !== null && readOnly === null && !waiting;

  // The wait has its own end, so reads that fail or stall can't hold it open.
  const waitEnds = waiting && behind !== null ? behind.at + BEHIND_WAIT_MS : null;
  useEffect(() => {
    if (waitEnds === null) return;
    return scheduleFlip(waitEnds - Date.now(), () => setFlippedAt(Date.now()));
  }, [waitEnds, now]);

  // A draft's own end wakes its check, counted from that end rather than from the last read, and
  // re-armed whenever the clock moves short of it (a hidden window, a delay past the timer's cap).
  const draftEnd =
    active && canEdit && edit !== null && edit.draft.temporary ? draftUntil(edit.draft) : null;
  useEffect(() => {
    if (draftEnd === null) return;
    const end = Date.parse(draftEnd);
    if (now >= end) return;
    return scheduleFlip(end - Date.now(), () => setFlippedAt(Date.now()));
  }, [draftEnd, now]);

  // Once a save settles or the form is put away, the keyboard goes to Change, else the dialog's surface.
  useEffect(() => {
    if (handoff === 0 || !activeRef.current) return;
    const focused = document.activeElement;
    const surface = sectionRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
    if (focused !== document.body && focused !== surface && !sectionRef.current?.contains(focused))
      return;
    (changeRef.current ?? surface)?.focus();
  }, [handoff]);

  const startEditing = () => {
    if (read === null) return;
    setNotice(null);
    setEditing({
      opening,
      revision: read.preference.revision,
      draft: draftFrom(read.preference, Date.now()),
    });
  };

  const change = (next: Partial<InvolvementDraft>) => {
    if (edit === null || busy) return;
    setEditing({ ...edit, draft: { ...edit.draft, ...next } });
  };

  const save = async () => {
    if (edit === null || busy || !canEdit) return;
    // Checked again at the moment of saving: an end that has passed since the last read shows now.
    const checkedAt = Date.now();
    if (draftIssue(edit.draft, checkedAt) !== null) {
      setFlippedAt(checkedAt);
      return;
    }
    const sent = edit;
    // Locking the fields drops a field's focus, so the keyboard waits on Save meanwhile.
    if (formRef.current?.contains(document.activeElement)) saveRef.current?.focus();
    setInFlight({ opening: sent.opening, sent });
    // Settled as a value: a call that fails may still have reached the relay before something here failed.
    const result = await decisionsClient
      .setInvolvement(draftPayload(sent.draft, sent.revision))
      .then(
        (value) => value,
        () => null
      );
    const said = result === null ? UNCONFIRMED_NOTICE : saveNotice(result);
    const relayRefusal = said !== null && "relayRefusal" in said && said.relayRefusal;
    if (relayRefusal) setRefused(sent.opening);
    if (result !== null && result.result === "conflict" && result.latestRevision !== null) {
      setBehind({ opening: sent.opening, revision: result.latestRevision, at: Date.now() });
    }
    const focused = document.activeElement;
    const holdsKeyboard =
      openingRef.current === sent.opening &&
      (editingRef.current === sent || editingRef.current === null) &&
      (focused === document.body ||
        focused === sectionRef.current?.closest('[role="dialog"]') ||
        formRef.current?.contains(focused) === true);
    setNotice(said === null ? null : { opening: sent.opening, notice: said });
    setEditing((current) => (current === sent ? null : current));
    setInFlight((current) => (current !== null && current.sent === sent ? null : current));
    if (holdsKeyboard) setHandoff((n) => n + 1);
    reload();
  };

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      // Bounded, so an open form on a short window scrolls here rather than pushing Save out of the dialog.
      className="flex max-h-[50%] min-h-0 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-t border-divider px-4 py-3"
      data-testid="decisions-involvement"
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id={headingId} className="text-xs font-medium text-text-secondary">
            How involved you want to be
          </h3>
          <Summary load={load} now={now} retry={reload} />
        </div>
        {canEdit && edit === null && !busy && (
          <Button
            ref={changeRef}
            variant="outline"
            size="xs"
            onClick={startEditing}
            data-testid="decisions-involvement-change"
          >
            {preference?.status === "available" ? "Change" : "Set preference"}
          </Button>
        )}
      </div>
      {(readOnly !== null || waiting) && (
        <p className="text-xs text-text-secondary" data-testid="decisions-involvement-read-only">
          {readOnly ?? "Reading the newer preference before it can be changed again…"}
        </p>
      )}
      {/* Announced once when a save settles, and where the keyboard lands when nothing else can take it. */}
      <div role="status">
        {shownNotice !== null && (
          <Callout
            severity={shownNotice.severity}
            size="compact"
            data-testid="decisions-involvement-notice"
          >
            {shownNotice.text}
          </Callout>
        )}
      </div>
      {edit !== null && canEdit && (
        <InvolvementEditor
          formRef={formRef}
          saveRef={saveRef}
          draft={edit.draft}
          now={now}
          saving={busy}
          onChange={change}
          onUntilChange={(until) => change({ until, keptUntil: null })}
          onSave={() => void save()}
          onCancel={() => {
            setEditing(null);
            setHandoff((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

function Summary({ load, now, retry }: { load: Load; now: number; retry: () => void }) {
  if (load.state === "loading") return null;
  if (load.state === "not-running") {
    return (
      <p className="text-xs text-text-secondary" data-testid="decisions-involvement-summary">
        This computer isn&apos;t connected to the relay: agents use their usual behaviour.
      </p>
    );
  }
  if (load.state === "failed") {
    return (
      <div className="flex items-center gap-2" data-testid="decisions-involvement-failed">
        <p className="text-xs text-text-secondary">The preference couldn&apos;t be read.</p>
        <Button variant="outline" size="xs" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }
  const { preference, role } = load.read;
  // Given the read's clock: a static label would otherwise stay as first drawn.
  const confirmed =
    preference.lastSyncedAt === null ? (
      "Never confirmed by this computer"
    ) : (
      <TimeAgo
        key="confirmed"
        timestamp={preference.lastSyncedAt}
        now={now}
        prefix="Confirmed by this computer "
        verbose
      />
    );
  const facts =
    preference.status === "available"
      ? [
          <TimeAgo
            key="set"
            timestamp={preference.setAt}
            now={now}
            prefix={setOnText(preference.setOn, role)}
            verbose
          />,
          confirmed,
        ]
      : [confirmed];
  const stale = preference.stale && (
    <p className="text-xs text-text-secondary" data-testid="decisions-involvement-stale">
      {STALE_TEXT}
    </p>
  );

  if (preference.status === "unavailable") {
    return (
      <div className="flex flex-col gap-0.5" data-testid="decisions-involvement-summary">
        <p className="text-sm text-text-primary">{unavailableText(preference.reason)}</p>
        <p className="text-xs text-text-secondary" data-testid="decisions-involvement-facts">
          <FactRun facts={facts} />
        </p>
        {stale}
      </div>
    );
  }

  const force = inForce(preference, now);
  return (
    <div className="flex flex-col gap-0.5" data-testid="decisions-involvement-summary">
      <p className="text-sm text-text-primary" data-testid="decisions-involvement-mode">
        {MODE_LABEL[force.mode]}
        {force.until !== null && (
          <span className="text-text-secondary">
            {" "}
            until <time dateTime={force.until}>{formatUntil(force.until, now)}</time>,{" "}
            {thenText(preference)}
          </span>
        )}
      </p>
      <p className="text-xs text-text-secondary" data-testid="decisions-involvement-detail">
        {modeDetail(force.mode, preference.consultCount)}
      </p>
      <p className="text-xs text-text-secondary" data-testid="decisions-involvement-facts">
        <FactRun facts={facts} />
      </p>
      {stale}
    </div>
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
