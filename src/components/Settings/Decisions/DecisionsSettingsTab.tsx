import { Fragment, useEffect, useRef, useState } from "react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useDecisions } from "./useDecisions";
import { useDecisionsPolicy } from "./useDecisionsPolicy";
import { useDecisionsModel } from "./useDecisionsModel";
import { useRelayCheck } from "./useRelayCheck";
import { DecisionsConsentDialog } from "./DecisionsConsentDialog";
import { DecisionsConnectionSection, kitUnverified } from "./DecisionsConnectionSection";
import { DecisionsDevicesAndHosts } from "./DecisionsDevicesAndHosts";
import { DecisionsStatusFacts } from "./DecisionsStatusFacts";
import { useDecisionsDevices } from "./useDecisionsDevices";
import {
  DecisionsAgentsSection,
  switchedOnCount,
  useDecisionsAgentSupport,
} from "./DecisionsAgentsSection";
import { DecisionsQuestionsSection } from "./DecisionsQuestionsSection";
import { DecisionsNotificationsSection } from "./DecisionsNotificationsSection";
import { DecisionsPolicySection } from "./DecisionsPolicySection";
import { DecisionsModelSection } from "./DecisionsModelSection";
import { DecisionsDataSection } from "./DecisionsDataSection";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { useHoldSettingsDeepLink } from "@/components/Settings/settingsDeepLink";
import { holdRelayUrlRequests } from "./relayUrlRequest";
import { unfinishedReason } from "./setupCheckCopy";

/**
 * Setup is finished and the relay is up, so the page can lead with the everyday
 * controls. Anything short of that (no relay, an unverified kit, a setup check
 * that hasn't passed, a connection that is down or has a problem) is something
 * Connection is for.
 */
function setupDone(status: DecisionsStatus): boolean {
  return (
    status.relayOrigin !== undefined &&
    status.state === "connected" &&
    status.problem === undefined &&
    unfinishedReason(status) === null
  );
}

/**
 * Settings → Integrations → Decisions: one switch, consent the first time it
 * turns on, and behind it a section per part of the feature. Each section is
 * its own component so the child issue that fills one doesn't touch the rest.
 *
 * Until setup is finished and the relay is up, Connection and what it leads to
 * (Devices, Remote Hosts, Encryption) come first, in the order a first run
 * needs them. After that the everyday controls (Agents, Questions, Policy,
 * Decision model) come first and those follow, and Data is last either way.
 */
export function DecisionsSettingsTab({
  onClose,
  isActive = true,
}: { onClose?: SettingsTabClose; isActive?: boolean } = {}) {
  const decisions = useDecisions();
  // A deploy pane's request for the URL field lasts as long as this opening.
  useEffect(() => holdRelayUrlRequests(), []);
  const { status, pending, saveFailure } = decisions;
  // The sections a settings link may name aren't there until the first read lands.
  useHoldSettingsDeepLink(status === null && decisions.loadError === null);
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
  // Connection first stays that way once the person has seen it first, for this
  // opening of Settings: finishing setup, or a reconnect, would otherwise move
  // the section they're looking at a screen or two down under them. Only a
  // visible page counts, since the tab is read ahead while hidden. Off clears it.
  const [connectionLed, setConnectionLed] = useState(false);
  if (status !== null) {
    if (status.state === "off") {
      if (connectionLed) setConnectionLed(false);
    } else if (isActive && !setupDone(status) && !connectionLed) {
      setConnectionLed(true);
    }
  }
  const connectionFirst = connectionLed || (status !== null && !setupDone(status));
  // One read for the sections it feeds, so one Retry recovers them all.
  const policy = useDecisionsPolicy(on);
  const model = useDecisionsModel(on);
  // Connection's check of the relay (#18061), and one read of the relay's
  // devices, for Devices and Remote Hosts and for Connection's facts; both
  // shared with Notifications.
  const relay = useRelayCheck();
  const devicesRead = useDecisionsDevices(on ? (status.relayOrigin ?? null) : null);
  const { supported } = useDecisionsAgentSupport();
  const installedRead = useCliAvailabilityStore((state) => state.hasRealData);
  // Counted as the facts line counts them (#18059), from the policy as last
  // read, which the Agents switches show too; never before the first read. A
  // remote window's agents are the Host's, which its Agents section doesn't show.
  const agentsOff =
    !isRemoteWindow() &&
    policy.policy !== null &&
    switchedOnCount(policy.policy.askHumanAgents, supported, installedRead) === 0;
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

  // Keyed, so moving a group keeps what each section holds (a draft, a running check).
  const setup = on && (
    <Fragment key="setup">
      <DecisionsConnectionSection
        status={status}
        relay={relay}
        locked={pending !== null}
        onChanged={(next) => (next ? decisions.applyStatus(next) : void decisions.reload())}
        onClose={onClose}
        onFinishSetup={askForKit}
        onPairPhone={askForPairing}
        facts={<DecisionsStatusFacts devices={devicesRead} policy={policy} />}
        agentsOff={agentsOff}
      />
      <DecisionsDevicesAndHosts
        status={status}
        devicesRead={devicesRead}
        locked={pending !== null}
        pairFocusRequest={pairFocusRequest}
        onPairFocused={() => setPairFocusRequest(0)}
      />
    </Fragment>
  );
  const everyday = on && (
    <Fragment key="everyday">
      <DecisionsAgentsSection status={status} policy={policy} />
      <DecisionsQuestionsSection
        policy={policy}
        status={status}
        locked={pending !== null}
        onChanged={(next) => (next ? decisions.applyStatus(next) : void decisions.reload())}
        onClose={onClose}
      />
      <DecisionsNotificationsSection
        status={status}
        relayCheck={relay.check}
        devices={devicesRead}
        locked={pending !== null}
        onChanged={(next) => (next ? decisions.applyStatus(next) : void decisions.reload())}
      />
      <DecisionsPolicySection policy={policy} />
      <DecisionsModelSection model={model} />
    </Fragment>
  );

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
          {connectionFirst ? [setup, everyday] : [everyday, setup]}
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

      {/* Open until main answers, so focus goes back to a switch that takes it again. */}
      <DecisionsConsentDialog
        isOpen={consentOpen}
        saving={pending !== null}
        onCancel={() => setConsentOpen(false)}
        onAccept={() => {
          if (locked) return;
          void decisions
            .setEnabled({ enabled: true, consent: true })
            .then(() => setConsentOpen(false));
        }}
      />
    </div>
  );
}
