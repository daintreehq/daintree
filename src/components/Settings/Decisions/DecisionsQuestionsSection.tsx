import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { questionWaitText } from "./policyCopy";
import { useDecisionsPolicy } from "./useDecisionsPolicy";

/**
 * Questions: how long one waits, as the client library sets it (#16013), and
 * later the answers that couldn't be delivered (#16020). The wait isn't a
 * setting yet: the library gives Daintree no way to change it, so this says
 * what it is rather than offering a choice it couldn't honour. Hidden until
 * main has said.
 */
export function DecisionsQuestionsSection() {
  const { policy } = useDecisionsPolicy();
  if (policy === null) return null;
  return (
    <SettingsSection title="Questions" id="decisions-questions">
      <SettingsGroup>
        <SettingsRow
          id="decisions-questions-expiry"
          label="Expiry"
          description={`A question waits ${questionWaitText(policy.defaultQuestionExpiryMs)} for your answer, unless the agent that asked sets another time. An expired question authorises nothing, and the agent is told so.`}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
