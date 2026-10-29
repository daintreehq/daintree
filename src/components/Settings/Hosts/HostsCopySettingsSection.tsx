import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import PQueue from "p-queue";
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
import type { StatusSeverity } from "@/lib/statusSeverity";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { pluralize } from "@/lib/pluralize";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsSection } from "../SettingsSection";
import {
  SettingsActions,
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
  SettingsRowActions,
} from "../SettingsGroup";
import {
  CategoryPreviewRows,
  CategoryReportRows,
  DisclosureButton,
  QuietCategoryRows,
  StatusLine,
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
  changeTotal,
  isQuiet,
  listPhrase,
  previewTotals,
  reportTotals,
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
  | { kind: "waiting" }
  | { kind: "previewing" }
  | { kind: "preview"; preview: SettingsCopyPreview }
  | { kind: "queued"; preview: SettingsCopyPreview }
  | { kind: "applying"; preview: SettingsCopyPreview }
  | {
      kind: "done";
      preview: SettingsCopyPreview;
      report: ConfigImportReport;
      /** Nothing was sent, and why: identical, nothing set here, or nothing the host could take. */
      noop?: "same" | "empty" | "blocked";
    }
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
      return { kind: "problem", problem: "offline", message: `${hostName} went offline` };
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

interface Outcome {
  severity: StatusSeverity | null;
  /** The verdict, first, in a word or two. */
  label: string;
  detail?: string;
  /** Sorts hosts that need something done before the ones that are fine. */
  rank: number;
  /** A fresh preview and copy could fix it. */
  retry: boolean;
  /** Counts as copied: applied, or already had everything. */
  ok: boolean;
}

function outcomeOf(copy: HostCopy): Outcome | null {
  const not = (detail: string, rank: number, retry = true): Outcome => ({
    severity: "error",
    label: "Not copied",
    detail,
    rank,
    retry,
    ok: false,
  });
  if (copy.kind === "problem") {
    switch (copy.problem) {
      case "unknown":
        return {
          severity: "error",
          label: "Outcome unknown",
          detail: copy.message,
          rank: 0,
          retry: true,
          ok: false,
        };
      case "failed":
        return not(copy.message, 1);
      case "refused":
        return not(copy.message, 1, false);
      case "changed":
        return {
          severity: "warning",
          label: "Not copied",
          detail: "Its settings changed since the preview",
          rank: 3,
          retry: true,
          ok: false,
        };
      case "older":
        return {
          severity: "warning",
          label: "Not copied",
          detail: copy.message,
          rank: 4,
          retry: false,
          ok: false,
        };
      case "offline":
        return {
          severity: "warning",
          label: "Not copied",
          detail: "It went offline",
          rank: 5,
          retry: true,
          ok: false,
        };
    }
  }
  if (copy.kind !== "done") return null;
  const { report } = copy;
  if (report.outcome === "rolled-back") {
    return report.restoreFailed === true
      ? {
          severity: "error",
          label: "May be partly changed",
          detail: "The copy failed and couldn't put everything back",
          rank: 0,
          retry: true,
          ok: false,
        }
      : not(
          `Everything was put back after an error${report.errors[0] ? `. ${report.errors[0]}` : ""}`,
          1
        );
  }
  const { applied, skipped, failed } = reportTotals(report);
  if (copy.noop === "blocked") {
    return {
      severity: "warning",
      label: "Not copied",
      detail: `Nothing chosen could be copied there: each was refused, unknown to its Daintree, or kept on ${deviceOwnerPhrase()}`,
      rank: 4,
      retry: false,
      ok: false,
    };
  }
  if (copy.noop === "empty") {
    return { severity: null, label: "Nothing to copy", rank: 6, retry: false, ok: true };
  }
  if (applied + skipped + failed === 0) {
    return { severity: null, label: "Already the same", rank: 6, retry: false, ok: true };
  }
  if (failed > 0) {
    return applied > 0
      ? {
          severity: "warning",
          label: "Partly copied",
          detail: `${pluralize(applied, "setting")} copied, ${failed} failed`,
          rank: 2,
          retry: true,
          ok: false,
        }
      : not(`${pluralize(failed, "setting")} couldn't be written`, 1);
  }
  if (applied === 0) {
    return {
      severity: "warning",
      label: "Not copied",
      detail: `${pluralize(skipped, "setting")} skipped`,
      rank: 3,
      retry: false,
      ok: false,
    };
  }
  return {
    severity: "success",
    label: `${pluralize(applied, "setting")} copied${skipped > 0 ? `, ${skipped} skipped` : ""}`,
    rank: 7,
    retry: false,
    ok: true,
  };
}

/**
 * The verdict and its detail as one line. An error is the row's own error line
 * (the shared error treatment); anything else is the row's description.
 */
function outcomeProps(outcome: Outcome): { description?: ReactNode; error?: string } {
  const text = outcome.detail ? `${outcome.label}. ${outcome.detail}` : outcome.label;
  if (outcome.severity === "error") return { error: text };
  return {
    description: outcome.severity ? (
      <StatusLine severity={outcome.severity}>{text}</StatusLine>
    ) : (
      text
    ),
  };
}

/** What a host's row says while the run is still going. */
function progressOf(copy: HostCopy | undefined): string | null {
  switch (copy?.kind) {
    case "waiting":
      return "Waiting to preview…";
    case "previewing":
      return "Previewing…";
    case "queued":
      return "Queued";
    case "applying":
      return "Copying…";
    default:
      return null;
  }
}

function previewSummary(
  preview: SettingsCopyPreview,
  categories: readonly PortableSettingsCategory[]
) {
  const items = categoryPreviews(preview, categories);
  const totals = previewTotals(items);
  const total = totals.update + totals.add;
  const kind = classifyPreview(items);
  const parts = [
    kind === "changes"
      ? `${pluralize(total, "change")}: ${changePhrase(totals.update, totals.add)}`
      : kind === "blocked"
        ? "Nothing here can be copied"
        : kind === "same"
          ? "Already the same"
          : "Nothing to copy",
    totals.notCopied > 0 ? `${totals.notCopied} won't copy` : null,
    totals.tooOld > 0
      ? `${pluralize(totals.tooOld, "category", "categories")} ${totals.tooOld === 1 ? "needs" : "need"} a newer Daintree`
      : null,
  ].filter((part): part is string => part !== null);
  return { items, total, kind, tooOld: totals.tooOld, text: parts.join(". ") };
}

/**
 * Settings → Hosts → Copy settings to several hosts (#14707): the single-host
 * copy of #13346 run against each picked host on its own. Every host gets its
 * own preview, ticket and outcome, so one being offline, older or changed since
 * its preview refuses that host alone, and each keeps the undo its own page
 * offers. The review leads with one line per host; a retry previews and copies
 * only the hosts that didn't finish, keeping the ones that did.
 */
export function HostsCopySettingsSection({ hosts, onOpenHost }: HostsCopySettingsSectionProps) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("choose");
  const [pickedHosts, setPickedHosts] = useState<Set<HostId>>(new Set());
  const [categories, setCategories] = useState(defaultSelection);
  const [copies, setCopies] = useState<Record<string, HostCopy>>({});
  // The hosts taking part, fixed when the preview starts, and how many the copy sent to.
  const [runHosts, setRunHosts] = useState<HostId[]>([]);
  const [sentCount, setSentCount] = useState(0);
  const [expanded, setExpanded] = useState<Set<HostId>>(new Set());
  // Answers to a run that was cancelled or replaced are dropped, never shown.
  const generation = useRef(0);
  const groupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reopenFocus = useRef(false);
  // The results a retry started from, so cancelling it goes back to them.
  const resumeAt = useRef<Record<string, HostCopy> | null>(null);
  const detailIdBase = useId();

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  // Opening moves focus into the hosts it opened onto, closing back to the opener.
  useEffect(() => {
    if (open) {
      groupRef.current
        ?.querySelector<HTMLElement>('button[role="checkbox"]:not([disabled])')
        ?.focus({ preventScroll: true });
    } else if (reopenFocus.current) {
      reopenFocus.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  // The step that replaced the pressed button takes focus, so a keyboard user
  // isn't left on the page body: the run's Cancel while it previews, the
  // results' next action once it finishes. Chromium rings it only after a key.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = stage === "result" ? "result" : stage === "choose" ? "choose" : "run";
    groupRef.current
      ?.querySelector<HTMLElement>(`[data-copy-focus="${target}"]`)
      ?.focus({ preventScroll: true });
  }, [open, stage]);

  const busy = stage === "previewing" || stage === "applying";
  const thisMac = deviceOwnerPhrase();
  const connectedHosts = hosts.filter((host) => host.connected);
  const offlineCount = hosts.length - connectedHosts.length;
  const targets = connectedHosts.filter((host) => pickedHosts.has(host.id));
  const run = runHosts.flatMap((id) => hosts.find((host) => host.id === id) ?? []);
  const chosenCategories = PORTABLE_SETTINGS_CATEGORIES.filter((c) => categories.has(c.id));
  // One host-named line per host that finishes a step, for screen readers; the
  // rows say the same thing visually.
  const [announcement, setAnnouncement] = useState("");
  const setCopy = (hostId: HostId, copy: HostCopy) => {
    setCopies((prev) => ({ ...prev, [hostId]: copy }));
    const name = hosts.find((host) => host.id === hostId)?.name ?? hostId;
    const outcome = outcomeOf(copy);
    if (copy.kind === "preview") setAnnouncement(`${name}: preview ready`);
    else if (outcome) setAnnouncement(`${name}: ${outcome.label}`);
  };

  const reset = () => {
    generation.current += 1;
    setStage("choose");
    setCopies({});
    setRunHosts([]);
    setExpanded(new Set());
  };

  const close = () => {
    reset();
    reopenFocus.current = true;
    setOpen(false);
  };

  const toggleHost = (id: HostId, on: boolean) => {
    if (busy) return;
    setPickedHosts((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleCategory = (id: PortableSettingsCategoryId, on: boolean) => {
    if (busy) return;
    setCategories((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /** Preview `ids`, leaving every other host's state as it is. */
  const runPreview = (ids: readonly HostId[]) => {
    const ticket = ++generation.current;
    const chosen = PORTABLE_SETTINGS_CATEGORIES.filter((c) => categories.has(c.id)).map(
      (c) => c.id
    );
    setStage("previewing");
    setCopies((prev) => ({
      ...prev,
      ...Object.fromEntries(ids.map((id): [HostId, HostCopy] => [id, { kind: "waiting" }])),
    }));
    const queue = new PQueue({ concurrency: HOST_CONCURRENCY });
    const runs = ids.map((id) => {
      const host = hosts.find((h) => h.id === id);
      if (!host?.connected) {
        setCopy(id, {
          kind: "problem",
          problem: "offline",
          message: `${host?.name ?? id} is offline`,
        });
        return Promise.resolve();
      }
      return queue.add(async () => {
        // Cancelled or replaced while it waited: nothing would show its answer.
        if (generation.current !== ticket) return;
        setCopy(id, { kind: "previewing" });
        await window.electron.settingsCopy.preview({ hostId: id, categories: chosen }).then(
          (result) => {
            if (generation.current === ticket) setCopy(id, { kind: "preview", preview: result });
          },
          (err: unknown) => {
            if (generation.current === ticket) {
              setCopy(id, problemFor(err, host.name, `Couldn't preview the copy on ${host.name}`));
            }
          }
        );
      });
    });
    void Promise.all(runs).then(() => {
      if (generation.current === ticket) setStage("preview");
    });
  };

  const preview = () => {
    if (busy || targets.length === 0 || categories.size === 0) return;
    const ids = targets.map((host) => host.id);
    resumeAt.current = null;
    setCopies({});
    setRunHosts(ids);
    setExpanded(new Set());
    runPreview(ids);
  };

  const cancelPreview = () => {
    // A preview writes nothing, so stopping it only drops the answers still to come.
    const resume = resumeAt.current;
    resumeAt.current = null;
    if (!resume) {
      reset();
      return;
    }
    generation.current += 1;
    setCopies(resume);
    setStage("result");
  };

  const applicable = run.filter((host) => {
    const copy = copies[host.id];
    return copy?.kind === "preview" && changeTotal(copy.preview) > 0;
  });

  const apply = () => {
    if (stage !== "preview" || applicable.length === 0) return;
    const ticket = ++generation.current;
    resumeAt.current = null;
    setStage("applying");
    setExpanded(new Set());
    setSentCount(applicable.length);
    // Every host here was confirmed, so a queued copy still runs if the page
    // closes meanwhile; only its answer is dropped.
    const queue = new PQueue({ concurrency: HOST_CONCURRENCY });
    const runs = run.map((host) => {
      const copy = copies[host.id];
      if (copy?.kind !== "preview") return Promise.resolve();
      if (changeTotal(copy.preview) === 0) {
        const kind = classifyPreview(categoryPreviews(copy.preview, chosenCategories));
        const noop = kind === "changes" ? "same" : kind;
        setCopy(host.id, { kind: "done", preview: copy.preview, report: SKIPPED_REPORT, noop });
        return Promise.resolve();
      }
      const shown = copy.preview;
      setCopy(host.id, { kind: "queued", preview: shown });
      return queue.add(() => {
        if (generation.current === ticket) setCopy(host.id, { kind: "applying", preview: shown });
        return window.electron.settingsCopy.apply({ hostId: host.id, ticket: shown.ticket }).then(
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
        );
      });
    });
    void Promise.all(runs).then(() => {
      if (generation.current === ticket) setStage("result");
    });
  };

  const outcomes = run.map((host) => ({
    host,
    outcome: copies[host.id] ? outcomeOf(copies[host.id]!) : null,
  }));
  const toRetry = outcomes.filter(({ host, outcome }) => outcome?.retry && host.connected);

  const retry = () => {
    if (busy || toRetry.length === 0) return;
    resumeAt.current = copies;
    setExpanded(new Set());
    runPreview(toRetry.map(({ host }) => host.id));
  };

  if (hosts.length < 2) return null;

  const allCategories = PORTABLE_SETTINGS_CATEGORIES.every((c) => categories.has(c.id));
  const allConnectedPicked =
    connectedHosts.length > 0 && connectedHosts.every((h) => pickedHosts.has(h.id));

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

  const toggleDetail = (id: HostId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const hostRow = (host: CopyTargetHost, index: number) => {
    const copy = copies[host.id];
    const progress = progressOf(copy);
    const outcome = copy ? outcomeOf(copy) : null;
    const reviewing =
      copy?.kind === "preview" ? previewSummary(copy.preview, chosenCategories) : null;
    const detailId = `${detailIdBase}-${index}`;
    const showDetail = reviewing !== null && reviewing.items.some((item) => !isQuiet(item));
    const isOpen = showDetail && expanded.has(host.id);
    return (
      <div key={host.id}>
        <SettingsRow
          label={host.name}
          layout={showDetail && reviewing.tooOld > 0 ? "stacked" : "inline"}
          {...(progress !== null || reviewing !== null || outcome === null
            ? { description: progress ?? reviewing?.text }
            : outcomeProps(outcome))}
          control={
            showDetail ? (
              <SettingsRowActions>
                <DisclosureButton
                  expanded={isOpen}
                  controls={detailId}
                  label={`${isOpen ? "Hide" : "Show"} changes on ${host.name}`}
                  onToggle={() => toggleDetail(host.id)}
                >
                  Changes
                </DisclosureButton>
                {reviewing.tooOld > 0 && (
                  <UpdateDaintreeButton hostId={host.id} hostName={host.name} />
                )}
              </SettingsRowActions>
            ) : undefined
          }
        />
        {isOpen && reviewing && (
          <div id={detailId}>
            <SettingsDependents>
              {reviewing.items
                .filter((item) => !isQuiet(item))
                .map((item) => (
                  <CategoryPreviewRows key={item.category.id} item={item} hostName={host.name} />
                ))}
              <QuietCategoryRows items={reviewing.items} hostName={host.name} />
            </SettingsDependents>
          </div>
        )}
      </div>
    );
  };

  const settled = outcomes.filter(({ outcome }) => outcome !== null);
  const okCount = outcomes.filter(({ outcome }) => outcome?.ok).length;
  const copiedCount = outcomes.filter(({ outcome }) => outcome?.severity === "success").length;
  const sameHosts = outcomes.filter(({ outcome }) => outcome?.label === "Already the same");
  const emptyCount = outcomes.filter(({ outcome }) => outcome?.label === "Nothing to copy").length;
  const attention = run.length - okCount;
  const doneEarlier = run.filter((host) => copies[host.id]?.kind === "done").length;
  const previewed = run.filter((host) => {
    const kind = copies[host.id]?.kind;
    return kind !== "waiting" && kind !== "previewing";
  }).length;
  const willChange = applicable.length;
  const kindCount = (wanted: "same" | "empty" | "blocked") =>
    run.filter((host) => {
      const copy = copies[host.id];
      return (
        copy?.kind === "preview" &&
        classifyPreview(categoryPreviews(copy.preview, chosenCategories)) === wanted
      );
    }).length;
  const sameCount = kindCount("same");
  const emptyPreviewCount = kindCount("empty");
  const blockedCount = kindCount("blocked");
  const problemCount = run.filter((host) => copies[host.id]?.kind === "problem").length;
  const pendingCount = run.filter((host) => {
    const kind = copies[host.id]?.kind;
    return kind === "queued" || kind === "applying";
  }).length;

  const progressStatus =
    stage === "previewing"
      ? `Previewing on ${pluralize(run.length, "host")}: ${previewed} of ${run.length} done…`
      : stage === "applying"
        ? `Copying to ${pluralize(sentCount, "host")}: ${sentCount - pendingCount} of ${sentCount} done…`
        : willChange === 0
          ? "Nothing to copy to these hosts"
          : [
              `${willChange} of ${pluralize(run.length, "host")} will change`,
              sameCount > 0 ? `${sameCount} already the same` : null,
              emptyPreviewCount > 0 ? `${emptyPreviewCount} with nothing to copy` : null,
              blockedCount > 0 ? `${blockedCount} that can take none of it` : null,
              doneEarlier > 0 ? `${doneEarlier} done earlier` : null,
              problemCount > 0 ? `${problemCount} can't take part` : null,
            ]
              .filter(Boolean)
              .join(", ");

  return (
    <SettingsSection
      id="hosts-copy-settings"
      title="Copy settings to several hosts"
      description={`Copy ${thisMac}'s settings to more than one host at once, with a preview and an outcome for each`}
      action={
        open ? undefined : (
          <Button
            ref={triggerRef}
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
        <div className="space-y-4" ref={groupRef}>
          {stage === "choose" ? (
            <>
              <SettingsGroup label="Hosts">
                <SettingsCheckbox
                  id="hosts-copy-all-hosts"
                  label="All connected hosts"
                  description={`${targets.length} of ${pluralize(connectedHosts.length, "connected host")} chosen${offlineCount > 0 ? `. ${offlineCount} offline` : ""}`}
                  checked={allConnectedPicked ? true : targets.length > 0 ? "indeterminate" : false}
                  onChange={(on) =>
                    setPickedHosts(on ? new Set(connectedHosts.map((h) => h.id)) : new Set())
                  }
                  disabled={connectedHosts.length === 0}
                />
                {hosts.map((host) => (
                  <SettingsCheckbox
                    key={host.id}
                    id={`hosts-copy-host-${host.id}`}
                    label={host.name}
                    description={host.connected ? "Connected" : "Offline. Connect to it first"}
                    checked={host.connected && pickedHosts.has(host.id)}
                    onChange={(on) => toggleHost(host.id, on)}
                    disabled={!host.connected}
                  />
                ))}
              </SettingsGroup>

              <SettingsGroup label="What to copy">
                <SettingsCheckbox
                  id="hosts-copy-all"
                  label="Select all"
                  description={`${pluralize(categories.size, "category", "categories")} of ${PORTABLE_SETTINGS_CATEGORIES.length} chosen`}
                  checked={allCategories ? true : categories.size > 0 ? "indeterminate" : false}
                  onChange={(on) =>
                    setCategories(
                      on ? new Set(PORTABLE_SETTINGS_CATEGORIES.map((c) => c.id)) : new Set()
                    )
                  }
                />
                {HOST_CATEGORIES.map(categoryRow)}
              </SettingsGroup>

              <SettingsGroup label="For using these hosts directly">
                {DEVICE_CATEGORIES.map(categoryRow)}
                <SettingsActions
                  status={
                    targets.length === 0
                      ? "Choose at least one connected host"
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
                    data-copy-focus="choose"
                  >
                    {`Preview on ${pluralize(targets.length, "host")}`}
                  </Button>
                </SettingsActions>
              </SettingsGroup>
            </>
          ) : (
            <SettingsGroup label="What to copy">
              <SettingsRow
                label={`${pluralize(chosenCategories.length, "category", "categories")} to ${pluralize(run.length, "host")}`}
                description={
                  <>
                    <span className="block">Hosts: {listPhrase(run.map((host) => host.name))}</span>
                    <span className="block">
                      Categories: {listPhrase(chosenCategories.map((c) => c.label))}
                    </span>
                  </>
                }
                control={
                  stage === "result" ? undefined : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={reset}
                      disabled={stage === "applying"}
                    >
                      Change
                    </Button>
                  )
                }
              />
            </SettingsGroup>
          )}

          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>

          {(stage === "previewing" || stage === "preview" || stage === "applying") && (
            <SettingsGroup label={stage === "applying" ? "Copying" : "Preview"}>
              {run.map(hostRow)}
              <SettingsActions status={progressStatus}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={cancelPreview}
                  disabled={stage === "applying"}
                  data-copy-focus="run"
                >
                  Cancel
                </Button>
                {stage === "previewing" ? (
                  <Button variant="contrast" size="sm" loading>
                    {`Preview on ${pluralize(run.length, "host")}`}
                  </Button>
                ) : (
                  <Button
                    variant="contrast"
                    size="sm"
                    onClick={apply}
                    disabled={stage === "preview" && willChange === 0}
                    loading={stage === "applying"}
                  >
                    {`Copy to ${pluralize(stage === "applying" ? sentCount : willChange, "host")}`}
                  </Button>
                )}
              </SettingsActions>
            </SettingsGroup>
          )}

          {stage === "result" && (
            <>
              {attention === 0 ? (
                <Callout
                  severity="success"
                  role="status"
                  title={
                    copiedCount > 0
                      ? `Copied to ${pluralize(copiedCount, "host")}`
                      : "Nothing needed copying"
                  }
                >
                  {sameHosts.length > 0
                    ? `${listPhrase(sameHosts.map(({ host }) => host.name))} already had these settings`
                    : undefined}
                </Callout>
              ) : (
                <Callout
                  severity={okCount > 0 ? "warning" : "error"}
                  role="alert"
                  title={`${attention} of ${pluralize(run.length, "host")} didn't copy`}
                >
                  {[
                    copiedCount > 0 ? `${copiedCount} copied` : null,
                    sameHosts.length > 0 ? `${sameHosts.length} already had these settings` : null,
                    emptyCount > 0 ? `${emptyCount} had nothing to copy` : null,
                  ]
                    .filter(Boolean)
                    .join(", ")
                    .replace(/^./, (c) => c.toUpperCase())}
                  {okCount > 0 ? ". " : ""}
                  {toRetry.length > 0
                    ? "Retry previews and copies only the hosts that didn't, or open one to look at it"
                    : "Open a host to see what it needs"}
                </Callout>
              )}
              <SettingsGroup label="Results">
                {[...settled]
                  .sort((a, b) => a.outcome!.rank - b.outcome!.rank)
                  .map(({ host, outcome }, index) => {
                    const copy = copies[host.id];
                    const applied = copy?.kind === "done" && copy.report.outcome === "applied";
                    const allReports = applied
                      ? categoryReports(copy.report, copy.preview, chosenCategories)
                      : [];
                    const reports = allReports.filter(needsReport);
                    // Categories the report doesn't mention because the host didn't know them.
                    const reported = new Set(allReports.map((item) => item.category.id));
                    const unsupported = applied
                      ? categoryPreviews(
                          copy.preview,
                          chosenCategories.filter((category) => !reported.has(category.id))
                        ).filter((item) => item.unknown.length > 0)
                      : [];
                    const hasDetail = reports.length + unsupported.length > 0;
                    const detailId = `${detailIdBase}-result-${index}`;
                    const isOpen = hasDetail && expanded.has(host.id);
                    const openButton = (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Open ${host.name}`}
                        onClick={() => onOpenHost(host.id)}
                      >
                        Open
                      </Button>
                    );
                    return (
                      <div key={host.id}>
                        <SettingsRow
                          label={host.name}
                          layout={hasDetail ? "stacked" : "inline"}
                          {...outcomeProps(outcome!)}
                          control={
                            hasDetail ? (
                              <SettingsRowActions>
                                <DisclosureButton
                                  expanded={isOpen}
                                  controls={detailId}
                                  label={`${isOpen ? "Hide" : "Show"} what didn't copy on ${host.name}`}
                                  onToggle={() => toggleDetail(host.id)}
                                >
                                  Details
                                </DisclosureButton>
                                {openButton}
                              </SettingsRowActions>
                            ) : (
                              openButton
                            )
                          }
                        />
                        {isOpen && (
                          <div id={detailId}>
                            <SettingsDependents>
                              {reports.map((item) => (
                                <CategoryReportRows
                                  key={item.category.id}
                                  item={item}
                                  hostName={host.name}
                                />
                              ))}
                              <UncopiedCategoryRows items={unsupported} hostName={host.name} />
                            </SettingsDependents>
                          </div>
                        )}
                      </div>
                    );
                  })}
                <SettingsActions status="Undo is on each host's page">
                  <Button
                    variant={toRetry.length > 0 ? "outline" : "contrast"}
                    size="sm"
                    onClick={close}
                    data-copy-focus={toRetry.length > 0 ? undefined : "result"}
                  >
                    Done
                  </Button>
                  {toRetry.length > 0 && (
                    <Button variant="contrast" size="sm" onClick={retry} data-copy-focus="result">
                      {`Retry ${pluralize(toRetry.length, "host")}`}
                    </Button>
                  )}
                </SettingsActions>
              </SettingsGroup>
            </>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

const SKIPPED_REPORT: ConfigImportReport = {
  outcome: "applied",
  rolledBack: false,
  errors: [],
  sections: [],
};
