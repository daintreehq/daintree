import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsActions,
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsCheckbox } from "@/components/Settings/SettingsCheckbox";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { SettingsNumberInput } from "@/components/Settings/SettingsNumberInput";
import { SettingsPresetGroup } from "@/components/Settings/SettingsPresetGroup";
import {
  useHoldSettingsDeepLink,
  useSettingsDeepLink,
} from "@/components/Settings/settingsDeepLink";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import {
  CONSULT_MAX,
  OVERRIDE_MAX_MS,
  STALE_TEXT,
  WAITING_TEXT,
  draftIssue,
  localDateTime,
} from "@/components/Decisions/decisionsInvolvementModel";
import {
  InvolvementDetail,
  InvolvementFacts,
  InvolvementValue,
  MODE_OPTIONS,
} from "@/components/Decisions/InvolvementPreferenceParts";
import {
  useInvolvementPreference,
  type InvolvementPreference,
} from "@/components/Decisions/useInvolvementPreference";

/** The section's DOM id, which Settings search lands on. */
export const INVOLVEMENT_SECTION_ID = "decisions-involvement";

/** Settings has no inbox opening: each mount is one, and its state goes with it. */
const SETTINGS_OPENING = 0;

interface DecisionsInvolvementSettingsSectionProps {
  /** The tab is showing: nothing is read while it is hidden. */
  active: boolean;
  /** Decisions' status revision: a change in the connection reads the preference again. */
  statusRevision: number | null;
  /** The Decisions switch is changing, so nothing behind it is. */
  locked: boolean;
}

/**
 * Involvement (#18060): what every agent that asks is told about how involved
 * the person wants to be, where it was set and confirmed, and a change to it,
 * temporary mode included. The inbox holds the same preference on one line;
 * both replace only the revision the person reviewed.
 */
export function DecisionsInvolvementSettingsSection({
  active,
  statusRevision,
  locked,
}: DecisionsInvolvementSettingsSectionProps) {
  const involvement = useInvolvementPreference({
    active,
    opening: SETTINGS_OPENING,
    statusRevision,
    fallback: "section",
    locked,
  });
  const { load, read, now, notice } = involvement;
  // A search result for this section lands once the read has settled, so Change is there to take the keyboard.
  const link = useSettingsDeepLink();
  useHoldSettingsDeepLink(link.sectionId === INVOLVEMENT_SECTION_ID && load.state === "loading");

  return (
    <SettingsSection title="Involvement" id={INVOLVEMENT_SECTION_ID}>
      {/* Unnamed, so not a landmark: the page has one per section otherwise. */}
      <section
        ref={involvement.sectionRef}
        // The keyboard's last resort once a save settles with nothing here left to take it.
        tabIndex={-1}
        className="grid grid-cols-[minmax(0,1fr)] gap-3"
        data-testid="decisions-involvement-settings"
      >
        <SettingsGroup>
          <SettingsRow
            label="How involved you want to be"
            description={<Current involvement={involvement} />}
            error={load.state === "failed" ? "The preference couldn't be read" : undefined}
            errorAction={
              load.state === "failed" ? (
                <Button variant="outline" size="sm" onClick={involvement.reload}>
                  Retry
                </Button>
              ) : undefined
            }
            control={
              involvement.canStart ? (
                <Button
                  ref={involvement.changeRef}
                  variant="outline"
                  size="sm"
                  onClick={involvement.startEditing}
                  data-testid="decisions-involvement-change"
                >
                  {read?.preference.status === "available" ? "Change" : "Set preference"}
                </Button>
              ) : undefined
            }
          />
          {involvement.draft !== null && (
            <Editor involvement={involvement} now={now} locked={locked} />
          )}
        </SettingsGroup>
        {/* Announced once when a save settles. Kept mounted to announce; out of the gap while it says nothing. */}
        <div role="status" className="empty:-mt-3">
          {notice !== null && (
            <Callout severity={notice.severity} data-testid="decisions-involvement-notice">
              {notice.text}
            </Callout>
          )}
        </div>
      </section>
    </SettingsSection>
  );
}

