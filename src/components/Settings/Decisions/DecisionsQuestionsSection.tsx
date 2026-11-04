import { useState } from "react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
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
import { useDecisionsTerminalSnapshots } from "./useDecisionsTerminalSnapshots";
import { DecisionsTerminalSnapshotsConsentDialog } from "./DecisionsTerminalSnapshotsConsentDialog";

const NEVER = "never";

/** A default expiry as a select value: null ("never") needs a string of its own. */
function expiryValue(ms: number | null): string {
  return ms === null ? NEVER : String(ms);
}

const EXPIRY_OPTIONS = QUESTION_EXPIRY_CHOICES.map((ms) => ({
  value: expiryValue(ms),
  label: questionExpiryLabel(ms),
}));

interface DecisionsQuestionsSectionProps {
  policy: UseDecisionsPolicyResult;
  status: DecisionsStatus;
  /** The Decisions switch is changing, so nothing behind it is. */
  locked: boolean;
  /** A status main answered a change with, or null to read it again. */
  onChanged: (next: DecisionsStatus | null) => void;
}

/**
 * Questions: how long one waits when its agent sets no expiry (#16122), as
 * the library applies the saved choice, whether the phone may show the pane
 * that asked one (#16228), and the answers that couldn't be typed in on
 * their own (#16020). The description follows what main has saved, not a
 * choice still being saved. Snapshots ask before every turn on.
 */
export function DecisionsQuestionsSection({
  policy: read,
  status,
  locked,
  onChanged,
}: DecisionsQuestionsSectionProps) {
  const { policy, loadError, reload, pendingExpiry, expirySaveFailure, setDefaultQuestionExpiry } =
    read;
  const snapshots = useDecisionsTerminalSnapshots(status, onChanged);
  const [snapshotsConsentOpen, setSnapshotsConsentOpen] = useState(false);
  const snapshotsLocked = locked || snapshots.saving;
  const snapshotsFailure = snapshots.failure;
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
        <SettingsSwitchCard
          id="decisions-terminal-snapshots"
          title="Show agent status and recent terminal lines on my phone"
          subtitle="For the pane that asked, only while its question is open, redacted on a best-effort basis"
          isEnabled={snapshots.enabled}
          onChange={() => {
            if (snapshotsLocked) return;
            if (snapshots.enabled) snapshots.set({ enabled: false });
            else setSnapshotsConsentOpen(true);
          }}
          disabled={snapshotsLocked}
          isModified={status.terminalSnapshots === true}
          onReset={() => snapshots.set({ enabled: false })}
          resetAriaLabel="Turn off terminal snapshots"
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
      {snapshotsFailure && (
        <SettingsLoadErrorBanner
          title={
            snapshotsFailure.payload.enabled
              ? "Couldn't turn on terminal snapshots"
              : "Couldn't turn off terminal snapshots"
          }
          message={snapshotsFailure.message}
          onRetry={() => snapshots.set(snapshotsFailure.payload)}
        />
      )}
      {expirySaveFailure && (
        <SettingsLoadErrorBanner
          title="Couldn't change the default expiry"
          message={expirySaveFailure.message}
          onRetry={() => void setDefaultQuestionExpiry(expirySaveFailure.ms)}
        />
      )}
      <DecisionsTerminalSnapshotsConsentDialog
        isOpen={snapshotsConsentOpen}
        onCancel={() => setSnapshotsConsentOpen(false)}
        onAccept={() => {
          setSnapshotsConsentOpen(false);
          snapshots.set({ enabled: true, consent: true });
        }}
      />
    </SettingsSection>
  );
}
