import { usePreferencesStore, type DockDensity } from "@/store/preferencesStore";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { SettingsRow } from "./SettingsGroup";

const DEFAULT_DOCK_DENSITY: DockDensity = "normal";

const DOCK_DENSITY_OPTIONS: SegmentedRadioOption<DockDensity>[] = [
  { value: "compact", label: "Compact" },
  { value: "normal", label: "Normal" },
  { value: "comfortable", label: "Comfortable" },
];

/**
 * Three short exclusive options, so a segmented control on the row's rail. The old card
 * per option carried a description each ("Default dock size") that the row description
 * now says once.
 */
export function DockDensityPicker() {
  const dockDensity = usePreferencesStore((s) => s.dockDensity);
  const setDockDensity = usePreferencesStore((s) => s.setDockDensity);

  return (
    <SettingsRow
      id="appearance-dock-density"
      label="Dock density"
      description="Height and spacing of items in the dock — normal is the default"
      isModified={dockDensity !== DEFAULT_DOCK_DENSITY}
      onReset={() => setDockDensity(DEFAULT_DOCK_DENSITY)}
      control={({ disabled }) => (
        <SegmentedRadioGroup
          aria-label="Dock density"
          options={DOCK_DENSITY_OPTIONS}
          value={dockDensity}
          onChange={setDockDensity}
          disabled={disabled}
        />
      )}
    />
  );
}
