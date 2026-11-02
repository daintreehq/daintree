import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { Button } from "@/components/ui/button";
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { pluralize } from "@/lib/pluralize";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import {
  useDecisionsAttentionCount,
  type DecisionsAttentionCount,
} from "./useDecisionsAttentionCount";

function attentionDescription(attention: DecisionsAttentionCount): string {
  switch (attention.state) {
    case "counted":
      return attention.count === 0
        ? "None right now. Answers Daintree won't type in on its own are listed here"
        : `${pluralize(attention.count, "answer")} Daintree won't type in on its own`;
    case "failed":
      return "Couldn't count them just now. Review opens the list";
    case "not-running":
      return "Decisions isn't delivering answers right now, so none can be read";
    case "loading":
      return "Answers Daintree won't type in on its own are listed here";
  }
}
import { questionExpiryText } from "./policyCopy";
import type { UseDecisionsPolicyResult } from "./useDecisionsPolicy";

/**
 * Questions: how long one waits, as the client library sets it (#16013), and
 * the answers that couldn't be typed in on their own (#16020). The wait isn't
 * a setting yet: the library gives Daintree no way to change it, so this says
 * what it is rather than offering a choice it couldn't honour.
 */
export function DecisionsQuestionsSection({ policy: read }: { policy: UseDecisionsPolicyResult }) {
  const { policy, loadError, reload } = read;
  const attention = useDecisionsAttentionCount();
  const openAttention = useDecisionsAttentionStore((state) => state.open);
  const noneToReview = attention.state === "counted" && attention.count === 0;
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
        <SettingsRow
          id="decisions-questions-attention"
          label="Answers needing attention"
          description={attentionDescription(attention)}
          control={
            <Button
              variant="outline"
              size="sm"
              // Nothing to review only once a read said so; unknown still opens the list.
              // Unavailable rather than disabled, so a list emptied from here can
              // still hand focus back to it.
              aria-disabled={noneToReview || undefined}
              className={noneToReview ? ARIA_DISABLED_CLASSES : undefined}
              onClick={() => {
                if (!noneToReview) openAttention();
              }}
              data-testid="decisions-attention-review"
            >
              Review
            </Button>
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
