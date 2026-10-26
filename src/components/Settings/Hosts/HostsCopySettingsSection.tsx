import { useEffect, useRef, useState, type ReactNode } from "react";
import PQueue from "p-queue";
import { Button } from "@/components/ui/button";
import {
  PORTABLE_SETTINGS_CATEGORIES,
  type PortableSettingsCategory,
  type PortableSettingsCategoryId,
} from "@shared/config/portableSettings";
import type { ConfigImportReport } from "@shared/types/configBundle";
import type { SettingsCopyPreview } from "@shared/types/ipc/settingsCopy";
import type { HostId } from "@shared/types/remoteHosts";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { pluralNoun, pluralize } from "@/lib/pluralize";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsSection } from "../SettingsSection";
import { SettingsActions, SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import {
  DEVICE_CATEGORIES,
  HOST_CATEGORIES,
  changeTotal,
  describeChange,
} from "./settingsCopyPreview";

export interface CopyTargetHost {
  id: HostId;
  name: string;
  connected: boolean;
}

interface HostsCopySettingsSectionProps {
  hosts: readonly CopyTargetHost[];
  /** Open a host's own page, where its copy status and undo live. */
  onOpenHost: (hostId: HostId) => void;
}

type ProblemKind = "offline" | "older" | "refused" | "changed" | "unknown" | "failed";

/** One host's place in a multi-host copy. Hosts never share a state: one failing leaves the rest. */
type HostCopy =
  | { kind: "previewing" }
  | { kind: "preview"; preview: SettingsCopyPreview }
  | { kind: "applying"; preview: SettingsCopyPreview }
  | { kind: "done"; preview: SettingsCopyPreview; report: ConfigImportReport }
  | { kind: "problem"; problem: ProblemKind; message: string };

type Stage = "choose" | "previewing" | "preview" | "applying" | "result";

/**
 * Hosts previewed or copied at once. Each is a round trip over that host's own
 * link and, for a copy, a write there; a long list shouldn't open them all together.
 */
const HOST_CONCURRENCY = 3;

function defaultSelection(): Set<PortableSettingsCategoryId> {
  return new Set(
    PORTABLE_SETTINGS_CATEGORIES.filter((category) => category.selectedByDefault).map((c) => c.id)
  );
}

function problemFor(err: unknown, hostName: string, fallback: string): HostCopy {
  const message = clientErrorText(err, fallback);
  switch (clientErrorCode(err)) {
    case "HOST_DISCONNECTED":
      return { kind: "problem", problem: "offline", message: `${hostName} is offline` };
    case "UNSUPPORTED":
      return { kind: "problem", problem: "older", message };
    case "SETTINGS_PREVIEW_STALE":
      return { kind: "problem", problem: "changed", message };
    case "OUTCOME_UNKNOWN":
      return { kind: "problem", problem: "unknown", message };
    case "VALIDATION":
      return { kind: "problem", problem: "refused", message };
    default:
      return { kind: "problem", problem: "failed", message };
  }
}

const PROBLEM_LABEL: Record<ProblemKind, string> = {
  offline: "Offline",
  older: "Older build",
  refused: "Refused",
  changed: "Changed since preview",
  unknown: "Outcome unknown",
  failed: "Failed",
};

/** An offline host has no error to show, so its message stays in the description. */
function problemText(copy: Extract<HostCopy, { kind: "problem" }>): {
  description?: string;
  error?: string;
} {
  return copy.problem === "offline" ? { description: copy.message } : { error: copy.message };
}

function resultSummary(copy: HostCopy): { label: string; detail?: string } {
  if (copy.kind === "problem") return { label: PROBLEM_LABEL[copy.problem], detail: copy.message };
  if (copy.kind !== "done") return { label: "" };
  const { report } = copy;
  if (report.outcome === "rolled-back") {
    return {
      label: report.restoreFailed === true ? "Partly changed" : "Not applied",
      detail:
        report.errors[0] ??
        (report.restoreFailed === true ? "Preview again to see where it stands" : undefined),
    };
  }
  const sum = (key: "applied" | "skipped" | "failed") =>
    report.sections.reduce((total, section) => total + section[key], 0);
  const applied = sum("applied");
  const skipped = sum("skipped");
  const failed = sum("failed");
  if (applied + skipped + failed === 0) {
    return { label: "Skipped", detail: "Already had these settings" };
  }
  const detail = [
    applied > 0 ? pluralize(applied, "setting") : null,
    skipped > 0 ? `${skipped} skipped` : null,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const label =
    applied === 0
      ? failed > 0
        ? "Failed"
        : "Not applied"
      : failed > 0
        ? "Partly applied"
        : "Applied";
  return { label, detail };
}

/**
 * Settings → Hosts → Copy settings to several hosts (#14707): the single-host
 * copy of #13346 run against each picked host on its own. Every host gets its
 * own preview, ticket and outcome, so one being offline, older or changed since
 * its preview refuses that host alone, and each keeps the undo its own page offers.
 */
export function HostsCopySettingsSection({ hosts, onOpenHost }: HostsCopySettingsSectionProps) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("choose");
  const [pickedHosts, setPickedHosts] = useState<Set<HostId>>(new Set());
  const [categories, setCategories] = useState(defaultSelection);
  const [copies, setCopies] = useState<Record<string, HostCopy>>({});
  // Answers to a run that was cancelled or replaced are dropped, never shown.
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const busy = stage === "previewing" || stage === "applying";
  const targets = hosts.filter((host) => pickedHosts.has(host.id));
  const setCopy = (hostId: HostId, copy: HostCopy) =>
    setCopies((prev) => ({ ...prev, [hostId]: copy }));

  const reset = () => {
    generation.current += 1;
    setStage("choose");
    setCopies({});
  };

  const close = () => {
    reset();
    setOpen(false);
  };

  const edited = () => {
    // What was previewed is no longer what would be copied.
    if (stage !== "choose") reset();
  };

  const toggleHost = (id: HostId, on: boolean) => {
    if (busy) return;
    setPickedHosts((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    edited();
  };

  const toggleCategory = (id: PortableSettingsCategoryId, on: boolean) => {
    if (busy) return;
    setCategories((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    edited();
  };

  const preview = () => {
    if (busy || targets.length === 0 || categories.size === 0) return;
    const ticket = ++generation.current;
    const ids = PORTABLE_SETTINGS_CATEGORIES.filter((c) => categories.has(c.id)).map((c) => c.id);
    setStage("previewing");
    setCopies({});
    const queue = new PQueue({ concurrency: HOST_CONCURRENCY });
    const runs = targets.map((host) => {
      if (!host.connected) {
        setCopy(host.id, {
          kind: "problem",
          problem: "offline",
          message: `${host.name} is offline`,
        });
        return Promise.resolve();
      }
      setCopy(host.id, { kind: "previewing" });
      return queue.add(async () => {
        // Cancelled or replaced while it waited: nothing would show its answer.
        if (generation.current !== ticket) return;
        await window.electron.settingsCopy.preview({ hostId: host.id, categories: ids }).then(
          (result) => {
            if (generation.current === ticket) {
              setCopy(host.id, { kind: "preview", preview: result });
            }
          },
          (err: unknown) => {
            if (generation.current === ticket) {
              setCopy(
                host.id,
                problemFor(err, host.name, `Couldn't preview the copy on ${host.name}`)
              );
            }
          }
        );
      });
    });
    void Promise.all(runs).then(() => {
      if (generation.current === ticket) setStage("preview");
    });
  };

  const applicable = targets.filter((host) => {
    const copy = copies[host.id];
    return copy?.kind === "preview" && changeTotal(copy.preview) > 0;
  });

  const apply = () => {
    if (stage !== "preview" || applicable.length === 0) return;
    const ticket = ++generation.current;
    setStage("applying");
    // Every host here was confirmed, so a queued copy still runs if the page
    // closes meanwhile; only its answer is dropped.
    const queue = new PQueue({ concurrency: HOST_CONCURRENCY });
    const runs = targets.map((host) => {
      const copy = copies[host.id];
      if (copy?.kind !== "preview") return Promise.resolve();
      if (changeTotal(copy.preview) === 0) {
        setCopy(host.id, { kind: "done", preview: copy.preview, report: SKIPPED_REPORT });
        return Promise.resolve();
      }
      const shown = copy.preview;
      setCopy(host.id, { kind: "applying", preview: shown });
      return queue.add(() =>
        window.electron.settingsCopy.apply({ hostId: host.id, ticket: shown.ticket }).then(
          (report) => {
            if (generation.current === ticket) {
              setCopy(host.id, { kind: "done", preview: shown, report });
            }
          },
          (err: unknown) => {
            if (generation.current === ticket) {
              setCopy(
                host.id,
                problemFor(err, host.name, `Couldn't copy settings to ${host.name}`)
              );
            }
          }
        )
      );
    });
    void Promise.all(runs).then(() => {
      if (generation.current === ticket) setStage("result");
    });
  };

  if (hosts.length < 2) return null;

  const allCategories = PORTABLE_SETTINGS_CATEGORIES.every((c) => categories.has(c.id));
  const chosenCategories = PORTABLE_SETTINGS_CATEGORIES.filter((c) => categories.has(c.id));
  const showResults = stage !== "choose";

  const categoryRow = (category: PortableSettingsCategory) => (
    <SettingsCheckbox
      key={category.id}
      id={`hosts-copy-${category.id}`}
      label={category.label}
      description={category.description}
      checked={categories.has(category.id)}
      onChange={(on) => toggleCategory(category.id, on)}
      disabled={busy}
    />
  );

  return (
    <SettingsSection
      id="hosts-copy-settings"
      title="Copy settings to several hosts"
      description={
        open
          ? "Each host is previewed and copied on its own. One that is offline, older or changed since its preview is left out; the others still copy."
          : "Send this computer's agents, environment and other portable settings to more than one host in a single pass, with a preview and an outcome for each"
      }
      action={
        open ? undefined : (
          <Button
            variant="outline"
            size="sm"
            data-testid="hosts-copy-several"
            onClick={() => setOpen(true)}
          >
            Choose hosts
          </Button>
        )
      }
    >
      {open && (
        <div className="space-y-4">
          <SettingsGroup label="Hosts">
            {hosts.map((host) => (
              <SettingsCheckbox
                key={host.id}
                id={`hosts-copy-host-${host.id}`}
                label={host.name}
                description={host.connected ? "Connected" : "Offline: reported, not copied"}
                checked={pickedHosts.has(host.id)}
                onChange={(on) => toggleHost(host.id, on)}
                disabled={busy}
              />
            ))}
          </SettingsGroup>

          <SettingsGroup label="What to copy">
            <SettingsCheckbox
              id="hosts-copy-all"
              label="Select all"
              description={`${pluralize(categories.size, "category", "categories")} of ${PORTABLE_SETTINGS_CATEGORIES.length} chosen`}
              checked={allCategories}
              onChange={(on) => {
                if (busy) return;
                setCategories(
                  on ? new Set(PORTABLE_SETTINGS_CATEGORIES.map((c) => c.id)) : new Set()
                );
                edited();
              }}
              disabled={busy}
            />
            {HOST_CATEGORIES.map(categoryRow)}
          </SettingsGroup>

          <SettingsGroup label="For using these hosts directly">
            {DEVICE_CATEGORIES.map(categoryRow)}
            {!showResults && (
              <SettingsActions
                status={
                  targets.length === 0
                    ? "Choose at least one host"
                    : categories.size === 0
                      ? "Choose what to copy"
                      : undefined
                }
              >
                <Button variant="outline" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button
                  variant="contrast"
                  size="sm"
                  onClick={preview}
                  disabled={targets.length === 0 || categories.size === 0}
                >
                  {`Preview on ${pluralize(targets.length, "host")}`}
                </Button>
              </SettingsActions>
            )}
          </SettingsGroup>

          {showResults && stage !== "result" && (
            <>
              {targets.map((host) => {
                const copy = copies[host.id];
                if (!copy) return null;
                return (
                  <HostPreviewGroup
                    key={host.id}
                    hostName={host.name}
                    copy={copy}
                    categories={chosenCategories}
                  />
                );
              })}
              <SettingsGroup>
                <SettingsActions
                  status={
                    stage === "preview"
                      ? applicable.length === 0
                        ? "Nothing to copy to these hosts"
                        : `${pluralize(applicable.length, "host")} will change`
                      : undefined
                  }
                >
                  <Button variant="outline" size="sm" onClick={reset} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    variant="contrast"
                    size="sm"
                    onClick={apply}
                    disabled={busy || applicable.length === 0}
                    aria-busy={stage === "applying" || undefined}
                  >
                    {`Copy to ${pluralize(applicable.length, "host")}`}
                  </Button>
                </SettingsActions>
              </SettingsGroup>
            </>
          )}

          {stage === "result" && (
            <SettingsGroup label="Results">
              {targets.map((host) => {
                const copy = copies[host.id];
                if (!copy) return null;
                const summary = resultSummary(copy);
                const problem = copy.kind === "problem" ? problemText(copy) : null;
                return (
                  <SettingsRow
                    key={host.id}
                    label={host.name}
                    description={
                      problem?.error !== undefined
                        ? summary.label
                        : [summary.label, summary.detail].filter(Boolean).join(" · ")
                    }
                    error={problem?.error}
                    control={
                      <Button variant="outline" size="sm" onClick={() => onOpenHost(host.id)}>
                        Open {host.name}
                      </Button>
                    }
                  />
                );
              })}
              <SettingsActions status="Undo is on each host's page">
                <Button variant="outline" size="sm" onClick={close}>
                  Done
                </Button>
              </SettingsActions>
            </SettingsGroup>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

interface HostPreviewGroupProps {
  hostName: string;
  copy: HostCopy;
  categories: readonly PortableSettingsCategory[];
}

/** One host's own preview: every setting it would change, as its own page shows them. */
function HostPreviewGroup({ hostName, copy, categories }: HostPreviewGroupProps) {
  let rows: ReactNode;
  if (copy.kind === "previewing") {
    rows = <SettingsEmptyRow>Previewing…</SettingsEmptyRow>;
  } else if (copy.kind === "problem") {
    rows = <SettingsRow label={PROBLEM_LABEL[copy.problem]} {...problemText(copy)} />;
  } else {
    const { preview } = copy;
    const sectionsOf = (category: PortableSettingsCategory) =>
      preview.sections.filter((section) => category.sections.includes(section.section));
    const changes = categories.flatMap((category) =>
      sectionsOf(category).flatMap((section) =>
        section.changes.map((change) => (
          <SettingsRow
            key={`change-${section.section}-${change.key}`}
            label={change.label}
            description={`${category.label} · ${describeChange(change)}`}
          />
        ))
      )
    );
    const skipped = categories.flatMap((category) =>
      sectionsOf(category).flatMap((section) =>
        (section.skipped ?? []).map((skip) => (
          <SettingsRow
            key={`skip-${section.section}-${skip.key}`}
            label={skip.label}
            description={`${category.label} · Skipped · ${skip.reason}`}
          />
        ))
      )
    );
    const unknown = categories.filter((category) =>
      category.sections.some((section) => preview.unknownSections.includes(section))
    );
    const unchanged = preview.sections.reduce((sum, section) => sum + section.unchanged, 0);
    rows = (
      <>
        {unknown.length > 0 && (
          <SettingsRow
            label="Not known there yet"
            description={`${unknown.map((category) => category.label).join(", ")}: update Daintree on ${hostName} to copy them`}
          />
        )}
        {changes}
        {skipped}
        {preview.withheld.length > 0 && (
          <SettingsRow
            label="Stays on this computer"
            description={`${preview.withheld.map((w) => w.name).join(", ")} ${pluralNoun(preview.withheld.length, "looks like a secret", "look like secrets")}`}
          />
        )}
        {changes.length === 0 && skipped.length === 0 && unknown.length === 0 && (
          <SettingsEmptyRow>
            {unchanged > 0
              ? `Already the same on ${hostName}`
              : "Nothing set on this computer to copy"}
          </SettingsEmptyRow>
        )}
      </>
    );
  }
  return <SettingsGroup label={hostName}>{rows}</SettingsGroup>;
}

const SKIPPED_REPORT: ConfigImportReport = {
  outcome: "applied",
  rolledBack: false,
  errors: [],
  sections: [],
};
