import { SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { usePluginTerminalLinkPreferencesStore } from "@/store/pluginTerminalLinkPreferencesStore";

const LABEL = "Open matching terminal text with this plugin";
const DESCRIPTION =
  "A click hands the plugin only the text it matched. A URL it claims still opens in the external browser from the right-click menu.";

function usePluginTerminalLinksSwitch(pluginId: string) {
  const enabled = usePluginTerminalLinkPreferencesStore((s) => s.disabled[pluginId] !== true);
  const setEnabled = usePluginTerminalLinkPreferencesStore((s) => s.setEnabled);
  return { enabled, setEnabled: (next: boolean) => setEnabled(pluginId, next) };
}

/**
 * The switch for a plugin's terminal link matchers (#13798). The choice is
 * this machine's, applies in every terminal at once, and holds while the
 * plugin is stopped, so it is shown whenever the manifest declares matchers.
 * Keyed by instance id: a project plugin may share a manifest name with an
 * installed one, and each gets its own switch.
 */
export function PluginTerminalLinksSection({ pluginId }: { pluginId: string }) {
  const { enabled, setEnabled } = usePluginTerminalLinksSwitch(pluginId);
  const switchId = `plugin-terminal-links-${pluginId}`;
  const descriptionId = `${switchId}-description`;

  return (
    <div className="space-y-2">
      <h4 className={SECTION_LABEL_CLASS}>Terminal links</h4>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={switchId} className="block text-xs text-text-primary">
            {LABEL}
          </label>
          <div id={descriptionId} className="text-2xs text-text-secondary">
            {DESCRIPTION}
          </div>
        </div>
        <SettingsSwitch
          id={switchId}
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-describedby={descriptionId}
          data-testid="plugin-terminal-links-switch"
        />
      </div>
    </div>
  );
}

/** The same switch as a settings row, for a project plugin's pane in Project settings. */
export function PluginTerminalLinksRow({ pluginId }: { pluginId: string }) {
  const { enabled, setEnabled } = usePluginTerminalLinksSwitch(pluginId);
  return (
    <SettingsRow
      label={LABEL}
      description={DESCRIPTION}
      control={({ descriptionId, disabled }) => (
        <SettingsSwitch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={setEnabled}
          aria-label={LABEL}
          aria-describedby={descriptionId}
          data-testid="plugin-terminal-links-switch"
        />
      )}
    />
  );
}