/** What agents are told now, what that asks of them, and anything that keeps it from applying or changing. */
function Current({ involvement }: { involvement: InvolvementPreference }) {
  const { load, read, now } = involvement;
  if (load.state === "not-running") {
    return (
      <p data-testid="decisions-involvement-summary">
        This computer isn&apos;t connected to the relay: agents use their usual behaviour.
      </p>
    );
  }
  if (read === null) return null;
  const problem = involvement.readOnly ?? (involvement.waiting ? WAITING_TEXT : null);
  return (
    <div className="grid gap-0.5" data-testid="decisions-involvement-summary">
      <p>
        <InvolvementValue read={read} now={now} full />
      </p>
      <InvolvementDetail read={read} now={now} />
      {problem !== null && <p data-testid="decisions-involvement-read-only">{problem}</p>}
      {read.preference.stale && <p data-testid="decisions-involvement-stale">{STALE_TEXT}</p>}
      <InvolvementFacts read={read} now={now} />
    </div>
  );
}

function Editor({
  involvement,
  now,
  locked,
}: {
  involvement: InvolvementPreference;
  now: number;
  locked: boolean;
}) {
  const draft = involvement.draft;
  if (draft === null) return null;
  const issue = draftIssue(draft, now);
  const saving = involvement.busy;
  return (
    <form
      ref={involvement.formRef}
      // The draft is checked here, against the protocol's limits, rather than by the browser's bubbles.
      noValidate
      className="divide-y divide-border-subtle"
      onSubmit={(event) => {
        event.preventDefault();
        // Save is disabled while nothing changed; Enter in a field reaches here regardless.
        if (involvement.dirty && !locked) void involvement.save();
      }}
      data-testid="decisions-involvement-editor"
    >
      {/* Locked while the change is in flight, so what was sent is what the form shows. */}
      <fieldset
        disabled={saving}
        className="m-0 min-w-0 divide-y divide-border-subtle border-0 p-0"
      >
        <SettingsPresetGroup
          label="Usually"
          options={MODE_OPTIONS}
          value={draft.normalMode}
          onChange={(normalMode) => involvement.change({ normalMode })}
          disabled={saving}
        />
        <SettingsNumberInput
          label="Other agents to consult"
          description={`Before agents bring you a recommendation, from 1 to ${CONSULT_MAX}`}
          min={1}
          max={CONSULT_MAX}
          step={1}
          value={Number.isNaN(draft.consultCount) ? "" : String(draft.consultCount)}
          onChange={(event) =>
            involvement.change({ consultCount: event.currentTarget.valueAsNumber })
          }
          error={issue?.field === "count" ? issue.text : undefined}
          data-testid="decisions-involvement-consult-count"
        />
        <SettingsCheckbox
          label="For a while"
          description="Another mode until a time you choose, at most 30 days away, then back to the usual one"
          checked={draft.temporary}
          onChange={(temporary) => involvement.change({ temporary })}
          disabled={saving}
        />
        <SettingsDependents disabled={!draft.temporary} reason="Turn on For a while to choose them">
          <SettingsPresetGroup
            label="Mode for a while"
            options={MODE_OPTIONS}
            value={draft.temporaryMode}
            onChange={(temporaryMode) => involvement.change({ temporaryMode })}
            disabled={saving || !draft.temporary}
          />
          <SettingsInput
            type="datetime-local"
            label="Until"
            layout="inline"
            controlWidth="wide"
            min={localDateTime(now)}
            max={localDateTime(now + OVERRIDE_MAX_MS)}
            value={draft.until}
            onChange={(event) => involvement.changeUntil(event.currentTarget.value)}
            error={draft.temporary && issue?.field === "until" ? issue.text : undefined}
            data-testid="decisions-involvement-until"
          />
        </SettingsDependents>
      </fieldset>
      <SettingsActions>
        <Button type="button" variant="outline" size="sm" onClick={involvement.cancel}>
          Cancel
        </Button>
        <Button
          ref={involvement.saveRef}
          type="submit"
          variant="contrast"
          size="sm"
          loading={saving}
          disabled={!involvement.dirty || locked}
          aria-disabled={issue !== null || undefined}
          data-testid="decisions-involvement-save"
        >
          Save
        </Button>
      </SettingsActions>
    </form>
  );
}
