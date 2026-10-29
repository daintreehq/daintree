import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { deviceOwnerPhrase } from "@/hooks/useSettingsOwner";
import {
  PORTABLE_SETTINGS_CATEGORIES,
  type PortableSettingsCategory,
  type PortableSettingsCategoryId,
} from "@shared/config/portableSettings";
import type { ConfigImportReport } from "@shared/types/configBundle";
import type { SettingsCopyPreview } from "@shared/types/ipc/settingsCopy";
import type { HostId } from "@shared/types/remoteHosts";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { pluralize } from "@/lib/pluralize";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsSection } from "../SettingsSection";
import {
  SettingsActions,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsInlineError,
  SettingsRow,
} from "../SettingsGroup";
import { HostCopyDriftGroup, HostLastCopyGroup } from "./HostCopyStatusGroup";
import {
  CategoryPreviewRows,
  CategoryReportRows,
  CopiedCategoriesRow,
  QuietCategoryRows,
  UncopiedCategoryRows,
  UpdateDaintreeButton,
  needsReport,
} from "./settingsCopyParts";
import {
  DEVICE_CATEGORIES,
  HOST_CATEGORIES,
  categoryPreviews,
  categoryReports,
  changePhrase,
  classifyPreview,
  isQuiet,
  listPhrase,
  previewTotals,
  reportTotals,
} from "./settingsCopyPreview";
import { statusOf, useHostSettingsCopyStatus } from "./useHostSettingsCopyStatus";

interface HostCopySettingsSectionProps {
  hostId: HostId;
  hostName: string;
  connected: boolean;
  /** Just added and connected for the first time: the copy is offered. */
  offered?: boolean;
}

type Phase =
  | { kind: "choose" }
  /** `differences`: asked for from the comparison at the top, whose button shows the wait. */
  | { kind: "previewing"; from: "choose" | "differences" }
  | { kind: "preview"; preview: SettingsCopyPreview }
  | { kind: "applying"; preview: SettingsCopyPreview }
  | { kind: "result"; preview: SettingsCopyPreview; report: ConfigImportReport };

interface CopyError {
  message: string;
  /** The host's settings moved on since the preview, or the outcome is unknown: preview again. */
  previewAgain: boolean;
}

function defaultSelection(): Set<PortableSettingsCategoryId> {
  return new Set(
    PORTABLE_SETTINGS_CATEGORIES.filter((category) => category.selectedByDefault).map((c) => c.id)
  );
}

/**
 * Focus the control that replaced the one just pressed, without a scroll.
 * Chromium rings a script focus only when the last input was a key, so a
 * keyboard user sees where they landed and a click leaves no ring.
 */
function successorFocus(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
}

/**
 * Settings → Hosts → a host → Copy settings (#13346): push this machine's own
 * settings to the host, chosen by category. The host works out the preview
 * against its live settings and applies exactly what was shown, or asks for a
 * fresh preview if its settings changed in between. Credentials, consent and
 * per-project state never travel; nothing syncs afterwards.
 *
 * Choosing, the review and the result each replace the step before, so the
 * decision sits right under what it is about; changing the choice after a
 * preview is a deliberate step back, never a side effect of a checkbox.
 */
