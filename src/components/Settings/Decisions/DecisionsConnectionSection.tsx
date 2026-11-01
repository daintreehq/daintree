import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import type { DecisionsStatus } from "@shared/types/decisions";
import { useRelayCheck } from "./useRelayCheck";
import { describeCompatibility, describeInvalidUrl, describeRelayCheck } from "./relayCheckCopy";

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
 * a URL; with one it checks that relay, by itself once connected, so a
 * version that has moved apart is said. Claiming or restoring a relay joins
 * this section with #16006.
 */
export function DecisionsConnectionSection({
  status,
  locked = false,
}: {
  status: DecisionsStatus;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
}) {
  const { label, detail } = describeConnection(status);
  const savedOrigin = status.relayOrigin ?? null;
  const connected = status.state === "connected";
  const relay = useRelayCheck();
  const [draft, setDraft] = useState("");

  const forget = useEffectEvent(() => relay.reset());
  const checkSaved = useEffectEvent((origin: string) => relay.run(origin));
  useEffect(() => {
    forget();
  }, [savedOrigin]);
  useEffect(() => {
    if (connected && savedOrigin) checkSaved(savedOrigin);
  }, [connected, savedOrigin]);

  const check = relay.check;
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
  const announcement = relay.checking
    ? "Checking the relay…"
    : observation
      ? `${observation.label}. ${observation.detail}`
      : (rowError ?? "");

  const submitDraft = () => {
    if (locked || relay.checking || draft.trim() === "") return;
    relay.run(draft);
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
            disabled={locked}
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
            disabled={locked}
            control={({ disabled }) => (
              <Button
                variant="outline"
                size="sm"
                loading={relay.checking}
                disabled={disabled}
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
      </SettingsGroup>
    </SettingsSection>
  );
}
