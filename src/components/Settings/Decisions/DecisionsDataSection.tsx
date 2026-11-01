import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { DecisionsDisclosure } from "./DecisionsDisclosure";

/**
 * Data: what's sent and where, the same list the consent dialog showed.
 * Export and deleting relay or local data join it (#16025).
 */
export function DecisionsDataSection() {
  return (
    <SettingsSection title="Data" id="decisions-data">
      <SettingsGroup>
        <SettingsRow
          id="decisions-data-sent"
          layout="stacked"
          label="What's sent, and where"
          description={<DecisionsDisclosure className="mt-2" />}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
