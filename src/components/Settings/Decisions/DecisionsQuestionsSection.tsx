import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { questionExpiryText } from "./policyCopy";
import type { UseDecisionsPolicyResult } from "./useDecisionsPolicy";

/**
 * Questions: how long one waits, as the client library sets it (#16013), and
 * later the answers that couldn't be delivered (#16020). The wait isn't a
 * setting yet: the library gives Daintree no way to change it, so this says
 * what it is rather than offering a choice it couldn't honour.
 */
export function DecisionsQuestionsSection({ policy: read }: { policy: UseDecisionsPolicyResult }) {
  const { policy, loadError, reload } = read;
  return (
    <SettingsSection title="Questions" id="decisions-questions">
      <SettingsGroup>
        <SettingsRow
          id="decisions-questions-expiry"
          label="Expiry"
          description={
            policy === null
              ? "An expired question authorises nothing, and the agent is told so"
              : questionExpiryText(policy)
          }
        />
      </SettingsGroup>
      {policy === null && loadError !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't read how long questions wait"
          message={loadError}
          onRetry={() => void reload()}
        />
      )}
    </SettingsSection>
  );
}
