import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
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
import {
  DEFAULT_QUESTION_EXPIRY_MS,
  QUESTION_EXPIRY_CHOICES,
} from "@shared/config/decisionsQuestionExpiry";
import { questionExpiryLabel, questionExpiryText } from "./policyCopy";
import type { UseDecisionsPolicyResult } from "./useDecisionsPolicy";

const NEVER = "never";

/** A default expiry as a select value: null ("never") needs a string of its own. */
function expiryValue(ms: number | null): string {
  return ms === null ? NEVER : String(ms);
}

const EXPIRY_OPTIONS = QUESTION_EXPIRY_CHOICES.map((ms) => ({
  value: expiryValue(ms),
  label: questionExpiryLabel(ms),
}));

/**
 * Questions: how long one waits when its agent sets no expiry (#16122), as
 * the library applies the saved choice, and the answers that couldn't be
 * typed in on their own (#16020). The description follows what main has
 * saved, not a choice still being saved.
 */
export function DecisionsQuestionsSection({ policy: read }: { policy: UseDecisionsPolicyResult }) {
  const { policy, loadError, reload, pendingExpiry, expirySaveFailure, setDefaultQuestionExpiry } =
    read;
  const shownExpiry = pendingExpiry ?? (policy ? { ms: policy.defaultQuestionExpiryMs } : null);
  const attention = useDecisionsAttentionCount();
  const openAttention = useDecisionsAttentionStore((state) => state.open);
  const noneToReview = attention.state === "counted" && attention.count === 0;
  return (
    <SettingsSection title="Questions" id="decisions-questions">
      <SettingsGroup>
        <SettingsSelect
          id="decisions-questions-expiry"
          label="Default expiry"
          description={
            policy === null
              ? "An expired question authorises nothing, and the agent is told so"
              : questionExpiryText(policy)
          }
          value={shownExpiry === null ? "" : expiryValue(shownExpiry.ms)}
          placeholder="Loading…"
          onValueChange={(value) =>
            void setDefaultQuestionExpiry(value === NEVER ? null : Number(value))
          }
          options={EXPIRY_OPTIONS}
          disabled={policy === null || pendingExpiry !== null}
          isModified={
            policy !== null && policy.defaultQuestionExpiryMs !== DEFAULT_QUESTION_EXPIRY_MS
          }
          onReset={() => void setDefaultQuestionExpiry(DEFAULT_QUESTION_EXPIRY_MS)}
          resetAriaLabel="Reset default expiry"
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
      {expirySaveFailure && (
        <SettingsLoadErrorBanner
          title="Couldn't change the default expiry"
          message={expirySaveFailure.message}
          onRetry={() => void setDefaultQuestionExpiry(expirySaveFailure.ms)}
        />
      )}
    </SettingsSection>
  );
}