export function HostCopySettingsSection({
  hostId,
  hostName,
  connected,
  offered = false,
}: HostCopySettingsSectionProps) {
  const [selected, setSelected] = useState(defaultSelection);
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [error, setError] = useState<CopyError | null>(null);
  // Answers for a request that has since been superseded (a newer preview,
  // the host went away) are dropped, never shown.
  const generation = useRef(0);
  const status = useHostSettingsCopyStatus(hostId, hostName, connected);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    generation.current += 1;
    setPhase({ kind: "choose" });
    setError(null);
  }, [hostId, connected]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  // The step that replaced the pressed button takes focus, so a keyboard user
  // isn't left on the page body: the review from its start, the result at its actions.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = phase.kind === "preview" || phase.kind === "result" ? phase.kind : "choose";
    successorFocus(
      sectionRef.current?.querySelector<HTMLElement>(`[data-copy-focus="${target}"]`) ?? null
    );
  }, [phase.kind]);

  const busy = phase.kind === "previewing" || phase.kind === "applying";
  const chosen = PORTABLE_SETTINGS_CATEGORIES.filter((category) => selected.has(category.id));
  const thisMac = deviceOwnerPhrase();

  const reset = () => {
    generation.current += 1;
    setPhase({ kind: "choose" });
    setError(null);
  };

  const toggle = (id: PortableSettingsCategoryId, on: boolean) => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const allSelected = PORTABLE_SETTINGS_CATEGORIES.every((category) => selected.has(category.id));
  const toggleAll = (on: boolean) => {
    if (busy) return;
    setSelected(on ? new Set(PORTABLE_SETTINGS_CATEGORIES.map((c) => c.id)) : new Set());
  };

  const preview = (
    ids: PortableSettingsCategoryId[] = chosen.map((c) => c.id),
    from: "choose" | "differences" = "choose"
  ) => {
    if (busy || ids.length === 0) return;
    const ticket = ++generation.current;
    setPhase({ kind: "previewing", from });
    setError(null);
    window.electron.settingsCopy.preview({ hostId, categories: ids }).then(
      (result) => {
        if (generation.current !== ticket) return;
        setPhase({ kind: "preview", preview: result });
      },
      (err: unknown) => {
        if (generation.current !== ticket) return;
        setPhase({ kind: "choose" });
        setError({
          message: clientErrorText(err, `Couldn't preview the copy on ${hostName}`),
          previewAgain: true,
        });
      }
    );
  };

  /** From the comparison at the top: exactly the categories that differ. */
  const previewDifferences = (ids: PortableSettingsCategoryId[]) => {
    if (busy) return;
    setSelected(new Set(ids));
    preview(ids, "differences");
  };

  const apply = () => {
    if (phase.kind !== "preview") return;
    const shown = phase.preview;
    const ticket = ++generation.current;
    setPhase({ kind: "applying", preview: shown });
    setError(null);
    window.electron.settingsCopy.apply({ hostId, ticket: shown.ticket }).then(
      (report) => {
        // What the host now has, and the copy it just recorded.
        status.refresh();
        if (generation.current !== ticket) return;
        setPhase({ kind: "result", preview: shown, report });
      },
      (err: unknown) => {
        if (clientErrorCode(err) === "OUTCOME_UNKNOWN") status.refresh();
        if (generation.current !== ticket) return;
        // The host spends a preview's ticket on the attempt, so whatever went
        // wrong, the next copy starts from a fresh preview.
        setPhase({ kind: "choose" });
        setError({
          message: clientErrorText(err, `Couldn't copy settings to ${hostName}`),
          previewAgain: true,
        });
      }
    );
  };

  const description = offered
    ? `${hostName} starts from defaults. Copy ${thisMac}'s settings to it now, or come back here later`
    : `Copy ${thisMac}'s settings to ${hostName}, once. Credentials, permissions you granted and plugins stay on each machine`;

  if (!connected) {
    return (
      <SettingsSection id="host-copy-settings" title="Copy settings" description={description}>
        <SettingsGroup>
          <SettingsEmptyRow>Connect to {hostName} to copy settings to it</SettingsEmptyRow>
        </SettingsGroup>
      </SettingsSection>
    );
  }

  const categoryRow = (category: PortableSettingsCategory) => (
    <SettingsCheckbox
      key={category.id}
      id={`host-copy-${category.id}`}
      label={category.label}
      description={category.description}
      checked={selected.has(category.id)}
      onChange={(on) => toggle(category.id, on)}
      disabled={busy}
    />
  );

  const choosing = phase.kind === "choose" || phase.kind === "previewing";
  const errorStatus = error ? (
    <SettingsInlineError role="alert">{error.message}</SettingsInlineError>
  ) : null;

  return (
    <SettingsSection id="host-copy-settings" title="Copy settings" description={description}>
      <div className="space-y-4" ref={sectionRef}>
        <HostCopyDriftGroup
          hostName={hostName}
          state={status.state}
          busy={busy}
          onRefresh={status.refresh}
          onPreview={previewDifferences}
          previewing={phase.kind === "previewing" && phase.from === "differences"}
        />

        {choosing ? (
          <>
            <SettingsGroup label="What to copy">
              <SettingsCheckbox
                id="host-copy-all"
                label="Select all"
                description={`${pluralize(selected.size, "category", "categories")} of ${PORTABLE_SETTINGS_CATEGORIES.length} chosen`}
                checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
                onChange={toggleAll}
                disabled={busy}
              />
              {HOST_CATEGORIES.map(categoryRow)}
            </SettingsGroup>
            <SettingsGroup label={`For using ${hostName} directly`}>
              {DEVICE_CATEGORIES.map(categoryRow)}
              <SettingsActions
                status={
                  errorStatus ??
                  (phase.kind === "previewing"
                    ? `Previewing on ${hostName}…`
                    : selected.size === 0
                      ? "Choose what to copy"
                      : undefined)
                }
              >
                <Button
                  variant="contrast"
                  size="sm"
                  onClick={() => preview()}
                  disabled={selected.size === 0}
                  loading={phase.kind === "previewing" && phase.from === "choose"}
                  data-copy-focus="choose"
                >
                  {error?.previewAgain ? "Preview again" : `Preview changes on ${hostName}`}
                </Button>
              </SettingsActions>
            </SettingsGroup>
          </>
        ) : phase.kind === "result" ? null : (
          <SettingsGroup label="What to copy">
            <SettingsRow
              label={pluralize(chosen.length, "category", "categories")}
              description={listPhrase(chosen.map((category) => category.label))}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={reset}
                  disabled={busy}
                  data-copy-focus="preview"
                >
                  Change
                </Button>
              }
            />
          </SettingsGroup>
        )}

        {(phase.kind === "preview" || phase.kind === "applying") && (
          <PreviewGroup
            hostId={hostId}
            hostName={hostName}
            preview={phase.preview}
            categories={chosen}
            applying={phase.kind === "applying"}
            error={errorStatus}
            onCancel={reset}
            onCopy={apply}
          />
        )}

        {phase.kind === "result" && (
          <ResultGroups
            preview={phase.preview}
            report={phase.report}
            hostName={hostName}
            categories={chosen}
            onPreviewAgain={() => preview()}
            onDone={reset}
          />
        )}

        <HostLastCopyGroup
          hostId={hostId}
          hostName={hostName}
          state={status.state}
          busy={busy}
          onRefresh={status.refresh}
          onUndone={(lastCopy) => {
            // Shown at once; the refresh then brings the comparison up to date.
            const current = statusOf(status.state);
            if (current) status.show({ ...current, lastCopy });
            status.refresh();
          }}
        />
      </div>
    </SettingsSection>
  );
}

