import { useEffect, useEffectEvent, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText } from "@/utils/clientAppError";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import type {
  HostSshHostKeys,
  HostSshKey,
  HostSshKeyGap,
  HostSshListenerBaseline,
  HostSshListenerReading,
  HostSshReadOutcome,
} from "@shared/types/ipc/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow, SettingsRowActions } from "../SettingsGroup";

interface HostSshKeysSectionProps {
  hostId: string;
  hostName: string;
  connected: boolean;
  /** Changes when the host is pointed elsewhere, so what was read of the old machine goes. */
  connectionKey: string;
  /** Where this computer's trust in the host's SSH server comes from. */
  trust: string;
  /** The fingerprint this computer pins for the host's SSH server, when it pins one. */
  pinnedFingerprint: string | null;
}

const KEY_GAP_TEXT: Record<HostSshKeyGap["reason"], string> = {
  missing: "No public key file",
  "permission-denied": "Not readable by Daintree's user",
  "not-a-public-file": "Not a plain public key file, so it wasn't opened",
  invalid: "Not an OpenSSH public key",
  "relative-path": "A relative path only the daemon can resolve",
  unreadable: "Couldn't be read",
};

const LISTENER_GAP_TEXT: Record<string, string> = {
  "command-line-unreadable": "its command line couldn't be read",
  "other-namespace": "it runs in another container, so its files aren't the host's",
  "namespace-unknown": "what it sees as its filesystem couldn't be read",
  "untrusted-binary": "its sshd binary isn't one Daintree will run",
  "relative-path": "it was started with a relative path",
  "config-unreadable": "its configuration couldn't be read",
  "config-dump-unavailable": "its sshd is too old to list its keys",
  "config-dump-failed": "its sshd couldn't list its keys",
  "timed-out": "reading it took too long",
  exited: "it exited while it was read",
  truncated: "it has more keys than one reading carries",
};

function listenerLabel(listener: { configFile: string | null; listenAddresses: string[] }) {
  const config = listener.configFile ?? "Default configuration";
  return listener.listenAddresses.length > 0
    ? `${config} · ${listener.listenAddresses.join(", ")}`
    : config;
}

function outcomeText(outcome: HostSshReadOutcome, hostName: string): string | null {
  switch (outcome.status) {
    case "reading":
      return outcome.truncated
        ? `${hostName} has more SSH servers than one reading carries, so some aren't shown`
        : null;
    case "no-sshd-visible":
      return `No SSH server is visible to Daintree's user on ${hostName}`;
    case "discovery-failed":
      return `Couldn't list ${hostName}'s processes to find its SSH server`;
    case "timed-out":
      return `${hostName} didn't finish reading its SSH keys in time. Refresh to try again`;
    case "unsupported-platform":
      return `Only a Linux host can read its own SSH keys; ${hostName} runs ${outcome.platform}`;
    case "host-outdated":
      return `Update Daintree on ${hostName} to read its SSH keys`;
    case "not-connected":
      return `Connect to ${hostName} to read its SSH keys`;
    case "failed":
      return outcome.message;
  }
}

function Fingerprints({ keys }: { keys: HostSshKey[] }) {
  return (
    <ul className="space-y-0.5 font-mono text-xs break-all text-text-primary">
      {keys.map((key) => (
        <li key={key.fingerprint}>
          {key.type} {key.fingerprint}
        </li>
      ))}
    </ul>
  );
}

function KeyRow({ sshKey, pinned }: { sshKey: HostSshKey; pinned: boolean }) {
  return (
    <SettingsRow
      label={sshKey.type}
      accessory={pinned ? <Badge>Pinned</Badge> : undefined}
      description={<span className="font-mono break-all">{sshKey.fingerprint}</span>}
      control={
        <SettingsRowActions>
          <CopyButton
            size="icon-sm"
            text={sshKey.fingerprint}
            aria-label={`Copy ${sshKey.type} fingerprint`}
          />
          <CopyButton
            size="icon-sm"
            text={sshKey.publicKey}
            aria-label={`Copy ${sshKey.type} public key`}
          />
        </SettingsRowActions>
      }
    />
  );
}

function ChangeRow({ baseline }: { baseline: HostSshListenerBaseline }) {
  if (!baseline.change) return null;
  return (
    <SettingsRow
      layout="stacked"
      label="Keys changed"
      description={`A reading ${formatRelativeTime(baseline.change.changedAt)} differed from the one before it. Check the change was expected before you trust the new keys anywhere`}
      control={
        <div className="space-y-2" data-testid="ssh-key-change">
          <div>
            <div className="text-xs text-text-secondary">Before</div>
            <Fingerprints keys={baseline.change.previous} />
          </div>
          <div>
            <div className="text-xs text-text-secondary">Now</div>
            <Fingerprints keys={baseline.keys} />
          </div>
        </div>
      }
    />
  );
}

