import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  CONFIG_BUNDLE_SECTION_LABELS,
  type ConfigBundlePreview,
  type ConfigBundlePreviewSection,
  type ConfigImportReport,
} from "@shared/types/configBundle";
import { refreshImportedConfig } from "@/services/configBundleRefresh";
import { IMPORT_CONFIG_EVENT } from "./importConfigEvent";

/** Groups this dialog's notifications so a repeat import replaces the last report. */
const IMPORT_CONFIG_ACTION_ID = "app.importConfig";

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

function summarizeReport(report: ConfigImportReport): string {
  const totals = report.sections.reduce(
    (acc, section) => ({
      applied: acc.applied + section.applied,
      unchanged: acc.unchanged + section.unchanged,
      skipped: acc.skipped + section.skipped,
    }),
    { applied: 0, unchanged: 0, skipped: 0 }
  );

  const parts = [`${totals.applied} applied`];
  if (totals.unchanged > 0) parts.push(`${totals.unchanged} already matched`);
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
  return parts.join(", ");
}

/** The first few reasons, so a skip is explained rather than just counted. */
function skippedReasons(report: ConfigImportReport): string[] {
  const reasons: string[] = [];
  for (const section of report.sections) {
    for (const leaf of section.leaves) {
      if (leaf.status !== "skipped" || !leaf.reason) continue;
      reasons.push(
        `${CONFIG_BUNDLE_SECTION_LABELS[section.section]} — ${leaf.key}: ${leaf.reason}`
      );
    }
  }
  return reasons;
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

  const close = useCallback(() => setPreview(null), []);

  const beginImport = useCallback(async () => {
    let result: ConfigBundlePreview;
    try {
      result = await window.electron.configBundle.previewImport();
    } catch (error) {
      logError("[importConfig] Failed to read configuration bundle", error);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        priority: "high",
        message: `Import failed — couldn't read that file. ${formatErrorMessage(error, "")}`.trim(),
        supersedeKey: IMPORT_CONFIG_ACTION_ID,
      });
      return;
    }

    if (result.outcome === "canceled") return;

    if (result.outcome === "rejected") {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        priority: "high",
        message: `Import failed — ${result.errors[0] ?? "that file isn't a Daintree configuration bundle"}`,
        supersedeKey: IMPORT_CONFIG_ACTION_ID,
      });
      return;
    }

    const changes = result.sections.reduce((sum, section) => sum + changeCount(section), 0);
    if (changes === 0) {
      // Nothing to overwrite means nothing destructive to confirm — importing
      // the same bundle twice lands here, which is what makes it idempotent.
      notify({
        type: "info",
        priority: "low",
        message: "Configuration already matches that bundle — nothing to import",
        supersedeKey: IMPORT_CONFIG_ACTION_ID,
      });
      return;
    }

    setPreview(result);
  }, []);

  useEffect(() => {
    const handler = () => {
      void beginImport();
    };
    window.addEventListener(IMPORT_CONFIG_EVENT, handler);
    return () => window.removeEventListener(IMPORT_CONFIG_EVENT, handler);
  }, [beginImport]);

  const handleConfirm = useCallback(async () => {
    if (!preview?.bundleJson) return;
    setIsApplying(true);
    try {
      const report = await window.electron.configBundle.applyImport({
        bundleJson: preview.bundleJson,
      });

      if (report.outcome === "rolled-back") {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          priority: "high",
          message: `Import failed — ${report.errors[0] ?? "the bundle couldn't be applied"}`,
          supersedeKey: IMPORT_CONFIG_ACTION_ID,
        });
        return;
      }

      // Main has written; the renderer's own mirrors still hold the old values.
      await refreshImportedConfig();

      const reasons = skippedReasons(report);
      notify({
        type: reasons.length > 0 ? "warning" : "success",
        priority: "high",
        message:
          reasons.length > 0
            ? `Configuration imported — ${summarizeReport(report)}. ${reasons[0]}`
            : `Configuration imported — ${summarizeReport(report)}`,
        supersedeKey: IMPORT_CONFIG_ACTION_ID,
      });
    } catch (error) {
      logError("[importConfig] Failed to apply configuration bundle", error);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        priority: "high",
        message: `Import failed — ${formatErrorMessage(error, "the bundle couldn't be applied")}`,
        supersedeKey: IMPORT_CONFIG_ACTION_ID,
      });
    } finally {
      setIsApplying(false);
      close();
    }
  }, [preview, close]);

  if (!preview) return null;

  const changed = preview.sections.filter((section) => changeCount(section) > 0);

  return (
    <ConfirmDialog
      isOpen
      onClose={close}
      title={
        preview.fileName
          ? `Import configuration from '${preview.fileName}'?`
          : "Import configuration?"
      }
      description="These settings will be replaced with the values in the bundle. Anything not listed here is left alone, and this can't be undone."
      confirmLabel="Import configuration"
      variant="destructive"
      isConfirmLoading={isApplying}
      onConfirm={handleConfirm}
      hasPreview
    >
      <ul className="flex flex-col gap-1 text-sm">
        {changed.map((section) => (
          <li key={section.section} className="flex items-baseline justify-between gap-4">
            <span className="text-text-primary">
              {CONFIG_BUNDLE_SECTION_LABELS[section.section]}
            </span>
            <span className="text-text-secondary tabular-nums">{describeSection(section)}</span>
          </li>
        ))}
      </ul>
      {preview.unknownSections.length > 0 && (
        <p className="mt-2 text-xs text-text-secondary">
          {preview.unknownSections.length === 1
            ? "1 section in this bundle isn't supported by this version and will be ignored"
            : `${preview.unknownSections.length} sections in this bundle aren't supported by this version and will be ignored`}
        </p>
      )}
    </ConfirmDialog>
  );
}