interface PreviewGroupProps {
  hostId: HostId;
  hostName: string;
  preview: SettingsCopyPreview;
  categories: readonly PortableSettingsCategory[];
  applying: boolean;
  error: ReactNode;
  onCancel: () => void;
  onCopy: () => void;
}

/**
 * The review: each category with something in it leads with its counts and
 * lists its settings under it; the ones already the same share a row; the
 * Copy button ends the group, where the review ends.
 */
function PreviewGroup({
  hostId,
  hostName,
  preview,
  categories,
  applying,
  error,
  onCancel,
  onCopy,
}: PreviewGroupProps) {
  const items = categoryPreviews(preview, categories);
  const totals = previewTotals(items);
  const total = totals.update + totals.add;
  const kind = classifyPreview(items);
  const headline =
    kind === "changes"
      ? `${pluralize(total, "change")} on ${hostName}`
      : kind === "blocked"
        ? `Nothing here can be copied to ${hostName}`
        : kind === "same"
          ? `${hostName} already has these settings`
          : `Nothing set on ${deviceOwnerPhrase()} to copy`;
  const detail = [
    total > 0 ? changePhrase(totals.update, totals.add) : null,
    totals.notCopied > 0 ? `${totals.notCopied} won't copy` : null,
    totals.tooOld > 0
      ? `${pluralize(totals.tooOld, "category", "categories")} ${totals.tooOld === 1 ? "needs" : "need"} a newer Daintree`
      : null,
  ].filter((part): part is string => part !== null);
  const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  const summary = detail.length > 0 ? sentenceCase(detail.join(". ")) : undefined;
  return (
    <SettingsGroup label={`Preview on ${hostName}`}>
      <SettingsRow
        label={headline}
        description={summary}
        control={
          totals.tooOld > 0 ? (
            <UpdateDaintreeButton hostId={hostId} hostName={hostName} />
          ) : undefined
        }
      />
      {items
        .filter((item) => !isQuiet(item))
        .map((item) => (
          <CategoryPreviewRows key={item.category.id} item={item} hostName={hostName} />
        ))}
      <QuietCategoryRows items={items} hostName={hostName} />
      <SettingsActions
        status={
          error ??
          (applying
            ? `Copying to ${hostName}…`
            : total > 0
              ? `${pluralize(total, "change")}: ${changePhrase(totals.update, totals.add)}`
              : undefined)
        }
      >
        <Button variant="outline" size="sm" onClick={onCancel} disabled={applying}>
          Cancel
        </Button>
        <Button
          variant="contrast"
          size="sm"
          onClick={onCopy}
          disabled={total === 0}
          loading={applying}
        >
          Copy to {hostName}
        </Button>
      </SettingsActions>
    </SettingsGroup>
  );
}

