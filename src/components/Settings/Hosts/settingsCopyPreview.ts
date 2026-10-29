import {
  PORTABLE_SETTINGS_CATEGORIES,
  type PortableSettingsCategory,
} from "@shared/config/portableSettings";
import type {
  ConfigBundlePreviewChange,
  ConfigBundlePreviewSkip,
  ConfigBundleSectionId,
  ConfigImportLeafResult,
  ConfigImportReport,
} from "@shared/types/configBundle";
import type { SettingsCopyPreview } from "@shared/types/ipc/settingsCopy";
import { pluralize } from "@/lib/pluralize";

export const HOST_CATEGORIES = PORTABLE_SETTINGS_CATEGORIES.filter((category) => !category.device);
export const DEVICE_CATEGORIES = PORTABLE_SETTINGS_CATEGORIES.filter((category) => category.device);

export function changeTotal(preview: SettingsCopyPreview): number {
  return preview.sections.reduce((sum, section) => sum + section.add + section.update, 0);
}

/** One category of a preview, split the way the review reads it. */
export interface CategoryPreview {
  category: PortableSettingsCategory;
  /** Replacements first, then additions, keyed `section:key`. */
  changes: Array<ConfigBundlePreviewChange & { id: string }>;
  skipped: Array<ConfigBundlePreviewSkip & { id: string }>;
  /** Names that stayed on this machine because they look like secrets. */
  withheld: string[];
  /** Sections of this category the host's Daintree doesn't know. */
  unknown: ConfigBundleSectionId[];
  unchanged: number;
}

export function categoryPreviews(
  preview: SettingsCopyPreview,
  categories: readonly PortableSettingsCategory[]
): CategoryPreview[] {
  return categories.map((category) => {
    const sections = preview.sections.filter((section) =>
      category.sections.includes(section.section)
    );
    const changes = sections.flatMap((section) =>
      section.changes.map((change) => ({ ...change, id: `${section.section}:${change.key}` }))
    );
    return {
      category,
      changes: [
        ...changes.filter((change) => change.kind === "update"),
        ...changes.filter((change) => change.kind === "add"),
      ],
      skipped: sections.flatMap((section) =>
        (section.skipped ?? []).map((skip) => ({ ...skip, id: `${section.section}:${skip.key}` }))
      ),
      withheld: preview.withheld
        .filter((item) => category.sections.includes(item.section))
        .map((item) => item.name),
      unknown: category.sections.filter((id) => preview.unknownSections.includes(id)),
      unchanged: sections.reduce((sum, section) => sum + section.unchanged, 0),
    };
  });
}

/** A category with nothing to show but "already the same" or "nothing to copy". */
export function isQuiet(item: CategoryPreview): boolean {
  return (
    item.changes.length === 0 &&
    item.skipped.length === 0 &&
    item.withheld.length === 0 &&
    item.unknown.length === 0
  );
}

export interface PreviewTotals {
  update: number;
  add: number;
  /** Leaves the host refused plus names withheld as secrets: never copied. */
  notCopied: number;
  /** Categories the host is too old for, in whole or in part. */
  tooOld: number;
}

export function previewTotals(items: readonly CategoryPreview[]): PreviewTotals {
  return items.reduce<PreviewTotals>(
    (totals, item) => ({
      update: totals.update + item.changes.filter((c) => c.kind === "update").length,
      add: totals.add + item.changes.filter((c) => c.kind === "add").length,
      notCopied: totals.notCopied + item.skipped.length + item.withheld.length,
      tooOld: totals.tooOld + (item.unknown.length > 0 ? 1 : 0),
    }),
    { update: 0, add: 0, notCopied: 0, tooOld: 0 }
  );
}

/**
 * What a preview amounts to, for every place that has to say it in a word:
 * something to copy, everything already the same, nothing set here to copy,
 * or nothing the host can take. Sameness is only claimed when unchanged
 * settings back it up.
 */
export type PreviewKind = "changes" | "same" | "empty" | "blocked";

export function classifyPreview(items: readonly CategoryPreview[]): PreviewKind {
  const totals = previewTotals(items);
  if (totals.update + totals.add > 0) return "changes";
  if (totals.notCopied + totals.tooOld > 0) return "blocked";
  return items.some((item) => item.unchanged > 0) ? "same" : "empty";
}

/** "2 overwrites, 1 new" — what a copy would do, in the words the review badges use. */
export function changePhrase(update: number, add: number): string {
  return [update > 0 ? pluralize(update, "overwrite") : null, add > 0 ? `${add} new` : null]
    .filter((part): part is string => part !== null)
    .join(", ");
}

export interface ReportTotals {
  applied: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export function reportTotals(report: ConfigImportReport): ReportTotals {
  return report.sections.reduce<ReportTotals>(
    (totals, section) => ({
      applied: totals.applied + section.applied,
      unchanged: totals.unchanged + section.unchanged,
      skipped: totals.skipped + section.skipped,
      failed: totals.failed + section.failed,
    }),
    { applied: 0, unchanged: 0, skipped: 0, failed: 0 }
  );
}

/**
 * One category of a copy's report: its counts, the leaves that didn't copy, and
 * what its preview already said wouldn't travel (sections the host doesn't know,
 * names kept here as secrets), so a reported category can't hide those.
 */
export interface CategoryReport {
  category: PortableSettingsCategory;
  totals: ReportTotals;
  failed: Array<ConfigImportLeafResult & { id: string; label: string }>;
  skipped: Array<ConfigImportLeafResult & { id: string; label: string }>;
  unknown: ConfigBundleSectionId[];
  withheld: string[];
}

export function categoryReports(
  report: ConfigImportReport,
  preview: SettingsCopyPreview,
  categories: readonly PortableSettingsCategory[]
): CategoryReport[] {
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
  return categories.flatMap((category) => {
    const sections = report.sections.filter(
      (section) => section.present && category.sections.includes(section.section)
    );
    if (sections.length === 0) return [];
    const leaves = (status: "failed" | "skipped") =>
      sections.flatMap((section) =>
        section.leaves
          .filter((leaf) => leaf.status === status)
          .map((leaf) => {
            const id = `${section.section}:${leaf.key}`;
            return { ...leaf, id, label: labels.get(id) ?? leaf.key };
          })
      );
    return [
      {
        category,
        totals: reportTotals({ ...report, sections }),
        failed: leaves("failed"),
        skipped: leaves("skipped"),
        unknown: category.sections.filter((id) => preview.unknownSections.includes(id)),
        withheld: preview.withheld
          .filter((item) => category.sections.includes(item.section))
          .map((item) => item.name),
      },
    ];
  });
}

/** "Agent settings, Global recipes and Idle terminals", the way Settings' own descriptions list things. */
export function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
