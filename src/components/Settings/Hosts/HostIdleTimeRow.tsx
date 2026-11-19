import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  IDLE_TIME_COUNTED,
  durationLabel,
  idleClockSentence,
  idleEndSentence,
  type CloudProviderTerms,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import {
  DEFAULT_HOST_IDLE_MINUTES,
  HOST_IDLE_MINUTE_CHOICES,
  type HostIdleObservation,
} from "@shared/types/hostIdle";
import type {
  CloudKeepAwake,
  CloudLifetimeModel,
  CloudLinkedIdleStop,
} from "@shared/types/cloudHosts";
import type { HostSettingsSnapshot, HostSettingsUpdateResult } from "@shared/types/hostSettings";
import type { HostId } from "@shared/types/remoteHosts";
import { SettingsRow } from "../SettingsGroup";
import { SettingsSelect } from "../SettingsSelect";

const KEY = "hostIdle.idleAfterMinutes";
const LABEL = "Idle after";

interface IdleSetting {
  instanceId: string;
  /** Null when the host didn't answer for it. */
  leaf: { minutes: number; revision: string } | null;
  /** The host's Daintree is from before the setting. */
  unavailable: boolean;
}

function settingOf(snapshot: HostSettingsSnapshot): IdleSetting {
  const leaf = snapshot.settings.find((entry) => entry.key === KEY);
  return {
    instanceId: snapshot.instanceId,
    leaf:
      leaf && typeof leaf.value === "number"
        ? { minutes: leaf.value, revision: leaf.revision }
        : null,
    unavailable: snapshot.unavailable.includes(KEY),
  };
}

function outcomeError(result: HostSettingsUpdateResult): string | null {
  switch (result.outcome) {
    case "applied":
    case "unconfirmed":
      return null;
    case "conflict":
      return `This changed on ${result.hostName} since it was read. Its current value is shown.`;
    case "not-applied":
      return `${result.hostName} didn't make the change.`;
  }
}

interface HostIdleTimeRowProps {
  hostId: HostId;
  hostName: string;
  connected: boolean;
  /**
   * From the host's latest summary on the current link; absent from a host
   * that doesn't report it, and while no summary has come on this link.
   */
  idle: HostIdleObservation | undefined;
  /** When that summary was taken, by the host's clock. */
  sampledAt: number | null;
  /** Why the machine can't stop itself once idle, as this device found; null when nothing stands in the way. */
  selfStopProblem?: string | null;
  /** What this device does once the idle time ends while it's linked, for a plugin provider's machine (#17923). */
  linkedIdleStop?: CloudLinkedIdleStop | null;
  /** The machine's provider; null while it isn't registered, which leaves what the idle time does unknown. */
  provider?: CloudProviderTerms | null;
  /** The machine's own idle sleep, as its provider last reported it, for a provider that has one. */
  lifetime?: CloudLifetimeModel | null;
  /** The machine's own idle timeout follows the host's idle time (#17916). */
  idleTimeFollowsHost?: boolean;
  /** What the host holds the machine awake with while it sees work, with no device connected (#17918). */
  keepAwake?: CloudKeepAwake | null;
}

/**
 * A cloud host's idle time (#17357): kept on the host, which judges its own
 * idleness, so it is read from and written to the host, against the revision
 * read. Keyed by host, so a reply for another host never lands here.
 */
