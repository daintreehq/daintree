import { usePreferencesStore, type DockDensity } from "@/store/preferencesStore";
import { SettingsChoicebox, type ChoiceboxOption } from "./SettingsChoicebox";

const DOCK_DENSITY_OPTIONS: readonly ChoiceboxOption<DockDensity>[] = [
  { value: "compact", label: "Compact", description: "Smaller items, tighter spacing" },
  { value: "normal", label: "Normal", description: "Default dock size" },
  { value: "comfortable", label: "Comfortable", description: "Larger items, more spacing" },
] as const;

export function DockDensityPicker() {
  const dockDensity = usePreferencesStore((s) => s.dockDensity);
  const setDockDensity = usePreferencesStore((s) => s.setDockDensity);

  return (
    <SettingsChoicebox
      value={dockDensity}
      onChange={setDockDensity}
      options={DOCK_DENSITY_OPTIONS}
      className="flex-1"
    />
  );
}
