import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { gateDescription, proxyAllowlistText } from "./policyCopy";
import type { UseDecisionsPolicyResult } from "./useDecisionsPolicy";

/**
 * Policy: who may answer (#16013). The workflow gates are Daintree's and only
 * shown here; the one thing to change is whether a question without a
 * registered gate may take a proxy answer, off unless the person turns it on.
 */
export function DecisionsPolicySection({ policy: read }: { policy: UseDecisionsPolicyResult }) {
  const { policy, loadError, pending, saveFailure, reload, setProxyAllowlisted } = read;
  const allowed = pending ?? policy?.proxyAllowlisted ?? false;
  const locked = policy === null || pending !== null;

  return (
    <SettingsSection
      title="Policy"
      id="decisions-policy"
      description="Daintree sets the workflow gates. An agent can name one, but can't change it or ask for less."
    >
      {policy === null && loadError !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't read who may answer"
          message={loadError}
          onRetry={() => void reload()}
        />
      )}
      {policy !== null && policy.gates.length > 0 && (
        <SettingsGroup label="Workflow gates" id="decisions-policy-gates">
          {policy.gates.map((gate) => (
            <SettingsRow
              key={gate.id}
              id={`decisions-gate-${gate.id.replace(/[^A-Za-z0-9_-]/g, "-")}`}
              label={<span className="font-mono">{gate.id}</span>}
              labelText={gate.id}
              description={gateDescription(gate)}
            />
          ))}
        </SettingsGroup>
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          id="decisions-proxy-allowlist"
          title="Allow proxy answers"
          subtitle={proxyAllowlistText(policy?.gates ?? [])}
          isEnabled={allowed}
          onChange={() => void setProxyAllowlisted(!allowed)}
          disabled={locked}
          isModified={policy?.proxyAllowlisted === true}
          onReset={() => void setProxyAllowlisted(false)}
        />
      </SettingsGroup>
      {saveFailure && (
        <SettingsLoadErrorBanner
          title={
            saveFailure.allowed ? "Couldn't allow proxy answers" : "Couldn't stop proxy answers"
          }
          message={saveFailure.message}
          onRetry={() => void setProxyAllowlisted(saveFailure.allowed)}
        />
      )}
    </SettingsSection>
  );
}
