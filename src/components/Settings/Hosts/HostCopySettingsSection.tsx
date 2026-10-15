import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  PORTABLE_SETTINGS_CATEGORIES,
  type PortableSettingsCategory,
  type PortableSettingsCategoryId,
} from "@shared/config/portableSettings";
import type {
  ConfigBundlePreviewChange,
  ConfigBundlePreviewSection,
  ConfigImportReport,
} from "@shared/types/configBundle";
import type { SettingsCopyPreview } from "@shared/types/ipc/settingsCopy";
import type { HostId } from "@shared/types/remoteHosts";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { pluralNoun, pluralize } from "@/lib/pluralize";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsSection } from "../SettingsSection";
import { SettingsActions, SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { HostCopyStatusGroup } from "./HostCopyStatusGroup";
import { useHostSettingsCopyStatus } from "./useHostSettingsCopyStatus";

interface HostCopySettingsSectionProps {
  hostId: HostId;
  hostName: string;
  connected: boolean;
  /** Just added and connected for the first time: the copy is offered. */
  offered?: boolean;
}

type Phase =
  | { kind: "choose" }
  | { kind: "previewing" }
  | { kind: "preview"; preview: SettingsCopyPreview }
  | { kind: "applying"; preview: SettingsCopyPreview }
  | { kind: "result"; preview: SettingsCopyPreview; report: ConfigImportReport };

interface CopyError {
  message: string;
  /** The host's settings moved on since the preview, or the outcome is unknown: preview again. */
  previewAgain: boolean;
}

const HOST_CATEGORIES = PORTABLE_SETTINGS_CATEGORIES.filter((category) => !category.device);
const DEVICE_CATEGORIES = PORTABLE_SETTINGS_CATEGORIES.filter((category) => category.device);

function defaultSelection(): Set<PortableSettingsCategoryId> {
  return new Set(
    PORTABLE_SETTINGS_CATEGORIES.filter((category) => category.selectedByDefault).map((c) => c.id)
  );
}

/** "Replaced · On → Off", "Added · 4 hours", plus anything to know first. */
function describeChange(change: ConfigBundlePreviewChange): string {
  const parts: string[] = [];
  if (change.kind === "update") {
    if (change.from !== undefined && change.to !== undefined) {
      parts.push(`Replaced · ${change.from} → ${change.to}`);
    } else if (change.renamedTo) {
      parts.push(`Replaced · becomes ${change.renamedTo}`);
    } else {
      parts.push("Replaced");
    }
  } else {
    parts.push(change.to !== undefined ? `Added · ${change.to}` : "Added");
  }
  if (change.note) parts.push(change.note);
  return parts.join(". ");
}

function sectionsOf(
  category: PortableSettingsCategory,
  sections: ConfigBundlePreviewSection[]
): ConfigBundlePreviewSection[] {
  return sections.filter((section) => category.sections.includes(section.section));
}

function changeTotal(preview: SettingsCopyPreview): number {
  return preview.sections.reduce((sum, section) => sum + section.add + section.update, 0);
}

/**
 * Settings → Hosts → a host → Copy settings (#13346): push this machine's own
 * settings to the host, chosen by category. The host works out the preview
 * against its live settings and applies exactly what was shown, or asks for a
 * fresh preview if its settings changed in between. Credentials, consent and
 * per-project state never travel; nothing syncs afterwards.
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
  // Answers for a request that has since been superseded (selection changed,
  // a newer preview, the host went away) are dropped, never shown.
  const generation = useRef(0);
  const status = useHostSettingsCopyStatus(hostId, hostName, connected);

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

  const busy = phase.kind === "previewing" || phase.kind === "applying";

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
    // What was previewed is no longer what would be copied.
    if (phase.kind !== "choose") reset();
  };

  const allSelected = PORTABLE_SETTINGS_CATEGORIES.every((category) => selected.has(category.id));
  const toggleAll = (on: boolean) => {
    if (busy) return;
    setSelected(on ? new Set(PORTABLE_SETTINGS_CATEGORIES.map((c) => c.id)) : new Set());
    if (phase.kind !== "choose") reset();
  };

  const preview = () => {
    if (busy || selected.size === 0) return;
    const ticket = ++generation.current;
    setPhase({ kind: "previewing" });
    setError(null);
    window.electron.settingsCopy
      .preview({
        hostId,
        categories: PORTABLE_SETTINGS_CATEGORIES.filter((c) => selected.has(c.id)).map((c) => c.id),
      })
      .then(
        (result) => {
          if (generation.current !== ticket) return;
          setPhase({ kind: "preview", preview: result });
        },
        (err: unknown) => {
          if (generation.current !== ticket) return;
          setPhase({ kind: "choose" });
          setError({
            message: clientErrorText(err, `Couldn't preview the copy on ${hostName}`),
            previewAgain: false,
          });
        }
      );
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
        const code = clientErrorCode(err);
        const previewAgain = code === "SETTINGS_PREVIEW_STALE" || code === "OUTCOME_UNKNOWN";
        setPhase(previewAgain ? { kind: "choose" } : { kind: "preview", preview: shown });
        setError({
          message: clientErrorText(err, `Couldn't copy settings to ${hostName}`),
          previewAgain,
        });
      }
    );
  };

  const description = offered
    ? `${hostName} starts from defaults. Copy this computer's settings to it now, or come back here later`
    : `Copy this computer's settings to ${hostName}, once. Credentials, permissions you granted and plugins stay on each machine`;

  if (!connected) {
    return (
      <SettingsSection id="host-copy-settings" title="Copy settings" description={description}>
        <SettingsGroup>
          <SettingsEmptyRow>Connect to {hostName} to copy settings to it</SettingsEmptyRow>
        </SettingsGroup>
      </SettingsSection>
    );
  }

  const shown = phase.kind === "choose" || phase.kind === "previewing" ? null : phase.preview;

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

  return (
    <SettingsSection id="host-copy-settings" title="Copy settings" description={description}>
      <div className="space-y-4">
        <HostCopyStatusGroup
          hostId={hostId}
          hostName={hostName}
          state={status.state}
          busy={busy}
          onRefresh={status.refresh}
          onUndone={(lastCopy) => {
            // Shown at once; the refresh then brings the drift up to date.
            const current =
              status.state.kind === "ready"
                ? status.state.status
                : status.state.kind === "loading"
                  ? status.state.previous
                  : null;
            if (current) status.show({ ...current, lastCopy });
            status.refresh();
          }}
        />
        <SettingsGroup label="What to copy">
          <SettingsCheckbox
            id="host-copy-all"
            label="Select all"
            description={`${pluralize(selected.size, "category", "categories")} of ${PORTABLE_SETTINGS_CATEGORIES.length} chosen`}
            checked={allSelected}
            onChange={toggleAll}
            disabled={busy}
          />
          {HOST_CATEGORIES.map(categoryRow)}
        </SettingsGroup>
        <SettingsGroup label={`For using ${hostName} directly`}>
          {DEVICE_CATEGORIES.map(categoryRow)}
          {shown === null && (
            <SettingsActions
              status={
                error ? (
                  <span role="alert" className="text-status-error select-text">
                    {error.message}
                  </span>
                ) : selected.size === 0 ? (
                  "Choose what to copy"
                ) : undefined
              }
            >
              <Button
                variant="contrast"
                size="sm"
                onClick={preview}
                disabled={busy || selected.size === 0}
                aria-busy={phase.kind === "previewing" || undefined}
              >
                {error?.previewAgain ? "Preview again" : `Preview changes on ${hostName}`}
              </Button>
            </SettingsActions>
          )}
        </SettingsGroup>

        {shown !== null && phase.kind !== "result" && (
          <PreviewGroups
            preview={shown}
            hostName={hostName}
            selected={selected}
            footer={
              <SettingsActions
                status={
                  error ? (
                    <span role="alert" className="text-status-error select-text">
                      {error.message}
                    </span>
                  ) : changeTotal(shown) === 0 ? (
                    `${hostName} already has these settings`
                  ) : (
                    `${pluralize(changeTotal(shown), "change")} on ${hostName}`
                  )
                }
              >
                <Button variant="outline" size="sm" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="contrast"
                  size="sm"
                  onClick={apply}
                  disabled={busy || changeTotal(shown) === 0}
                  aria-busy={phase.kind === "applying" || undefined}
                >
                  Copy to {hostName}
                </Button>
              </SettingsActions>
            }
          />
        )}

        {phase.kind === "result" && (
          <ResultGroups
            preview={phase.preview}
            report={phase.report}
            hostName={hostName}
            selected={selected}
            onDone={reset}
          />
        )}
      </div>
    </SettingsSection>
  );
}

interface PreviewGroupsProps {
  preview: SettingsCopyPreview;
  hostName: string;
  selected: ReadonlySet<PortableSettingsCategoryId>;
  footer: ReactNode;
}

function PreviewGroups({ preview, hostName, selected, footer }: PreviewGroupsProps) {
  const categories = PORTABLE_SETTINGS_CATEGORIES.filter((category) => selected.has(category.id));
  return (
    <>
      {categories.map((category, index) => {
        const sections = sectionsOf(category, preview.sections);
        const changes = sections.flatMap((section) => section.changes);
        const skipped = sections.flatMap((section) => section.skipped ?? []);
        const unknown = category.sections.filter((id) => preview.unknownSections.includes(id));
        const withheld = preview.withheld.filter((w) => category.sections.includes(w.section));
        const unchanged = sections.reduce((sum, section) => sum + section.unchanged, 0);
        const last = index === categories.length - 1;
        return (
          <SettingsGroup key={category.id} label={category.label}>
            {unknown.length > 0 && (
              <SettingsEmptyRow>
                Daintree on {hostName} doesn&apos;t know{" "}
                {unknown.length === category.sections.length ? "these settings" : "some of these"}{" "}
                yet. Update it there to copy them
              </SettingsEmptyRow>
            )}
            {changes.map((change) => (
              <SettingsRow
                key={`change-${change.key}`}
                label={change.label}
                description={describeChange(change)}
              />
            ))}
            {skipped.map((skip) => (
              <SettingsRow
                key={`skip-${skip.key}`}
                label={skip.label}
                description={`Skipped · ${skip.reason}`}
              />
            ))}
            {withheld.length > 0 && (
              <SettingsRow
                label="Stays on this computer"
                description={`${withheld.map((w) => w.name).join(", ")} ${pluralNoun(withheld.length, "looks like a secret", "look like secrets")}`}
              />
            )}
            {changes.length === 0 && skipped.length === 0 && unknown.length === 0 && (
              <SettingsEmptyRow>
                {unchanged > 0
                  ? `Already the same on ${hostName}`
                  : "Nothing set on this computer to copy"}
              </SettingsEmptyRow>
            )}
            {last && footer}
          </SettingsGroup>
        );
      })}
    </>
  );
}

interface ResultGroupsProps {
  preview: SettingsCopyPreview;
  report: ConfigImportReport;
  hostName: string;
  selected: ReadonlySet<PortableSettingsCategoryId>;
  onDone: () => void;
}

function ResultGroups({ preview, report, hostName, selected, onDone }: ResultGroupsProps) {
  const categories = PORTABLE_SETTINGS_CATEGORIES.filter((category) => selected.has(category.id));
  const labels = new Map(
    preview.sections.flatMap((section) => [
      ...section.changes.map(
        (change) => [`${section.section}:${change.key}`, change.label] as const
      ),
      ...(section.skipped ?? []).map(
        (skip) => [`${section.section}:${skip.key}`, skip.label] as const
      ),
    ])
  );
  const applied = report.sections.reduce((sum, section) => sum + section.applied, 0);
  const rolledBack = report.outcome === "rolled-back";
  // Undoing an earlier category failed too: some of it may have stayed.
  const partly = rolledBack && report.restoreFailed === true;

  return (
    <>
      {rolledBack ? (
        <SettingsGroup label="Not copied">
          {report.errors.map((message) => (
            <SettingsRow
              key={message}
              label={partly ? "Partly changed" : "Nothing changed"}
              description={message}
            />
          ))}
        </SettingsGroup>
      ) : (
        categories.map((category) => {
          const sections = report.sections.filter(
            (section) => section.present && category.sections.includes(section.section)
          );
          if (sections.length === 0) return null;
          const sum = (key: "applied" | "unchanged" | "skipped" | "failed") =>
            sections.reduce((total, section) => total + section[key], 0);
          const parts = [
            sum("applied") > 0 ? `${sum("applied")} applied` : null,
            sum("unchanged") > 0 ? `${sum("unchanged")} unchanged` : null,
            sum("skipped") > 0 ? `${sum("skipped")} skipped` : null,
            sum("failed") > 0 ? `${sum("failed")} failed` : null,
          ].filter((part): part is string => part !== null);
          const skippedLeaves = sections.flatMap((section) =>
            section.leaves
              .filter((leaf) => leaf.status === "skipped" || leaf.status === "failed")
              .map((leaf) => ({ section: section.section, leaf }))
          );
          return (
            <SettingsGroup key={category.id} label={category.label}>
              <SettingsRow label={parts.length > 0 ? parts.join(" · ") : "Nothing to copy"} />
              {skippedLeaves.map(({ section, leaf }) => (
                <SettingsRow
                  key={`${section}:${leaf.key}`}
                  label={labels.get(`${section}:${leaf.key}`) ?? leaf.key}
                  description={`${leaf.status === "failed" ? "Failed" : "Skipped"}${leaf.reason ? ` · ${leaf.reason}` : ""}`}
                />
              ))}
            </SettingsGroup>
          );
        })
      )}
      <SettingsGroup>
        <SettingsActions
          status={
            partly
              ? `Settings on ${hostName} may be partly changed. Preview again to see where they stand`
              : rolledBack
                ? `Nothing on ${hostName} was changed`
                : `${pluralize(applied, "setting")} copied to ${hostName}`
          }
        >
          <Button variant="outline" size="sm" onClick={onDone}>
            Done
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </>
  );
}
