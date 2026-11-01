import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";

/**
 * Policy: who may answer. With no trusted workflow gate registered and no
 * proxy allowed, every question needs the person's own answer, which is what
 * this says until the gate list and the proxy allowlist land (#16013).
 */
export function DecisionsPolicySection() {
  return (
    <SettingsSection title="Policy" id="decisions-policy">
      <SettingsGroup>
        <SettingsRow
          id="decisions-policy-answers"
          label="Who answers"
          description="You do. Every question waits for your own answer, and nothing answers on your behalf."
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
