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

/** Names shown per line before the rest collapse into "and N more". */
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

/** "3 added, 1 replaced" — the actual operations, not a bare total. */
function describeSection(section: ConfigBundlePreviewSection): string {
  const parts: string[] = [];
  if (section.add > 0) parts.push(`${section.add} added`);
  if (section.update > 0) parts.push(`${section.update} replaced`);
  return parts.join(", ");
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more". */
function listNames(names: string[], max = MAX_NAMED): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** A scalar shows the value it moves between; everything else is just its name. */
function nameChange(change: ConfigBundlePreviewChange): string {
  if (change.kind === "update" && change.from !== undefined && change.to !== undefined) {
    return `${change.label} (${change.from} → ${change.to})`;
  }
  if (change.kind === "add" && change.to !== undefined) return `${change.label} (${change.to})`;
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
  const more = reasons.length > 1 ? `, plus ${reasons.length - 1} more` : "";
  return `Configuration imported with ${reasons.length} skipped — ${reasons[0]}${more}${tail}`;
}

interface ApplyFailure {
  description: string;
  /** The raw error, when the description had to translate it. */
  detail?: string;
}

function SectionRow({ section }: { section: ConfigBundlePreviewSection }) {
  const replaced = section.changes.filter((c) => c.kind === "update").map(nameChange);
  const added = section.changes.filter((c) => c.kind === "add").map(nameChange);
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm text-text-primary">
          {CONFIG_BUNDLE_SECTION_LABELS[section.section]}
        </span>
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          {describeSection(section)}
        </span>
      </div>
      {replaced.length > 0 && (
        <p className="mt-0.5 text-xs text-text-secondary">Replaces {listNames(replaced)}</p>
      )}
      {added.length > 0 && (
        <p className="mt-0.5 text-xs text-text-secondary">Adds {listNames(added)}</p>
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
      const omitted = result.omittedSecretPaths.length;
      setExportNote({
        failed: false,
        text:
          omitted > 0
            ? `Current values saved to '${name}', without ${countLabel(omitted, "value that looked like a secret", "values that looked like secrets")}`
            : `Current values saved to '${name}'`,
      });
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
        description:
          "Daintree couldn't confirm what was written. Check the settings listed below before trying again.",
        detail: formatErrorMessage(error, ""),
      });
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
        description: report.errors[0] ?? "The bundle couldn't be applied. Nothing was changed.",
      });
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

    notify({
      type: skippedReasons(report, preview).length > 0 ? "warning" : "success",
      priority: "high",
      transient: true,
      context: { eventKind: "settings" },
      message: outcomeMessage(report, preview),
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
          ? "Adds or replaces each setting below with the value in this file. Everything else stays as it is."
          : "Adds each setting below from this file. Everything else stays as it is."
      }
      confirmLabel={applyFailure ? "Try again" : "Import configuration"}
      variant="destructive"
      isConfirmLoading={isApplying}
      onConfirm={handleConfirm}
      hint={
        isApplying
          ? "Importing configuration…"
          : applyFailure
            ? "Import stopped — details above"
            : undefined
      }
      hasPreview
    >
      {applyFailure && (
        <InlineStatusBanner
          severity="error"
          title="Import stopped"
          description={applyFailure.description}
          {...(applyFailure.detail ? { contextLine: applyFailure.detail } : {})}
          className="rounded-[var(--radius-md)]"
        />
      )}
      <ul className="divide-y divide-border-subtle">
        {changed.map((section) => (
          <SectionRow key={section.section} section={section} />
        ))}
      </ul>
      {unknown.length > 0 && (
        <p className="text-xs text-text-secondary">
          Left out, because this version of Daintree doesn&apos;t support{" "}
          {unknown.length === 1 ? "it" : "them"}: {listNames(unknown, 4)}
        </p>
      )}
      {replacesAny && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2">
          <p
            className={
              exportNote?.failed ? "text-xs text-status-error" : "text-xs text-text-secondary"
            }
            role="status"
          >
            {exportNote?.text ?? "Daintree doesn't keep a copy of the values this replaces"}
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
    </ConfirmDialog>
  );
}
