import { PORTABLE_SETTINGS_CATEGORIES } from "@shared/config/portableSettings";
import type { ConfigBundlePreviewChange } from "@shared/types/configBundle";
import type { SettingsCopyPreview } from "@shared/types/ipc/settingsCopy";

export const HOST_CATEGORIES = PORTABLE_SETTINGS_CATEGORIES.filter((category) => !category.device);
export const DEVICE_CATEGORIES = PORTABLE_SETTINGS_CATEGORIES.filter((category) => category.device);

/** "Replaced · On → Off", "Added · 4 hours", plus anything to know first. */
export function describeChange(change: ConfigBundlePreviewChange): string {
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

export function changeTotal(preview: SettingsCopyPreview): number {
  return preview.sections.reduce((sum, section) => sum + section.add + section.update, 0);
}
