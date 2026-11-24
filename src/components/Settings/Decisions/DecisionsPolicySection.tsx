import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { UNGATED_QUESTION_TEXT, gateDescription } from "./policyCopy";
import type { UseDecisionsPolicyResult } from "./useDecisionsPolicy";

/**
 * Policy: who may answer (#16013). The workflow gates are Daintree's and only
 * shown here. Whether a question without one may take a proxy answer follows
 * the decision model's one choice to answer automatically (#18062), so this
 * section says where that is rather than offering a second switch for it.
 */
export function DecisionsPolicySection({ policy: read }: { policy: UseDecisionsPolicyResult }) {
  const { policy, loadError, reload } = read;

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
        <SettingsRow
          id="decisions-policy-ungated"
          label="Questions without a gate"
          description={UNGATED_QUESTION_TEXT}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
