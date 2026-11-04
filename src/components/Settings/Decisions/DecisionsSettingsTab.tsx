import { useEffect, useRef, useState } from "react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useDecisions } from "./useDecisions";
import { useDecisionsPolicy } from "./useDecisionsPolicy";
import { useDecisionsModel } from "./useDecisionsModel";
import { DecisionsConsentDialog } from "./DecisionsConsentDialog";
import { DecisionsConnectionSection, kitUnverified } from "./DecisionsConnectionSection";
import { DecisionsDevicesAndHosts } from "./DecisionsDevicesAndHosts";
import { DecisionsAgentsSection } from "./DecisionsAgentsSection";
import { DecisionsQuestionsSection } from "./DecisionsQuestionsSection";
import { DecisionsPolicySection } from "./DecisionsPolicySection";
import { DecisionsModelSection } from "./DecisionsModelSection";
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
  // A request for the recovery kit's passphrase field, until Data has focused it.
  const [kitFocusRequest, setKitFocusRequest] = useState(0);
  const askForKit = () => setKitFocusRequest((count) => count + 1);
  // A request for Devices' Pair a phone, until it has shown and taken focus (#16200).
  const [pairFocusRequest, setPairFocusRequest] = useState(0);
  const askForPairing = () => setPairFocusRequest((count) => count + 1);
  const shownBefore = useRef<DecisionsStatus | null>(null);

  // A relay newly set up here and not yet verified asks for its recovery kit
  // next, whether the setup's own answer or a status push showed it first.
  // One a guided deploy's claim set up moves on to pairing a phone instead
  // (#16200), with the kit still asked for above Connection. Opening Settings
  // on an unfinished setup, or turning Decisions on with one, asks nothing by
  // itself.
  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = status;
    // Off unmounts Data, so nothing asked before it carries over to turning on.
    if (status?.state === "off") {
      setKitFocusRequest(0);
      setPairFocusRequest(0);
    } else if (
      before !== null &&
      before.state !== "off" &&
      before.relayOrigin === undefined &&
      status !== null &&
      kitUnverified(status)
    ) {
      const claim = status.relayDeploy?.claim;
      const deployed =
        claim?.state === "claiming" ||
        (claim?.state === "claimed" && claim.origin === status.relayOrigin);
      if (deployed) setPairFocusRequest((count) => count + 1);
      else setKitFocusRequest((count) => count + 1);
    }
  }, [status]);

  const on = status !== null && status.state !== "off";
  // One read for the sections it feeds, so one Retry recovers them all.
  const policy = useDecisionsPolicy(on);
  const model = useDecisionsModel(on);
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
            onFinishSetup={askForKit}
            onPairPhone={askForPairing}
          />
          <DecisionsDevicesAndHosts
            status={status}
            locked={pending !== null}
            pairFocusRequest={pairFocusRequest}
            onPairFocused={() => setPairFocusRequest(0)}
          />
          <DecisionsAgentsSection status={status} policy={policy} />
          <DecisionsQuestionsSection
            policy={policy}
            status={status}
            locked={pending !== null}
            onChanged={(next) => (next ? decisions.applyStatus(next) : void decisions.reload())}
          />
          <DecisionsPolicySection policy={policy} />
          <DecisionsModelSection
            model={model}
            proxyAllowlisted={policy.policy?.proxyAllowlisted === true}
          />
          <DecisionsVoiceSection />
          <DecisionsDataSection
            status={status}
            locked={pending !== null}
            onChanged={(next) => (next ? decisions.applyStatus(next) : void decisions.reload())}
            onStatus={decisions.applyStatus}
            kitFocusRequest={kitFocusRequest}
            onKitFocused={() => setKitFocusRequest(0)}
          />
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
