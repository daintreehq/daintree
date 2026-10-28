import { Badge } from "@/components/ui/badge";
import { useSettingsOwnerMarker, type SettingRef } from "@/hooks/useSettingsOwner";

/**
 * Where one row's value lives, for a row whose owner differs from the section
 * around it. Nothing until owners are shown, so a page with no hosts is unchanged.
 */
export function SettingsOwnerTag({ settings }: { settings: readonly SettingRef[] }) {
  const ownerMarker = useSettingsOwnerMarker();
  const marker = ownerMarker(...settings);
  if (!marker) return null;
  return (
    <Badge size="xs" data-settings-owner-tag="">
      {marker}
    </Badge>
  );
}
