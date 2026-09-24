import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { actionService } from "@/services/ActionService";

export function ImportExportSettingsTab() {
  return (
    <div className="space-y-8">
      <SettingsSection
        title="Configuration file"
        description="Back up your setup or move it to another machine"
        id="import-export-config"
      >
        <SettingsGroup>
          <SettingsRow
            id="import-export-config-export"
            label="Export configuration"
            description="Save custom agents, agent settings, keyboard shortcuts, theme, notification preferences, the worktree path pattern, and global recipes to a JSON file. Values that look like secrets are left out."
            control={({ descriptionId, disabled }) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-describedby={descriptionId}
                disabled={disabled}
                onClick={() =>
                  void actionService.dispatch("app.exportConfig", undefined, { source: "user" })
                }
              >
                Export…
              </Button>
            )}
          />
          <SettingsRow
            id="import-export-config-import"
            label="Import configuration"
            description="Replace matching settings with the values in an exported file. You'll see what changes before anything is written."
            control={({ descriptionId, disabled }) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-describedby={descriptionId}
                disabled={disabled}
                onClick={() =>
                  void actionService.dispatch("app.importConfig", undefined, { source: "user" })
                }
              >
                Import…
              </Button>
            )}
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
