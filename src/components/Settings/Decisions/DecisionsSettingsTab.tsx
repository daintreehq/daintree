import { useEffect, useState } from "react";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useDecisions } from "./useDecisions";
import { DecisionsConsentDialog } from "./DecisionsConsentDialog";
import { DecisionsConnectionSection } from "./DecisionsConnectionSection";
import { DecisionsDevicesSection } from "./DecisionsDevicesSection";
import { DecisionsQuestionsSection } from "./DecisionsQuestionsSection";
import { DecisionsPolicySection } from "./DecisionsPolicySection";
import { DecisionsVoiceSection } from "./DecisionsVoiceSection";
import { DecisionsDataSection } from "./DecisionsDataSection";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { holdRelayUrlRequests } from "./relayUrlRequest";

/**
 * Settings → Integrations → Decisions: one switch, consent the first time it
 * turns on, and behind it a section per part of the feature. Each section is
 * its own component so the child issue that fills one doesn't touch the rest.
 */
export function DecisionsSettingsTab({ onClose }: { onClose?: SettingsTabClose } = {}) {
  const decisions = useDecisions();
  // A deploy pane's request for the URL field lasts as long as this opening.
  useEffect(() => holdRelayUrlRequests(), []);
  const { status, pending, saveFailure } = decisions;
  const [consentOpen, setConsentOpen] = useState(false);

  const on = status !== null && status.state !== "off";
  const enabled = pending?.enabled ?? on;
  const locked = status === null || pending !== null;

  const toggle = () => {
    if (locked) return;
    if (enabled) {
      void decisions.setEnabled({ enabled: false });
    } else if (status?.consentedAt === undefined) {
      setConsentOpen(true);
    } else {
      void decisions.setEnabled({ enabled: true });
    }
  };

  return (
    <div className="space-y-8">
      {/* No section heading: the page is already titled "Decisions", so the
          switch carries the concept on its own. */}
      <div className="space-y-3">
        {status === null && decisions.loadError !== null && (
          <SettingsLoadErrorBanner
            title="Couldn't read whether Decisions is on"
            message={decisions.loadError}
            onRetry={() => void decisions.reload()}
          />
        )}
        <SettingsGroup>
          <SettingsSwitchCard
            id="decisions-enable"
            title="Enable Decisions"
            subtitle="Agents ask you a question and end their turn. You answer from your phone, and Daintree types your answer into the terminal that asked. Needs a relay in your own Cloudflare account and a paired phone."
            isEnabled={enabled}
            onChange={toggle}
            disabled={locked}
          />
        </SettingsGroup>
        {saveFailure && (
          <SettingsLoadErrorBanner
            title={
              saveFailure.payload.enabled
                ? "Couldn't turn on Decisions"
                : "Couldn't turn off Decisions"
            }
            message={saveFailure.message}
            onRetry={() => void decisions.setEnabled(saveFailure.payload)}
          />
        )}
      </div>

      {on && (
        <>
          <DecisionsConnectionSection
            status={status}
            locked={pending !== null}
            onChanged={(next) => (next ? decisions.applyStatus(next) : void decisions.reload())}
            onClose={onClose}
          />
          <DecisionsDevicesSection />
          <DecisionsQuestionsSection />
          <DecisionsPolicySection />
          <DecisionsVoiceSection />
          <DecisionsDataSection />
        </>
      )}

      <DecisionsConsentDialog
        isOpen={consentOpen}
        onCancel={() => setConsentOpen(false)}
        onAccept={() => {
          setConsentOpen(false);
          void decisions.setEnabled({ enabled: true, consent: true });
        }}
      />
    </div>
  );
}
