import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import type { DecisionsStatus } from "@shared/types/decisions";
import { useRelayCheck } from "./useRelayCheck";
import { useRelayIdentity } from "./useRelayIdentity";
import { describeCompatibility, describeInvalidUrl, describeRelayCheck } from "./relayCheckCopy";
import { describeConnectResult } from "./relayIdentityCopy";
import { DecisionsRelaySetup } from "./DecisionsRelaySetup";
import { DecisionsDisconnectDialog } from "./DecisionsDisconnectDialog";

function relayHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** What was observed about the relay, in words; never what it implies about agents. */
function describeConnection(status: DecisionsStatus): { label: string; detail?: string } {
  const host = relayHost(status.relayOrigin);
  switch (status.state) {
    case "connected":
      return { label: host ? `Connected to ${host}` : "Connected" };
    case "connecting":
      return {
        label: host ? `Connecting to ${host}` : "Connecting",
        detail: "Waiting for the relay to answer",
      };
    case "revoked":
      return {
        label: host ? `Refused by ${host}` : "Refused by the relay",
        detail: "The relay no longer accepts this computer, so Daintree won't reconnect to it",
      };
    default:
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
 * version that has moved apart is said, and can disconnect from it.
 */
export function DecisionsConnectionSection({
  status,
  locked = false,
  onChanged,
}: {
  status: DecisionsStatus;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
  /**
   * A claim, restore or disconnect settled, so the status may have moved:
   * main's answer when it changed the identity, null when it didn't say.
   */
  onChanged?: (status: DecisionsStatus | null) => void;
}) {
  const { label, detail } = describeConnection(status);
  const savedOrigin = status.relayOrigin ?? null;
  const connected = status.state === "connected";
  const keysStored = status.keysStored === true;
  const relay = useRelayCheck();
  const identity = useRelayIdentity((next) => onChanged?.(next));
  const [draft, setDraft] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const busy = locked || identity.pending !== null;

  const forget = useEffectEvent(() => {
    relay.reset();
    identity.reset();
  });
  const checkSaved = useEffectEvent((origin: string) => relay.run(origin));
  useEffect(() => {
    forget();
  }, [savedOrigin]);
  // Not while the switch is changing; unlocked, it runs then.
  useEffect(() => {
    if (connected && savedOrigin && !locked) checkSaved(savedOrigin);
  }, [connected, savedOrigin, locked]);

  // A setup reruns the check, and what it saw then is newer than the last one shown.
  const check = identity.recheck ?? relay.check;
  const observation = check ? describeRelayCheck(check) : null;
  const compatibility = check && "compatibility" in check ? check.compatibility : null;
  const versions = compatibility ? describeCompatibility(compatibility) : null;
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
    : identity.pending === "claim"
      ? "Claiming the relay…"
      : identity.pending === "restore"
        ? "Restoring the identity…"
        : outcome
          ? `${outcome.label}. ${outcome.detail}`
          : (outcomeError ??
            (observation ? `${observation.label}. ${observation.detail}` : (rowError ?? "")));
  const setupCheck = savedOrigin === null && relay.checkedUrl !== null ? check : null;

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
      <SettingsGroup>
        <SettingsRow
          id="decisions-connection-status"
          label={label}
          accessory={
            status.state === "revoked" ? (
              <SeverityMark severity="warning" label="Refused" className="h-3.5 w-3.5" decorative />
            ) : undefined
          }
          description={detail}
        />
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
                onSubmit={(event) => {
                  event.preventDefault();
                  submitDraft();
                }}
              >
                <Input
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={2048}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    // What was checked was the old address; drop it, and any check still out.
                    if (relay.check || relay.checking || relay.error) relay.reset();
                    identity.reset();
                  }}
                  placeholder="https://decisions.example.workers.dev"
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  aria-invalid={check?.result === "invalid-url" ? true : undefined}
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
                  severity="warning"
                  label={versions.label}
                  className="h-3.5 w-3.5"
                  decorative
                />
              ) : undefined
            }
            description={versions.detail}
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
      {(savedOrigin !== null || keysStored) && (
        <SettingsGroup>
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
      />
    </SettingsSection>
  );
}
