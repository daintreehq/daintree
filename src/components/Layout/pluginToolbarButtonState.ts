import type { PluginToolbarButtonRuntimeState } from "@shared/types/plugin";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import {
  DEFAULT_PLUGIN_BUTTON_ICON,
  resolvePluginIcon,
  type PluginIconComponent,
} from "@/components/icons/pluginIconRegistry";

export interface PluginToolbarButtonPresentation {
  Icon: PluginIconComponent;
  /** Tooltip text: the disabled reason, else the plugin's tooltip, else the label. */
  tooltip: string;
  /** Set only when the plugin made the button a toggle. */
  pressed: boolean | undefined;
  busy: boolean;
  disabled: boolean;
  /** Clicks do nothing: the button is busy or disabled. */
  blocked: boolean;
}

/**
 * How one plugin toolbar button draws under its live state (#13785). The label
 * is never part of this: a toggle keeps one name and announces `pressed`, and a
 * replacement icon that doesn't resolve falls back to the manifest's.
 */
export function presentPluginToolbarButton(
  config: Pick<ToolbarButtonConfig, "iconId" | "label">,
  state: PluginToolbarButtonRuntimeState | null
): PluginToolbarButtonPresentation {
  const ManifestIcon = resolvePluginIcon(config.iconId, DEFAULT_PLUGIN_BUTTON_ICON);
  const Icon = state?.iconId ? resolvePluginIcon(state.iconId, ManifestIcon) : ManifestIcon;
  const busy = state?.busy === true;
  const disabled = state?.disabled === true;
  return {
    Icon,
    tooltip: (disabled ? state?.disabledReason : undefined) ?? state?.tooltip ?? config.label,
    pressed: state?.pressed,
    busy,
    disabled,
    blocked: busy || disabled,
  };
}