export function HostIdleTimeRow({
  hostId,
  hostName,
  connected,
  idle,
  sampledAt,
  selfStopProblem = null,
  linkedIdleStop = null,
  provider = null,
  lifetime = null,
  idleTimeFollowsHost = false,
  keepAwake = null,
}: HostIdleTimeRowProps) {
  const [setting, setSetting] = useState<IdleSetting | null>(null);
  // Read since the link last came up: an older reading is shown, not edited against.
  const [fresh, setFresh] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts link drops: a reply to a read or change sent before one is dropped,
  // or it would make an old reading editable on the next connect.
  const linkEpoch = useRef(0);

  const load = useCallback((): Promise<boolean> => {
    const epoch = linkEpoch.current;
    return window.electron.hostSettings.read({ hostId, keys: [KEY] }).then(
      (snapshot) => {
        if (linkEpoch.current !== epoch) return false;
        setSetting(settingOf(snapshot));
        setFresh(true);
        setLoadError(null);
        // Said of a value no longer shown; a change's own outcome is set after this.
        setError(null);
        return true;
      },
      (err: unknown) => {
        if (linkEpoch.current !== epoch) return false;
        // A host from before the setting refuses a read naming only it.
        if (clientErrorCode(err) === "UNSUPPORTED") {
          setSetting({ instanceId: "", leaf: null, unavailable: true });
          setLoadError(null);
          return false;
        }
        setLoadError(clientErrorText(err, `Couldn't read the idle time on ${hostName}`));
        return false;
      }
    );
  }, [hostId, hostName]);

  useEffect(() => {
    if (connected) {
      void load();
      return undefined;
    }
    linkEpoch.current += 1;
    setFresh(false);
    return undefined;
  }, [connected, load]);

  const retry = () => {
    setLoadError(null);
    void load();
  };

  // What its idle time ending does to the machine; the host's word that it stops it settles it.
  const consequence = idleEndSentence(idle, provider, selfStopProblem, linkedIdleStop, {
    connected,
    lifetime,
    followsHost: idleTimeFollowsHost,
    keepAwake,
  });
  const withConsequence = (text: string) =>
    consequence ? `${/[.!?]$/.test(text) ? text : `${text}.`} ${consequence}` : text;

  // What the host's latest summary says of its clock, whether or not the setting could be read:
  // a confirmed self-stop shows there too.
  const clock = connected && idle ? idleClockSentence(idle, sampledAt) : IDLE_TIME_COUNTED;

  if (setting?.unavailable) {
    return (
      <SettingsRow
        label={LABEL}
        description={withConsequence(clock)}
        disabled
        disabledReason={`Needs a newer Daintree on ${hostName}`}
      />
    );
  }

  const leaf = setting?.leaf ?? null;
  // A read that failed since the link came up leaves nothing to edit against.
  const readFailed = connected && !fresh && loadError !== null;
  if (setting === null || leaf === null || readFailed) {
    return (
      <SettingsRow
        label={LABEL}
        description={withConsequence(
          connected ? clock : `Kept on ${hostName}. Connect to see or change it`
        )}
        error={loadError ? <span role="alert">{loadError}</span> : undefined}
        control={
          connected && loadError ? (
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }

  const live = connected && fresh;

  const save = (value: string) => {
    const minutes = Number(value);
    if (!live || saving || minutes === leaf.minutes) return;
    const instanceId = setting.instanceId;
    const epoch = linkEpoch.current;
    setSaving(true);
    setError(null);
    window.electron.hostSettings
      .update({
        hostId,
        patch: { "hostIdle.idleAfterMinutes": minutes },
        expect: { instanceId, revisions: { [KEY]: leaf.revision } },
      })
      .then(
        (result) => {
          if (linkEpoch.current !== epoch) {
            setSaving(false);
            return undefined;
          }
          const said = outcomeError(result);
          // Unconfirmed, or answered by a host that restarted since it was read:
          // what it holds now is read again before anything is edited against it.
          if (result.outcome === "unconfirmed" || result.instanceId !== instanceId) {
            setFresh(false);
            return load().then((verified) => {
              if (linkEpoch.current !== epoch) {
                setSaving(false);
                return;
              }
              if (result.outcome === "unconfirmed") {
                setError(
                  verified
                    ? `${result.hostName} didn't confirm the change. Its current value is shown.`
                    : `${result.hostName} didn't confirm the change, and its current value couldn't be read.`
                );
              } else {
                setError(said);
              }
              setSaving(false);
            });
          }
          const answered = result.settings.find((entry) => entry.key === KEY);
          if (answered && typeof answered.value === "number") {
            const next = { minutes: answered.value, revision: answered.revision };
            setSetting((current) =>
              current && current.instanceId === instanceId ? { ...current, leaf: next } : current
            );
          }
          setError(said);
          setSaving(false);
          return undefined;
        },
        (err: unknown) => {
          if (linkEpoch.current === epoch) {
            setError(clientErrorText(err, "Couldn't change the idle time"));
          }
          setSaving(false);
        }
      );
  };

  const options = [
    // A value set some other way, or by a later build, is shown as it is.
    ...(HOST_IDLE_MINUTE_CHOICES.includes(leaf.minutes)
      ? []
      : [{ value: String(leaf.minutes), label: durationLabel(leaf.minutes * 60), disabled: true }]),
    ...HOST_IDLE_MINUTE_CHOICES.map((minutes) => ({
      value: String(minutes),
      label: durationLabel(minutes * 60),
      isDefault: minutes === DEFAULT_HOST_IDLE_MINUTES,
    })),
  ];

  return (
    <SettingsSelect
      label={LABEL}
      description={withConsequence(
        connected ? clock : `Kept on ${hostName}, as last read. Connect to change it`
      )}
      value={String(leaf.minutes)}
      onValueChange={save}
      options={options}
      disabled={!live || saving}
      error={error ?? undefined}
    />
  );
}
