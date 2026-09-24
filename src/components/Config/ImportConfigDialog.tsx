import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  CONFIG_BUNDLE_SECTION_LABELS,
  type ConfigBundlePreview,
  type ConfigBundlePreviewChange,
  type ConfigBundlePreviewSection,
  type ConfigImportReport,
} from "@shared/types/configBundle";
import { refreshImportedConfig } from "@/services/configBundleRefresh";
import { IMPORT_CONFIG_EVENT } from "./importConfigEvent";

/** Groups this dialog's notifications so a repeat import replaces the last report. */
const IMPORT_CONFIG_ACTION_ID = "app.importConfig";

/** Added names shown before the rest fold behind "and N more". */
const MAX_NAMED = 3;

/**
 * Re-enter the flow from a toast action by firing the same event the menu item
 * fires, rather than reaching back into the component — one entry point, and no
 * self-reference from inside the callback that defines it.
 */
function retryImport(): void {
  window.dispatchEvent(new CustomEvent(IMPORT_CONFIG_EVENT));
}

function changeCount(section: ConfigBundlePreviewSection): number {
  return section.add + section.update;
}

/** "1 replaced, 3 added" — the actual operations, in the order the row lists them. */
function describeSection(section: ConfigBundlePreviewSection): string {
  const parts: string[] = [];
  if (section.update > 0) parts.push(`${section.update} replaced`);
  if (section.add > 0) parts.push(`${section.add} added`);
  return parts.join(", ");
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * A scalar shows the value it moves between, a renamed entry the name it takes,
 * and everything else just its name.
 */
function nameChange(change: ConfigBundlePreviewChange): string {
  if (change.kind === "update" && change.from !== undefined && change.to !== undefined) {
    return `${change.label} (${change.from} → ${change.to})`;
  }
  if (change.kind === "add" && change.to !== undefined) return `${change.label} (${change.to})`;
  if (change.renamedTo) return `${change.label} (becomes ${change.renamedTo})`;
  return change.label;
}

function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Appended to an outcome toast, so sections the import dropped aren't lost from its record. */
function unsupportedNote(unknownSections: string[]): string {
  if (unknownSections.length === 0) return "";
  return `. ${countLabel(unknownSections.length, "unsupported section was", "unsupported sections were")} left out`;
}

/**
 * The skipped leaves, named the way the confirmation named them — a leaf's key
 * is a store identifier, and the preview already resolved it to a label.
 */
function skippedReasons(report: ConfigImportReport, preview: ConfigBundlePreview): string[] {
  const reasons: string[] = [];
  for (const section of report.sections) {
    const labels = new Map(
      preview.sections
        .find((s) => s.section === section.section)
        ?.changes.map((c) => [c.key, c.label] as const) ?? []
    );
    for (const leaf of section.leaves) {
      if (leaf.status !== "skipped" || !leaf.reason) continue;
      const name = labels.get(leaf.key) ?? leaf.key;
      const where = CONFIG_BUNDLE_SECTION_LABELS[section.section].toLowerCase();
      reasons.push(`${name} (${where}): ${leaf.reason}`);
    }
  }
  return reasons;
}

function outcomeMessage(report: ConfigImportReport, preview: ConfigBundlePreview): string {
  const applied = report.sections.reduce((sum, section) => sum + section.applied, 0);
  const reasons = skippedReasons(report, preview);
  const tail = unsupportedNote(preview.unknownSections);
  if (reasons.length === 0) {
    return `Configuration imported — ${countLabel(applied, "setting", "settings")} changed${tail}`;
  }
  const more = reasons.length > 1 ? `, plus ${reasons.length - 1} more in the inbox` : "";
  return `Configuration imported with ${countLabel(reasons.length, "setting", "settings")} skipped. ${reasons[0]}${more}${tail}`;
}

interface ApplyFailure {
  description: string;
  /**
   * What was written is unknown — the apply threw, or its rollback failed.
   * A backup taken now would capture the damage, not the pre-import values.
   */
  uncertain: boolean;
  /** The raw error, when the description had to translate it. */
  detail?: string;
}

/** Section rows whose only setting is the section itself, named by its value alone. */
const VALUE_ONLY_SECTIONS = new Set<ConfigBundlePreviewSection["section"]>(["worktreeConfig"]);

const ROW = "py-2 first:pt-0 last:pb-0";
const DETAIL = "mt-0.5 text-xs text-text-secondary";

function SectionRow({ section }: { section: ConfigBundlePreviewSection }) {
  const [showAllAdded, setShowAllAdded] = useState(false);
  const replaced = section.changes.filter((c) => c.kind === "update");
  const added = section.changes.filter((c) => c.kind === "add").map(nameChange);
  const hiddenAdded = showAllAdded ? 0 : Math.max(0, added.length - MAX_NAMED);
  const shownAdded = hiddenAdded > 0 ? added.slice(0, MAX_NAMED) : added;
  const valueOnly = VALUE_ONLY_SECTIONS.has(section.section);

  return (
    <li className={ROW}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm text-text-primary">
          {CONFIG_BUNDLE_SECTION_LABELS[section.section]}
        </span>
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          {describeSection(section)}
        </span>
      </div>
      {/* Replacements are what the import takes away, so they are never
          collapsed — only additions fold behind "and N more". */}
      {replaced.length > 0 &&
        (valueOnly ? (
          replaced.map((change) => (
            <p key={change.key} className={DETAIL}>
              Replaces <code className="font-mono break-all">{change.from ?? change.label}</code>{" "}
              with <code className="font-mono break-all">{change.to ?? "the bundle's value"}</code>
            </p>
          ))
        ) : (
          <p className={DETAIL}>Replaces {joinNames(replaced.map(nameChange))}</p>
        ))}
      {added.length > 0 && (
        <p className={DETAIL}>
          Adds {hiddenAdded > 0 ? `${shownAdded.join(", ")} and ` : joinNames(shownAdded)}
          {/* One stable disclosure that relabels rather than unmounting, so a
              keyboard user keeps their place after expanding. */}
          {added.length > MAX_NAMED && (
            <>
              {hiddenAdded === 0 && " "}
              <button
                type="button"
                aria-expanded={showAllAdded}
                className="rounded-[var(--radius-sm)] text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                onClick={() => setShowAllAdded((open) => !open)}
              >
                {showAllAdded ? "show fewer" : `${hiddenAdded} more`}
              </button>
            </>
          )}
        </p>
      )}
    </li>
  );
}

/**
 * Confirmation surface for the `"app.importConfig"` action (#11889).
 *
 * Import overwrites configuration that nothing else can recover — no git, no
 * reflog — which puts it at destructive tier D1: a confirmation naming every
 * operation, plus a pre-import snapshot (held in the main process for the
 * duration of the apply, see `ConfigBundleService`).
 *
 * The action itself only fires {@link IMPORT_CONFIG_EVENT}; this component owns
 * the whole flow so the confirmation, the apply, and the report stay together.
 */
export function ImportConfigDialog() {
  const [preview, setPreview] = useState<ConfigBundlePreview | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [applyFailure, setApplyFailure] = useState<ApplyFailure | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ text: string; failed: boolean } | null>(null);
  /** Bumped per failure so the body scrolls back to the banner that explains it. */
  const [failureCount, setFailureCount] = useState(0);
  const backupRef = useRef<HTMLDivElement>(null);
  /**
   * Synchronous single-flight gate. `isApplying` is state and settles a render
   * later, so two activations in the same tick would both pass a state check —
   * opening two native pickers, or applying the same bundle twice.
   */
  const inFlight = useRef(false);

  const close = useCallback(() => {
    setPreview(null);
    setApplyFailure(null);
    setExportNote(null);
  }, []);

  const beginImport = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      let result: ConfigBundlePreview;
      try {
        result = await window.electron.configBundle.previewImport();
      } catch (error) {
        logError("[importConfig] Failed to read configuration bundle", error);
        notify({
          type: "error",
          priority: "high",
          message:
            `Import failed — couldn't read that file. ${formatErrorMessage(error, "")}`.trim(),
          supersedeKey: IMPORT_CONFIG_ACTION_ID,
          context: { eventKind: "settings" },
          action: { label: "Try again", onClick: () => retryImport() },
        });
        return;
      }

      if (result.outcome === "canceled") return;

      if (result.outcome === "rejected") {
        notify({
          type: "error",
          priority: "high",
          message: `Import failed — ${result.errors[0] ?? "that file isn't a Daintree configuration bundle"}`,
          supersedeKey: IMPORT_CONFIG_ACTION_ID,
          context: { eventKind: "settings" },
          // Picking a different file is the recovery, so reopen the picker.
          action: { label: "Choose another file", onClick: () => retryImport() },
        });
        return;
      }

      const changes = result.sections.reduce((sum, section) => sum + changeCount(section), 0);
      if (changes === 0) {
        // Nothing to overwrite means nothing destructive to confirm — importing
        // the same bundle twice lands here, which is what makes it idempotent.
        notify({
          type: "info",
          priority: "high",
          transient: true,
          message: `Configuration already matches that bundle — nothing to import${unsupportedNote(result.unknownSections)}`,
          supersedeKey: IMPORT_CONFIG_ACTION_ID,
          context: { eventKind: "settings" },
        });
        return;
      }

      setApplyFailure(null);
      setExportNote(null);
      setPreview(result);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const handler = () => {
      void beginImport();
    };
    window.addEventListener(IMPORT_CONFIG_EVENT, handler);
    return () => window.removeEventListener(IMPORT_CONFIG_EVENT, handler);
  }, [beginImport]);

  // An import applied in any window has to reach this one too — each project
  // view holds its own theme and notification stores, and `app.reloadConfig`
  // reconciles neither.
  useEffect(() => {
    return window.electron.configBundle.onImported(() => {
      void refreshImportedConfig();
    });
  }, []);

  /**
   * The one recovery the confirmation can offer for an import with no undo:
   * write the current values out first. It never gates the import.
   */
  const handleExport = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsExporting(true);
    try {
      const result = await window.electron.configBundle.export();
      if (result.outcome === "canceled" || !result.filePath) return;
      const name = result.filePath.split(/[\\/]/).pop() ?? result.filePath;
      // The Export button unmounts on success; hand its focus to Cancel rather
      // than let it fall to the document once the native save dialog returns.
      const cancel = backupRef.current
        ?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
        ?.querySelector<HTMLElement>('[data-confirm-role="cancel"]');
      const omitted = result.omittedSecretPaths.length;
      setExportNote({
        failed: false,
        text:
          omitted > 0
            ? `Current values saved to '${name}', without ${countLabel(omitted, "value that looked like a secret", "values that looked like secrets")}`
            : `Current values saved to '${name}'`,
      });
      requestAnimationFrame(() => cancel?.focus());
    } catch (error) {
      logError("[importConfig] Failed to export current configuration", error);
      setExportNote({
        failed: true,
        text: `Couldn't save the current values — ${formatErrorMessage(error, "the file wasn't written")}`,
      });
    } finally {
      inFlight.current = false;
      setIsExporting(false);
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!preview?.bundleJson || inFlight.current) return;
    inFlight.current = true;
    setIsApplying(true);
    setApplyFailure(null);
    let report: ConfigImportReport;
    try {
      report = await window.electron.configBundle.applyImport({
        bundleJson: preview.bundleJson,
      });
    } catch (error) {
      logError("[importConfig] Failed to apply configuration bundle", error);
      // A throw means the apply never reported back, so what was written is
      // unknown — say that rather than guess in either direction.
      setApplyFailure({
        uncertain: true,
        description:
          "Daintree couldn't confirm what was written, so some of these may already have changed. Check them in Settings before trying again.",
        detail: formatErrorMessage(error, ""),
      });
      setFailureCount((n) => n + 1);
      inFlight.current = false;
      setIsApplying(false);
      return;
    }

    inFlight.current = false;
    setIsApplying(false);

    if (report.outcome === "rolled-back") {
      // Kept open rather than dismissed: the dialog is the only surface that
      // still holds what the user was importing, so closing it would take the
      // retry away along with the explanation.
      setApplyFailure({
        uncertain: report.restoreFailed === true,
        description: report.errors[0] ?? "The bundle couldn't be applied. Nothing was changed.",
      });
      setFailureCount((n) => n + 1);
      return;
    }

    close();

    // Main has written; this view's own mirrors still hold the old values.
    // Other views are covered by the main-process broadcast. A failure here is
    // a stale window, not a failed import — retrying the apply would be wrong.
    try {
      await refreshImportedConfig();
    } catch (error) {
      logError("[importConfig] Imported, but refreshing this window failed", error);
      notify({
        type: "warning",
        priority: "high",
        context: { eventKind: "settings" },
        message: "Configuration imported, but this window is still showing the previous settings",
        supersedeKey: IMPORT_CONFIG_ACTION_ID,
        action: { label: "Refresh settings", onClick: () => void refreshImportedConfig() },
      });
      return;
    }

    const reasons = skippedReasons(report, preview);
    notify({
      type: reasons.length > 0 ? "warning" : "success",
      priority: "high",
      // A clean import needs no record. Skips do: the toast names one, and the
      // inbox keeps every one of them.
      transient: reasons.length === 0,
      context: { eventKind: "settings" },
      message: outcomeMessage(report, preview),
      ...(reasons.length > 1
        ? {
            inboxMessage: `Configuration imported with ${reasons.length} skipped. ${reasons.join(". ")}`,
          }
        : {}),
      supersedeKey: IMPORT_CONFIG_ACTION_ID,
    });
  }, [preview, close]);

  if (!preview) return null;

  const changed = preview.sections.filter((section) => changeCount(section) > 0);
  const replacesAny = changed.some((section) => section.update > 0);
  const unknown = preview.unknownSections;

  return (
    <ConfirmDialog
      isOpen
      onClose={close}
      title={
        preview.fileName
          ? `Import configuration from '${preview.fileName}'?`
          : "Import configuration?"
      }
      description={
        replacesAny
          ? "Adds or replaces each setting below with the value in this file. Everything else stays as it is, and Daintree keeps no copy of what's replaced."
          : "Adds each setting below from this file. Everything else stays as it is."
      }
      confirmLabel={applyFailure ? "Try again" : "Import configuration"}
      variant="destructive"
      isConfirmLoading={isApplying}
      onConfirm={handleConfirm}
      bodyResetKey={failureCount}
      hasPreview
    >
      {applyFailure && (
        <InlineStatusBanner
          severity="error"
          title="Import stopped"
          description={applyFailure.description}
          {...(applyFailure.detail
            ? { contextLine: applyFailure.detail, contextLineTruncate: "middle" as const }
            : {})}
          className="rounded-[var(--radius-md)]"
        />
      )}
      {/* Ahead of the list, not after it: the way back has to be seen before
          the confirm, and a busy preview scrolls past anything below it. */}
      {/* Once what was written is unknown, exporting would capture the damage
          rather than a way back — keep a backup already taken, offer no new one. */}
      {replacesAny && (!applyFailure?.uncertain || (exportNote && !exportNote.failed)) && (
        <div
          ref={backupRef}
          className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2"
        >
          <p
            className={
              exportNote?.failed ? "text-xs text-status-error" : "text-xs text-text-secondary"
            }
            role="status"
          >
            {exportNote?.text ?? "Save the current values before importing"}
          </p>
          {(!exportNote || exportNote.failed) && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              loading={isExporting}
              disabled={isApplying}
              onClick={() => void handleExport()}
            >
              Export a backup…
            </Button>
          )}
        </div>
      )}
      <ul className="divide-y divide-border-subtle">
        {changed.map((section) => (
          <SectionRow key={section.section} section={section} />
        ))}
        {unknown.length > 0 && (
          <li className={ROW}>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-text-primary">Not supported by this version</span>
              <span className="shrink-0 text-xs text-text-secondary">left out</span>
            </div>
            <p className={DETAIL}>
              {unknown.map((key, i) => (
                <span key={key}>
                  {i > 0 && (i === unknown.length - 1 ? " and " : ", ")}
                  <code className="font-mono">{key}</code>
                </span>
              ))}
            </p>
          </li>
        )}
      </ul>
    </ConfirmDialog>
  );
}