/** A listener read just now, with what this device kept of it. */
function ListenerGroup({
  reading,
  baseline,
  pinnedFingerprint,
}: {
  reading: HostSshListenerReading;
  baseline: HostSshListenerBaseline | null;
  pinnedFingerprint: string | null;
}) {
  const gaps = reading.gaps.map((gap) => LISTENER_GAP_TEXT[gap] ?? gap);
  return (
    <SettingsGroup label={listenerLabel(reading)}>
      {baseline && <ChangeRow baseline={baseline} />}
      {reading.keys.map((key) => (
        <KeyRow key={key.fingerprint} sshKey={key} pinned={key.fingerprint === pinnedFingerprint} />
      ))}
      {reading.keyGaps.map((gap) => (
        <SettingsRow
          key={gap.publicKeyPath}
          label={<span className="font-mono break-all">{gap.publicKeyPath}</span>}
          labelText={gap.publicKeyPath}
          description={KEY_GAP_TEXT[gap.reason]}
        />
      ))}
      {reading.listenerId === null ? (
        <SettingsRow
          label="Not compared"
          description="This server can't be told apart from another one on the host, so its keys aren't kept or compared"
        />
      ) : (
        !reading.complete && (
          <SettingsRow
            layout="stacked"
            label="Partial reading"
            description={
              baseline
                ? `Not every key could be read${gaps.length > 0 ? `: ${gaps.join("; ")}` : ""}. The last complete reading, from ${formatRelativeTime(baseline.readAt)}, stays what the next one is compared with`
                : `Not every key could be read${gaps.length > 0 ? `: ${gaps.join("; ")}` : ""}. Nothing is kept to compare with until a complete reading`
            }
            control={baseline ? <Fingerprints keys={baseline.keys} /> : undefined}
          />
        )
      )}
    </SettingsGroup>
  );
}

/** A listener known only from what this device kept: not connected, or not seen this time. */
function KeptGroup({
  baseline,
  pinnedFingerprint,
}: {
  baseline: HostSshListenerBaseline;
  pinnedFingerprint: string | null;
}) {
  return (
    <SettingsGroup label={listenerLabel(baseline)}>
      <SettingsRow
        label="Last complete reading"
        description={`Read ${formatRelativeTime(baseline.readAt)}`}
      />
      <ChangeRow baseline={baseline} />
      {baseline.keys.map((key) => (
        <KeyRow key={key.fingerprint} sshKey={key} pinned={key.fingerprint === pinnedFingerprint} />
      ))}
    </SettingsGroup>
  );
}

/**
 * The SSH host keys a host reads on its own machine, the trust behind them,
 * and whether they changed since the last complete reading. Reading them
 * never changes a pin: trusting a new key stays the person's own step.
 */
export function HostSshKeysSection({
  hostId,
  hostName,
  connected,
  connectionKey,
  trust,
  pinnedFingerprint,
}: HostSshKeysSectionProps) {
  const [state, setState] = useState<{ key: string; keys: HostSshHostKeys } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  // Only the latest request lands: an older one settling late says nothing now.
  const requestRef = useRef(0);
  const requestKey = `${hostId}\n${connectionKey}`;

  const read = () => {
    const request = ++requestRef.current;
    setReading(true);
    remoteHostsClient.readSshHostKeys(hostId).then(
      (keys) => {
        if (request !== requestRef.current) return;
        setState({ key: requestKey, keys });
        setError(null);
        setReading(false);
      },
      (err: unknown) => {
        if (request !== requestRef.current) return;
        setError(clientErrorText(err, "Couldn't read SSH keys"));
        setReading(false);
      }
    );
  };

  const readOnChange = useEffectEvent(read);
  // Read again whenever the link comes up or the host is pointed elsewhere.
  useEffect(() => {
    readOnChange();
  }, [hostId, connectionKey, connected]);

  const result = state?.key === requestKey ? state.keys : null;
  const outcome = result?.outcome ?? null;
  const baselines = result?.baselines ?? [];
  const byId = new Map(baselines.map((baseline) => [baseline.listenerId, baseline]));
  const listeners = outcome?.status === "reading" ? outcome.listeners : [];
  const shownIds = new Set(listeners.map((listener) => listener.listenerId));
  const kept = baselines.filter((baseline) => !shownIds.has(baseline.listenerId));
  const status = outcome ? outcomeText(outcome, hostName) : null;

  return (
    <SettingsSection
      title="SSH host keys"
      description={`The keys ${hostName}'s SSH server presents, read by Daintree on the host as its own user`}
      action={
        <Button variant="outline" size="sm" onClick={read} disabled={!connected || reading}>
          <SpinningIcon icon={RefreshCw} active={reading} size={14} />
          Refresh
        </Button>
      }
    >
      <SettingsGroup>
        <SettingsRow label="Trust" description={trust} />
        {error !== null && (
          <SettingsRow
            label="Couldn't read SSH keys"
            description={<span role="alert">{error}</span>}
            control={
              <Button variant="outline" size="sm" onClick={read} disabled={!connected}>
                Retry
              </Button>
            }
          />
        )}
        {result === null
          ? error === null && <SettingsEmptyRow>Reading SSH keys…</SettingsEmptyRow>
          : status !== null && (
              <SettingsRow
                label={outcome?.status === "reading" ? "Some servers not shown" : "Not read"}
                description={<span data-testid="ssh-keys-status">{status}</span>}
              />
            )}
        {kept.length > 0 && outcome?.status !== "reading" && (
          <SettingsRow
            label="Showing what this computer kept"
            description="The last complete reading of each server, which the next reading is compared with"
          />
        )}
      </SettingsGroup>
      {listeners.map((listener, index) => (
        <ListenerGroup
          key={listener.listenerId ?? `unidentified-${index}`}
          reading={listener}
          baseline={listener.listenerId === null ? null : (byId.get(listener.listenerId) ?? null)}
          pinnedFingerprint={pinnedFingerprint}
        />
      ))}
      {kept.map((baseline) => (
        <KeptGroup
          key={baseline.listenerId}
          baseline={baseline}
          pinnedFingerprint={pinnedFingerprint}
        />
      ))}
    </SettingsSection>
  );
}
