import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import type { DecisionsRelayCheck, DecisionsStatus } from "@shared/types/decisions";
import { useRelayCheck } from "./useRelayCheck";
import { useRelayIdentity } from "./useRelayIdentity";
import {
  describeCompatibility,
  describeInvalidUrl,
  describeRelayCheck,
  type RelayUpdateRoute,
} from "./relayCheckCopy";
import { describeConnectResult } from "./relayIdentityCopy";
import { DecisionsRelaySetup } from "./DecisionsRelaySetup";
import { DecisionsDisconnectDialog } from "./DecisionsDisconnectDialog";
import { DecisionsRelayDeploy, DecisionsRelayDeployOutcome } from "./DecisionsRelayDeploy";
import { describeRelayDeploy } from "./relayDeployCopy";
import { DecisionsRelayUpdate } from "./DecisionsRelayUpdate";
import { canUpdateRelayAt, useRelayUpdateRun } from "./relayUpdate";
import { describeRelayUpdateOutcome, relayVersionAfter } from "./relayUpdateCopy";
import { DecisionsRelayRemove } from "./DecisionsRelayRemove";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { landOnSettingsElement } from "@/components/Settings/settingsLanding";
import { onRelayUrlRequest, takePendingRelayUrlRequest } from "./relayUrlRequest";
import { DecisionsSetupCheck } from "./DecisionsSetupCheck";
import { SETUP_STEP_LABEL, unfinishedReason } from "./setupCheckCopy";
import { useSetupCheck } from "./useSetupCheck";

function relayHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * A next attempt as a wall clock reading ("3:45:20 PM"): it stays true
 * without being redrawn, so nothing here needs a ticking timer.
 */
function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

const PROBLEM_DETAIL: Record<NonNullable<DecisionsStatus["problem"]>, string> = {
  keys: "This computer's Decisions keys couldn't be read, or they belong to another relay. Disconnect to set it up again",
  storage:
    "Daintree couldn't keep what the relay sends, because the local Decisions database isn't accepting writes. Turn Decisions off and on to try again",
  "other-relay":
    "This computer's Decisions data came from another relay identity, so Daintree won't sync it with this one",
};

/** Check results from a relay that answered as a Decisions relay, which the guided removal can take. */
const ANSWERED_AS_RELAY = new Set<DecisionsRelayCheck["result"]>([
  "unclaimed",
  "claimed",
  "incompatible",
  "claim-not-configured",
]);

/** A relay is set up here, but no recovery kit has been verified for it (#16007). */
export function kitUnverified(status: DecisionsStatus): boolean {
  return status.relayOrigin !== undefined && status.recoveryKitVerifiedAt === undefined;
}

/** What was observed about the relay, in words; never what it implies about agents. */
function describeConnection(status: DecisionsStatus): {
  label: string;
  detail?: string;
  severity?: "warning";
} {
  const host = relayHost(status.relayOrigin);
  switch (status.state) {
    case "connected":
      return { label: host ? `Connected to ${host}` : "Connected" };
    case "connecting":
      return {
        label: host ? `Connecting to ${host}` : "Connecting",
        detail: "Waiting for the relay to answer",
      };
    case "reconnecting":
      return {
        label: host ? `Reconnecting to ${host}` : "Reconnecting",
        detail:
          status.nextAttemptAt !== undefined
            ? `The connection closed. Next attempt at ${clockTime(status.nextAttemptAt)}`
            : "The connection closed",
      };
    case "replaced":
      return {
        label: "Replaced by another connection",
        detail: `The relay closed this connection for a newer one with this computer's identity, most likely another copy of Daintree using the same keys.${
          status.nextAttemptAt !== undefined
            ? ` Daintree tries again at ${clockTime(status.nextAttemptAt)}`
            : ""
        }`,
        severity: "warning",
      };
    case "revoked":
      return {
        label: host ? `Revoked by ${host}` : "Revoked by the relay",
        detail:
          "The relay revoked this computer, so Daintree won't reconnect to it. Disconnect to remove its keys",
        severity: "warning",
      };
    default:
      if (status.problem) {
        return {
          label: "Not connected",
          detail: PROBLEM_DETAIL[status.problem],
          severity: "warning",
        };
      }
      return {
        label: "Not connected",
        detail: host ? `Set up with ${host}` : "No relay is set up on this computer yet",
      };
  }
}