interface ResultGroupsProps {
  preview: SettingsCopyPreview;
  report: ConfigImportReport;
  hostName: string;
  categories: readonly PortableSettingsCategory[];
  onPreviewAgain: () => void;
  onDone: () => void;
}

/** The outcome first, in one verdict; then what each category did and what didn't copy. */
function ResultGroups({
  preview,
  report,
  hostName,
  categories,
  onPreviewAgain,
  onDone,
}: ResultGroupsProps) {
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const totals = reportTotals(report);
  const rolledBack = report.outcome === "rolled-back";
  // Undoing an earlier category failed too: some of it may have stayed.
  const partly = rolledBack && report.restoreFailed === true;
  const failedAll = !rolledBack && totals.failed > 0 && totals.applied === 0;
  // Everything the result lists below besides failures: skipped settings, categories
  // the host doesn't know, names kept here as secrets.
  const items = categoryPreviews(preview, categories);
  const tooOld = items.filter((item) => item.unknown.length > 0).length;
  const keptHere = items.reduce((sum, item) => sum + item.withheld.length, 0);
  const exceptions = [
    totals.skipped > 0 ? `${totals.skipped} skipped` : null,
    tooOld > 0
      ? `${pluralize(tooOld, "category", "categories")} ${hostName} doesn't know yet`
      : null,
    keptHere > 0 ? `${keptHere} kept on ${deviceOwnerPhrase()}` : null,
  ].filter((part): part is string => part !== null);
  const retry = rolledBack || totals.failed > 0;

  const verdict = rolledBack ? (
    <Callout
      severity="error"
      role="alert"
      title={partly ? `Settings on ${hostName} may be partly changed` : "Nothing was copied"}
    >
      <p>
        {partly
          ? `The copy failed and ${hostName} couldn't put everything back. Preview again to see where its settings stand.`
          : `${hostName} hit a problem partway, so it put back everything it had changed.`}
      </p>
      {report.errors.length > 0 && (
        <>
          <Button
            variant="link"
            size="inline"
            className="mt-1"
            aria-expanded={details}
            aria-controls={detailsId}
            onClick={() => setDetails((value) => !value)}
          >
            {details ? "Hide details" : "Show details"}
          </Button>
          {details && (
            <ul id={detailsId} className="mt-1 space-y-0.5 break-words select-text">
              {report.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Callout>
  ) : failedAll ? (
    <Callout severity="error" role="alert" title="Nothing was copied">
      {`${pluralize(totals.failed, "setting")} failed on ${hostName}. Each is listed below with why`}
    </Callout>
  ) : totals.failed > 0 ? (
    <Callout
      severity="warning"
      role="alert"
      title={`${pluralize(totals.failed, "setting")} didn't copy`}
    >
      {`${totals.applied} copied to ${hostName}. The ones that failed are listed below with why`}
    </Callout>
  ) : (
    <Callout
      severity="success"
      role="status"
      title={`${pluralize(totals.applied, "setting")} copied to ${hostName}`}
    >
      {exceptions.length > 0
        ? `${exceptions.join(", ").replace(/^./, (c) => c.toUpperCase())}. Listed below with why`
        : undefined}
    </Callout>
  );

  const reports = rolledBack ? [] : categoryReports(report, preview, categories);
  const reported = new Set(reports.map((item) => item.category.id));
  const absent = categories.filter((category) => !reported.has(category.id));

  return (
    <>
      {verdict}
      <SettingsGroup label={`Copy to ${hostName}`}>
        {rolledBack ? (
          <SettingsRow
            label={`${pluralize(categories.length, "category", "categories")} tried`}
            description={listPhrase(categories.map((category) => category.label))}
          />
        ) : (
          <>
            {reports.filter(needsReport).map((item) => (
              <CategoryReportRows key={item.category.id} item={item} hostName={hostName} />
            ))}
            <CopiedCategoriesRow items={reports} />
            <UncopiedCategoryRows items={categoryPreviews(preview, absent)} hostName={hostName} />
          </>
        )}
        <SettingsActions>
          <Button
            variant={retry ? "outline" : "contrast"}
            size="sm"
            onClick={onDone}
            data-copy-focus={retry ? undefined : "result"}
          >
            Done
          </Button>
          {retry && (
            <Button variant="contrast" size="sm" onClick={onPreviewAgain} data-copy-focus="result">
              Preview again
            </Button>
          )}
        </SettingsActions>
      </SettingsGroup>
    </>
  );
}
