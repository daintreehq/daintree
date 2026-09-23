import { Badge } from "@/components/ui/badge";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsGroup, SettingsRow, useSettingsGroup } from "./SettingsGroup";

interface SettingsSwitchCardProps {
  id?: string;
  title: string;
  subtitle?: string;
  isEnabled: boolean;
  onChange: () => void;
  /** Only when the spoken name must differ from `title`; otherwise the title names the switch. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Why the switch is disabled, shown under its description while it is. */
  disabledReason?: string;
  colorScheme?: "accent" | "amber" | "danger";
  /**
   * `card` is a row in a group — standalone, it brings its own one-row group. `compact`
   * is a bare row for a switch living inside some other surface.
   */
  variant?: "card" | "compact";
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  lifecycleBadge?: string;
  scope?: "default" | "global" | "project";
}

const SCOPE_LABEL = { project: "Project", global: "Global", default: "Default" } as const;

/**
 * A boolean setting: title and description leading, the switch on the row's right rail.
 *
 * An off setting is still an available setting: it keeps full title contrast, and only
 * the switch position says which way it is set. The genuinely disabled case owns the
 * dimmed treatment.
 */
export function SettingsSwitchCard({
  id,
  title,
  subtitle,
  isEnabled,
  onChange,
  ariaLabel,
  disabled,
  disabledReason,
  colorScheme = "accent",
  variant = "card",
  isModified,
  onReset,
  resetAriaLabel,
  lifecycleBadge,
  scope,
}: SettingsSwitchCardProps) {
  const group = useSettingsGroup();

  const accessory =
    scope || lifecycleBadge ? (
      <>
        {scope && <Badge size="xs">{SCOPE_LABEL[scope]}</Badge>}
        {lifecycleBadge && <Badge size="xs">{lifecycleBadge}</Badge>}
      </>
    ) : undefined;

  const row = (
    <SettingsRow
      id={id}
      label={title}
      description={subtitle}
      accessory={accessory}
      isModified={isModified}
      onReset={onReset}
      resetAriaLabel={resetAriaLabel ?? `Reset ${title} to default`}
      disabled={disabled}
      disabledReason={disabledReason}
      onRowClick={onChange}
      className={variant === "compact" ? "pl-0 pr-0 py-2" : undefined}
      control={({ labelId, descriptionId, disabled: rowDisabled }) => (
        <SettingsSwitch
          checked={isEnabled}
          onCheckedChange={onChange}
          disabled={rowDisabled}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : labelId}
          aria-describedby={descriptionId}
          colorScheme={colorScheme}
        />
      )}
    />
  );

  if (group || variant === "compact") return row;
  return <SettingsGroup>{row}</SettingsGroup>;
}