/**
 * Connection: the service state (#16001), and the relay's address with its
 * unsigned check (#16005), which main makes. Without a relay set up it takes
 * a URL, and once checked, claims it or restores its owner's identity
 * (#16006); with one it checks that relay, by itself once connected, so a
 * version that has moved apart is said, and can disconnect from it. With no
 * relay set up it also offers to deploy one (#16023); with one, in a local
 * window, to update it (#16201), checking it again once the update ends. It
 * offers to remove the relay from Cloudflare, the one set up here or one a
 * check just found (#16202).
 */
export function DecisionsConnectionSection({
  status,
  locked = false,
  onChanged,
  onClose,
  onFinishSetup,
  onPairPhone,
}: {
  status: DecisionsStatus;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
  /**
   * A claim, restore or disconnect settled, so the status may have moved:
   * main's answer when it changed the identity, null when it didn't say.
   */
  onChanged?: (status: DecisionsStatus | null) => void;
  /** Closes Settings, for a guided deploy or update the user watches in its pane. */
  onClose?: SettingsTabClose;
  /** Takes the person to the recovery kit, which finishes setup. */
  onFinishSetup?: () => void;
  /** Takes the person on to pairing a phone, once a deployed relay is claimed here. */
  onPairPhone?: () => void;
}) {
  const { label, detail, severity } = describeConnection(status);
  // A revoked relay, or one that can't be used, says so on its own row: no kit or check changes that.
  const reason =
    status.state !== "revoked" && status.problem === undefined ? unfinishedReason(status) : null;
  const savedOrigin = status.relayOrigin ?? null;
  const connected = status.state === "connected";
  const keysStored = status.keysStored === true;
  const relay = useRelayCheck();
  const identity = useRelayIdentity((next) => onChanged?.(next));
  const setup = useSetupCheck(status.relayOrigin);
  const checking = setup.run?.state === "running";
  const [draft, setDraft] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  /** The deployed relay's URL as Daintree put it in the field, until the person edits it. */
  const autoFilled = useRef<string | null>(null);
  const relayUrlField = useRef<HTMLInputElement>(null);
  const deploy = status.relayDeploy;
  // Main is claiming the relay a guided deploy created (#16200): nothing here starts meanwhile.
  const deployClaiming = deploy?.claim?.state === "claiming";
  const deployClaimed = deploy?.claim?.state === "claimed";
  // Its claim made it this computer's relay, so how that went stays beside it,
  // while that relay is still the one agents launch with.
  const deployClaimedHere =
    deploy !== undefined &&
    deploy.claim?.state === "claimed" &&
    deploy.claim.origin === savedOrigin &&
    status.state !== "revoked" &&
    status.problem === undefined;
  // How main's claim ended, heard as it ends: the outcome row itself isn't a live region.
  const deployOutcome =
    deploy?.claim && deploy.claim.state !== "claiming" && (deployClaimedHere || !deployClaimed)
      ? describeRelayDeploy(deploy)
      : null;
  const deployAnnouncement = deployOutcome ? `${deployOutcome.label}. ${deployOutcome.detail}` : "";
  const busy = locked || identity.pending !== null || deployClaiming;

  // The update whose end this mount has checked the relay for; a reset drops that check.
  const recheckedFor = useRef<number | null>(null);
  const forget = useEffectEvent(() => {
    relay.reset();
    identity.reset();
    recheckedFor.current = null;
  });
  const checkSaved = useEffectEvent((origin: string) => relay.run(origin));
  useEffect(() => {
    forget();
  }, [savedOrigin]);
  // A finished guided deploy asks for the URL field (#16023), which exists only now,
  // filled with the relay it reported unless the person typed something there
  // (#16199). A URL Daintree filled in for an earlier deploy is replaced, with
  // whatever was checked for it.
  const landOnRelayUrl = useEffectEvent(() => {
    const deployedUrl = status.relayDeploy?.url;
    const untouched = draft.trim() === "" || draft === autoFilled.current;
    if (savedOrigin === null && deployedUrl !== undefined && untouched && draft !== deployedUrl) {
      setDraft(deployedUrl);
      autoFilled.current = deployedUrl;
      if (relay.check || relay.checking || relay.error) relay.reset();
      identity.reset();
    }
    const row = document.getElementById("decisions-relay-url");
    if (row) landOnSettingsElement(row);
  });
  useEffect(() => {
    if (takePendingRelayUrlRequest()) landOnRelayUrl();
    return onRelayUrlRequest(() => landOnRelayUrl());
  }, []);
  // Not while the switch is changing; unlocked, it runs then.
  useEffect(() => {
    if (connected && savedOrigin && !locked) checkSaved(savedOrigin);
  }, [connected, savedOrigin, locked]);

  // A remote window's relay is the Host's, so only the Host updates it.
  const remote = isRemoteWindow();
  const updateOffered =
    savedOrigin !== null && status.state !== "revoked" && !remote && canUpdateRelayAt(savedOrigin);
  const updateRoute: RelayUpdateRoute = updateOffered ? "offered" : remote ? "host" : "cli";
  const latestUpdate = useRelayUpdateRun();
  const update = updateOffered && latestUpdate?.origin === savedOrigin ? latestUpdate : null;
  const endedUpdateId = update?.state === "ended" ? update.id : null;
  // Any relay's: one update runs at a time in a window.
  const updateRunning = latestUpdate?.state === "running";
  // Never an update and a removal of one relay at once (#16202), from any window.
  const removing =
    status.relayRemovals?.some(
      (removal) => removal.origin === savedOrigin && removal.outcome.state === "running"
    ) === true;
  // What the outcome reads: set with the check it started, so it reads that check.
  const [recheckedUpdateId, setRecheckedUpdateId] = useState<number | null>(null);
  const recheckAfterUpdate = useEffectEvent((origin: string, updateId: number) => {
    if (recheckedFor.current === updateId) return;
    recheckedFor.current = updateId;
    setRecheckedUpdateId(updateId);
    relay.run(origin);
  });
  // Connected or not: an update can leave a relay this computer can't reach
  // yet. Not while a claim, restore or disconnect is settling, which may yet
  // set this relay aside; it runs once that has.
  useEffect(() => {
    if (endedUpdateId !== null && savedOrigin && !busy) {
      recheckAfterUpdate(savedOrigin, endedUpdateId);
    }
  }, [endedUpdateId, savedOrigin, busy]);

  const updateRechecked = update?.state === "ended" && recheckedUpdateId === update.id;
  // A setup reruns the check, and what it saw then is newer than the last one
  // shown, unless an update has ended since and been checked after.
  const check = updateRechecked ? relay.check : (identity.recheck ?? relay.check);
  const observation = check ? describeRelayCheck(check) : null;
  const compatibility = check && "compatibility" in check ? check.compatibility : null;
  const versions = compatibility ? describeCompatibility(compatibility, updateRoute) : null;
  const updateOutcome =
    update?.state === "ended" &&
    updateRechecked &&
    !relay.checking &&
    (relay.check !== null || relay.error !== null)
      ? describeRelayUpdateOutcome(update.end, update.fromVersion, relayVersionAfter(relay.check))
      : null;
  // An address that was never sent, or a check main couldn't make: the row's own error.
  const rowError =
    check?.result === "invalid-url"
      ? describeInvalidUrl(check.reason)
      : relay.error
        ? `Couldn't check the relay. ${relay.error}`
        : undefined;
  const outcome =
    identity.result && identity.result.result !== "relay"
      ? describeConnectResult(identity.result)
      : null;
  const outcomeError =
    identity.error && identity.error.action !== "disconnect"
      ? `${identity.error.action === "claim" ? "Couldn't claim the relay" : "Couldn't restore the identity"}. ${identity.error.message}`
      : null;
  const announcement = relay.checking
    ? "Checking the relay…"
    : identity.pending === "claim" || deployClaiming
      ? "Claiming the relay…"
      : identity.pending === "restore"
        ? "Restoring the identity…"
        : outcome
          ? `${outcome.label}. ${outcome.detail}`
          : (outcomeError ??
            (updateOutcome
              ? `${updateOutcome.label}. ${updateOutcome.detail}`
              : observation
                ? `${observation.label}. ${observation.detail}`
                : (rowError ?? "")));
  const setupCheck = savedOrigin === null && relay.checkedUrl !== null ? check : null;
  // The relay set up here, whatever state it's in, or else one a check found
  // answering as a relay (claimed by someone else, or never claimed) (#16202).
  // A check in flight may be for another address, so the last one's offer waits for it.
  const removeTarget = remote
    ? null
    : (savedOrigin ??
      (!relay.checking &&
      setupCheck &&
      "origin" in setupCheck &&
      ANSWERED_AS_RELAY.has(setupCheck.result)
        ? setupCheck.origin
        : null));

  /** The guided deploy's relay: into the field, and checked, so it can be claimed. */
  const checkDeployedRelay = (url: string) => {
    if (busy || relay.checking) return;
    setDraft(url);
    autoFilled.current = url;
    identity.reset();
    relay.run(url);
  };

  const submitDraft = () => {
    if (busy || relay.checking || draft.trim() === "") return;
    identity.reset();
    relay.run(draft);
  };

  const confirmDisconnect = () => {
    identity.disconnect().then(
      (done) => {
        if (done) setDisconnectOpen(false);
      },
      () => {}
    );
  };

  return (
    <SettingsSection
      title="Connection"
      description="Questions and answers travel through a relay in your own Cloudflare account. Daintree runs no server for this."
      id="decisions-connection"
    >
      {/* The whole observation, label and detail, so a change is heard in full. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {detail ? `${label}. ${detail}` : label}
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {deployAnnouncement}
      </span>
      {reason === "kit" && (
        <Callout
          severity="warning"
          title="Setup isn't finished"
          action={
            <Button variant="outline" size="sm" onClick={() => onFinishSetup?.()}>
              Save recovery kit
            </Button>
          }
        >
          Save a recovery kit and verify it, then run the setup check to finish. Everything on the
          relay is encrypted with keys only this computer holds: without a kit or these keys, none
          of it can be recovered, by anyone.
        </Callout>
      )}
      {reason !== null && reason !== "kit" && (
        <Callout
          severity="warning"
          title="Setup isn't finished"
          action={
            checking ? undefined : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                loading={setup.starting}
                onClick={() => setup.start()}
              >
                {reason === "check" ? "Check setup" : "Check again"}
              </Button>
            )
          }
        >
          {reason === "check"
            ? "Run the setup check to finish. It sends a test question to your paired phones and types your answer into a diagnostic terminal that runs no agent."
            : `The last setup check stopped at ${SETUP_STEP_LABEL[reason.failedStep].toLowerCase()}. Setup finishes once every step passes.`}
        </Callout>
      )}
      <SettingsGroup>
        <SettingsRow
          id="decisions-connection-status"
          label={label}
          accessory={
            severity ? (
              <SeverityMark severity={severity} label={label} className="h-3.5 w-3.5" decorative />
            ) : undefined
          }
          description={detail}
        />
        {deployClaimedHere && (
          <DecisionsRelayDeployOutcome
            deploy={deploy}
            disabled={busy}
            onUseRelay={checkDeployedRelay}
            onClaimSettled={(next) => onChanged?.(next)}
            onPairPhone={onPairPhone}
          />
        )}
        {savedOrigin === null ? (
          <SettingsRow
            id="decisions-relay-url"
            label="Relay URL"
            description="Your relay's address. Daintree checks that it's a Decisions relay it can talk to, and whether it has been claimed."
            layout="stacked"
            error={rowError}
            disabled={busy}
            control={({ labelId, descriptionId, disabled }) => (
              <form
                className="flex items-center gap-2"
                // Main takes a bare host and adds the scheme, which a URL field's
                // own validation would refuse before the check ever ran.
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  submitDraft();
                }}
              >
                <Input
                  ref={relayUrlField}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={2048}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    autoFilled.current = null;
                    // What was checked was the old address; drop it, and any check still out.
                    if (relay.check || relay.checking || relay.error) relay.reset();
                    identity.reset();
                  }}
                  placeholder="https://decisions.example.workers.dev"
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  // Explicit both ways: a bare host fails the URL field's own check,
                  // which assistive tech would otherwise read as invalid.
                  aria-invalid={check?.result === "invalid-url"}
                  disabled={disabled}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  loading={relay.checking}
                  disabled={disabled || draft.trim() === ""}
                >
                  Check
                </Button>
              </form>
            )}
          />
        ) : (
          <SettingsRow
            id="decisions-relay-url"
            label="Relay"
            description={savedOrigin}
            error={rowError}
            disabled={busy}
            control={({ descriptionId, disabled }) => (
              <Button
                variant="outline"
                size="sm"
                loading={relay.checking}
                disabled={disabled}
                aria-describedby={descriptionId}
                onClick={() => relay.run(savedOrigin)}
              >
                {check || relay.error ? "Check again" : "Check"}
              </Button>
            )}
          />
        )}
        {observation && (
          <SettingsRow
            id="decisions-relay-check"
            label={observation.label}
            accessory={
              <SeverityMark
                severity={observation.severity}
                label={observation.label}
                className="h-3.5 w-3.5"
                decorative
              />
            }
            description={observation.detail}
          />
        )}
        {versions && compatibility && (
          <SettingsRow
            id="decisions-relay-versions"
            label={versions.label}
            accessory={
              compatibility.diverges ? (
                <SeverityMark
                  severity={versions.severity}
                  label={versions.label}
                  className="h-3.5 w-3.5"
                  decorative
                />
              ) : undefined
            }
            description={versions.detail}
          />
        )}
        {updateOffered && savedOrigin !== null && (
          <DecisionsRelayUpdate
            origin={savedOrigin}
            compatibility={compatibility}
            running={updateRunning}
            outcome={updateOutcome}
            disabled={busy || relay.checking || removing}
            onClose={onClose}
          />
        )}
        {setupCheck && relay.checkedUrl !== null && (
          <DecisionsRelaySetup
            key={relay.checkedUrl}
            check={setupCheck}
            checkedUrl={relay.checkedUrl}
            keysStored={keysStored}
            disabled={busy || relay.checking}
            identity={identity}
            deploy={status.relayDeploy}
          />
        )}
        {outcome && (
          <SettingsRow
            id="decisions-relay-setup-outcome"
            label={outcome.label}
            accessory={
              <SeverityMark
                severity={outcome.severity}
                label={outcome.label}
                className="h-3.5 w-3.5"
                decorative
              />
            }
            description={outcome.detail}
          />
        )}
        {outcomeError && (
          <SettingsRow
            id="decisions-relay-setup-outcome"
            label={
              identity.error?.action === "claim"
                ? "Couldn't claim the relay"
                : "Couldn't restore the identity"
            }
            accessory={
              <SeverityMark severity="error" label="Failed" className="h-3.5 w-3.5" decorative />
            }
            description={identity.error?.message}
          />
        )}
      </SettingsGroup>
      {savedOrigin !== null && status.state !== "revoked" && (
        <DecisionsSetupCheck check={setup} status={status} disabled={busy} />
      )}
      {/* A claimed relay no longer set up here (disconnected since) has nothing left to offer. */}
      {savedOrigin === null && (
        <DecisionsRelayDeploy
          disabled={busy || relay.checking}
          onClose={onClose}
          deploy={deployClaimed ? undefined : deploy}
          onUseRelay={checkDeployedRelay}
          onClaimSettled={(next) => onChanged?.(next)}
          onPairPhone={onPairPhone}
        />
      )}
      {(savedOrigin !== null || keysStored || removeTarget !== null) && (
        <SettingsGroup>
          {(savedOrigin !== null || keysStored) && (
            <SettingsRow
              id="decisions-disconnect"
              label={
                savedOrigin !== null ? "Disconnect this computer" : "Keys from an unfinished setup"
              }
              description={
                savedOrigin !== null
                  ? "Removes this computer's Decisions keys and its record of the relay. The relay and its data stay as they are."
                  : "This computer holds Decisions keys no relay is recorded for, from a claim that wasn't confirmed or a setup whose settings didn't save. Claim or restore the same relay to use them, or remove them to set up another."
              }
              disabled={busy}
              control={({ descriptionId, disabled }) => (
                <Button
                  variant="ghost-danger"
                  size="sm"
                  disabled={disabled}
                  aria-describedby={descriptionId}
                  onClick={() => setDisconnectOpen(true)}
                >
                  {savedOrigin !== null ? "Disconnect relay" : "Remove keys"}
                </Button>
              )}
            />
          )}
          {removeTarget !== null && (
            <DecisionsRelayRemove
              key={removeTarget}
              relayOrigin={removeTarget}
              recorded={savedOrigin !== null}
              disabled={busy || updateRunning}
              onClose={onClose}
            />
          )}
        </SettingsGroup>
      )}
      <DecisionsDisconnectDialog
        isOpen={disconnectOpen}
        relayOrigin={savedOrigin}
        disconnecting={identity.pending === "disconnect"}
        error={identity.error?.action === "disconnect" ? identity.error.message : null}
        onCancel={() => {
          if (identity.pending !== "disconnect") setDisconnectOpen(false);
        }}
        onConfirm={confirmDisconnect}
        // With the relay gone, so is its button; setting up the next one starts here.
        restoreFocusTo={relayUrlField}
      />
    </SettingsSection>
  );
}
