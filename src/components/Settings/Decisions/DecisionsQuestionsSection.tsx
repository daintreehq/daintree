import { useState } from "react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowActions,
} from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import { Button } from "@/components/ui/button";
import { decisionsObservations } from "@/components/Layout/decisionsToolbarSignal";
import {
  useDecisionsStoppedCount,
  useDecisionsWaitingCount,
} from "@/hooks/useDecisionsWaitingCount";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { offersUnlisted, useUnlistedStoppedAnswers } from "./useUnlistedStoppedAnswers";

const INBOX_TEXT =
  "Every question your agents asked on this computer: what waits on you, what's being delivered, and what was decided";

/**
 * The inbox row's description: what the toolbar's button observes, the
 * questions waiting and the deliveries stopped (#18048), ahead of what the
 * inbox holds. Nothing is counted until the list is read.
 */
export function inboxDescription(waiting: number, stopped: number): string {
  const observed = decisionsObservations(waiting, stopped);
  return observed.length === 0 ? INBOX_TEXT : `${observed.join(", ")}. ${INBOX_TEXT}.`;
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
  /** Closes Settings first, so the inbox and the terminal it leads to aren't behind it. */
  onClose?: SettingsTabClose;
}

/**
 * Questions: how long one waits when its agent sets no expiry (#16122), as
 * the library applies the saved choice, whether the phone may show the pane
 * that asked one (#16228), and the inbox of every question (#17231), which
 * also holds the answers that couldn't be typed in on their own (#18048). The
 * description follows what main has saved, not a choice still being saved.
 * Snapshots ask before every turn on. The phone and desktop notification settings are
 * Notifications' (#18061).
 */
export function DecisionsQuestionsSection({
  policy: read,
  status,
  locked,
  onChanged,
  onClose,
}: DecisionsQuestionsSectionProps) {
  const { policy, loadError, reload, pendingExpiry, expirySaveFailure, setDefaultQuestionExpiry } =
    read;
  const snapshots = useDecisionsTerminalSnapshots(status, onChanged);
  const [snapshotsConsentOpen, setSnapshotsConsentOpen] = useState(false);
  const snapshotsLocked = locked || snapshots.saving;
  const snapshotsFailure = snapshots.failure;
  const shownExpiry = pendingExpiry ?? (policy ? { ms: policy.defaultQuestionExpiryMs } : null);
  // The section shows only while Decisions is on, so the toolbar's watch is shared, not doubled.
  const waiting = useDecisionsWaitingCount(true);
  const stopped = useDecisionsStoppedCount(true);
  const unlisted = useUnlistedStoppedAnswers(stopped);
  // Offered while the attention list holds an answer the inbox can't list, or a read couldn't say.
  const reviewUnlisted = offersUnlisted(unlisted);
  const openInbox = useDecisionsInboxStore((state) => state.open);
  const openAttention = useDecisionsAttentionStore((state) => state.open);
  // Settings goes first, so nothing stacks over it; reopened before it had gone, nothing opens.
  const afterSettings = (show: () => void) => {
    if (onClose === undefined) {
      show();
      return;
    }
    void onClose((closed) => {
      if (closed) show();
    }).catch(() => {});
  };
  // At the first stopped delivery when it lists one (#18048), else where the inbox opens itself.
  const showInbox = () => afterSettings(() => openInbox({ prefer: "stopped" }));
  // Only the attention list holds an answer the inbox can't list.
  const showUnlisted = () => afterSettings(() => openAttention());
  return (
    <SettingsSection title="Questions" id="decisions-questions">
      <SettingsGroup>
        <SettingsSelect
          id="decisions-questions-expiry"
          label="Default expiry"
          description={questionExpiryText(policy)}
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
          subtitle="For the agent that asked, only while its question is open, redacted on a best-effort basis"
          isEnabled={snapshots.enabled}
          onChange={() => {
            if (snapshotsLocked) return;
            if (snapshots.enabled) void snapshots.set({ enabled: false });
            else setSnapshotsConsentOpen(true);
          }}
          disabled={snapshotsLocked}
          isModified={status.terminalSnapshots === true}
          onReset={() => {
            if (!snapshotsLocked) void snapshots.set({ enabled: false });
          }}
          resetAriaLabel="Turn off terminal snapshots"
        />
        <SettingsRow
          id="decisions-questions-inbox"
          label="Inbox"
          description={inboxDescription(waiting, stopped)}
          // Two actions would squeeze the label on the rail.
          layout={reviewUnlisted ? "stacked" : "inline"}
          control={({ descriptionId }) => {
            const open = (
              <Button
                variant="outline"
                size="sm"
                aria-describedby={descriptionId}
                onClick={showInbox}
                data-testid="decisions-inbox-open"
              >
                Open inbox
              </Button>
            );
            if (!reviewUnlisted) return open;
            return (
              <SettingsRowActions>
                {open}
                <Button
                  variant="outline"
                  size="sm"
                  aria-describedby={descriptionId}
                  onClick={showUnlisted}
                  data-testid="decisions-attention-review"
                >
                  Review other answers
                </Button>
              </SettingsRowActions>
            );
          }}
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
          onRetry={() => {
            if (!snapshotsLocked) void snapshots.set(snapshotsFailure.payload);
          }}
        />
      )}
      {expirySaveFailure && (
        <SettingsLoadErrorBanner
          title="Couldn't change the default expiry"
          message={expirySaveFailure.message}
          onRetry={() => void setDefaultQuestionExpiry(expirySaveFailure.ms)}
        />
      )}
      {/* Open until main answers, so focus goes back to a switch that takes it again. */}
      <DecisionsTerminalSnapshotsConsentDialog
        isOpen={snapshotsConsentOpen}
        saving={snapshots.saving}
        onCancel={() => setSnapshotsConsentOpen(false)}
        onAccept={() => {
          if (snapshotsLocked) return;
          void snapshots
            .set({ enabled: true, consent: true })
            .then(() => setSnapshotsConsentOpen(false));
        }}
      />
    </SettingsSection>
  );
}
