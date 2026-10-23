import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { getAgentConfig } from "@shared/config/agentRegistry";
import {
  IDLE_THRESHOLD_MINUTES,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsSnapshot,
  type HostSettingsUpdateResult,
} from "@shared/types/hostSettings";
import { CANOPY_REDACTION, CANOPY_SENDS } from "@/components/Canopy/canopyTerms";
import { clientErrorText } from "@/utils/clientAppError";
import { SettingsSection } from "../SettingsSection";
import { SettingsDependents, SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsNumberInput } from "../SettingsNumberInput";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsSwitch } from "../SettingsSwitch";

interface HostSettingsSectionProps {
  hostId: string;
  hostName: string;
  connected: boolean;
}

const NO_DEFAULT = "__none__";

const AGENT_OPTIONS = [
  { value: NO_DEFAULT, label: "None" },
  ...BUILT_IN_AGENT_IDS.map((id) => ({ value: id, label: getAgentConfig(id)?.name ?? id })),
];

function outcomeError(result: HostSettingsUpdateResult): string | null {
  switch (result.outcome) {
    case "applied":
      return null;
    case "conflict":
      return `This changed on ${result.hostName} since it was read. Its current value is shown.`;
    case "not-applied":
      return `${result.hostName} didn't make the change.`;
    case "unconfirmed":
      return `${result.hostName} didn't confirm the change. Refresh to see what it has now.`;
  }
}

/**
 * The host's own settings, read from it and changed on it by name (#14167):
 * no window or project there is needed, and nothing here changes this
 * computer. Each change is made against the value shown, so one made on the
 * host meanwhile is reported, never written over.
 */
export function HostSettingsSection({ hostId, hostName, connected }: HostSettingsSectionProps) {
  const [snapshot, setSnapshot] = useState<HostSettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: HostSettingKey; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCanopy, setConfirmCanopy] = useState(false);
  const [threshold, setThreshold] = useState("");
  // A read for a host this section no longer shows is dropped.
  const shownHost = useRef(hostId);
  shownHost.current = hostId;

  const load = useCallback(() => {
    const asked = hostId;
    window.electron.hostSettings.read({ hostId }).then(
      (next) => {
        if (shownHost.current !== asked) return;
        setSnapshot(next);
        setLoadError(null);
      },
      (err: unknown) => {
        if (shownHost.current !== asked) return;
        setLoadError(clientErrorText(err, `Couldn't read settings on ${hostName}`));
      }
    );
  }, [hostId, hostName]);

  useEffect(() => {
    setSnapshot(null);
    setRowError(null);
    if (connected) load();
  }, [connected, load]);

  const valueOf = (key: HostSettingKey): HostSettingValue | undefined =>
    snapshot?.settings.find((leaf) => leaf.key === key)?.value;

  useEffect(() => {
    const value = snapshot?.settings.find(
      (leaf) => leaf.key === "idleTerminalNotify.thresholdMinutes"
    )?.value;
    if (typeof value === "number") setThreshold(String(value));
  }, [snapshot]);

  /** One change, made against the revision shown; the host's answer replaces what is shown. */
  const change = async (key: HostSettingKey, value: HostSettingValue): Promise<boolean> => {
    const leaf = snapshot?.settings.find((candidate) => candidate.key === key);
    if (!snapshot || !leaf) return false;
    setBusy(true);
    setRowError(null);
    try {
      const result = await window.electron.hostSettings.update({
        hostId,
        patch: { [key]: value },
        expect: { instanceId: snapshot.instanceId, revisions: { [key]: leaf.revision } },
      });
      if (shownHost.current !== hostId) return false;
      const error = outcomeError(result);
      if (error) setRowError({ key, text: error });
      if (result.outcome === "unconfirmed" || result.instanceId !== snapshot.instanceId) {
        load();
      } else {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                settings: current.settings.map(
                  (old) => result.settings.find((fresh) => fresh.key === old.key) ?? old
                ),
              }
            : current
        );
      }
      return result.outcome === "applied";
    } catch (err) {
      if (shownHost.current === hostId) {
        setRowError({ key, text: clientErrorText(err, `Couldn't change this on ${hostName}`) });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const canopy = valueOf("canopyMode");
  const canopyHidden = canopy === "hidden";
  const canopyOn = canopy === "on";

  const commitThreshold = () => {
    const minutes = Number(threshold);
    const current = valueOf("idleTerminalNotify.thresholdMinutes");
    if (
      !Number.isInteger(minutes) ||
      minutes < IDLE_THRESHOLD_MINUTES.min ||
      minutes > IDLE_THRESHOLD_MINUTES.max
    ) {
      setRowError({
        key: "idleTerminalNotify.thresholdMinutes",
        text: `Enter ${IDLE_THRESHOLD_MINUTES.min} to ${IDLE_THRESHOLD_MINUTES.max} minutes.`,
      });
      if (typeof current === "number") setThreshold(String(current));
      return;
    }
    if (minutes !== current) void change("idleTerminalNotify.thresholdMinutes", minutes);
  };

  const errorFor = (key: HostSettingKey) => (rowError?.key === key ? rowError.text : undefined);
  const defaultAgent = valueOf("agentDefaults.defaultAgent");
  const idleOn = valueOf("idleTerminalNotify.enabled") === true;

  return (
    <SettingsSection
      title={`Settings on ${hostName}`}
      description={`Changed on ${hostName} itself, for everyone using it. Nothing here changes this computer`}
    >
      <SettingsGroup>
        {!connected ? (
          <SettingsEmptyRow>Connect to {hostName} to see and change its settings</SettingsEmptyRow>
        ) : loadError ? (
          <SettingsRow
            label={`Couldn't read ${hostName}'s settings`}
            error={loadError}
            control={
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            }
          />
        ) : snapshot === null ? (
          <SettingsEmptyRow>Reading {hostName}'s settings…</SettingsEmptyRow>
        ) : (
          <>
            <SettingsRow
              label="Show Canopy"
              description={`Its toolbar button, shortcut and command palette entry on ${hostName}. Hiding it also stops reading`}
              error={errorFor("canopyMode")}
              disabled={busy}
              control={({ labelId, descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={!canopyHidden}
                  onCheckedChange={(show) => void change("canopyMode", show ? "unset" : "hidden")}
                  disabled={disabled}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                />
              )}
            />
            <SettingsDependents disabled={canopyHidden} reason="Show Canopy to turn it on">
              <SettingsRow
                label="Read agent terminals"
                description={`When off, nothing leaves ${hostName} and Canopy deletes its readings there`}
                disabled={busy}
                control={({ labelId, descriptionId, disabled }) => (
                  <SettingsSwitch
                    checked={canopyOn}
                    onCheckedChange={(on) =>
                      on ? setConfirmCanopy(true) : void change("canopyMode", "unset")
                    }
                    disabled={disabled}
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                  />
                )}
              />
            </SettingsDependents>
            <SettingsSelect
              label="Default agent"
              description={`The agent new terminals on ${hostName} start with`}
              value={typeof defaultAgent === "string" ? defaultAgent : NO_DEFAULT}
              onValueChange={(next) =>
                void change("agentDefaults.defaultAgent", next === NO_DEFAULT ? null : next)
              }
              options={AGENT_OPTIONS}
              disabled={busy}
              error={errorFor("agentDefaults.defaultAgent")}
            />
            <SettingsRow
              label="Alert about idle terminals"
              description={`${hostName} tells you about terminals left idle`}
              error={errorFor("idleTerminalNotify.enabled")}
              disabled={busy}
              control={({ labelId, descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={idleOn}
                  onCheckedChange={(next) => void change("idleTerminalNotify.enabled", next)}
                  disabled={disabled}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                />
              )}
            />
            <SettingsDependents
              disabled={!idleOn}
              reason="Turn on idle alerts to set when they come"
            >
              <SettingsNumberInput
                label="Alert after"
                description={`Minutes, ${IDLE_THRESHOLD_MINUTES.min} to ${IDLE_THRESHOLD_MINUTES.max}`}
                suffix="min"
                min={IDLE_THRESHOLD_MINUTES.min}
                max={IDLE_THRESHOLD_MINUTES.max}
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
                onBlur={commitThreshold}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitThreshold();
                }}
                disabled={busy}
                error={errorFor("idleTerminalNotify.thresholdMinutes")}
              />
            </SettingsDependents>
          </>
        )}
      </SettingsGroup>

      <ConfirmDialog
        isOpen={confirmCanopy}
        onClose={() => setConfirmCanopy(false)}
        variant="default"
        title={`Turn Canopy on for '${hostName}'?`}
        description={`Canopy on ${hostName} reads that machine's agent terminals until it's turned off there or here. ${CANOPY_SENDS} ${CANOPY_REDACTION}`}
        confirmLabel="Turn Canopy on"
        onConfirm={() => {
          setConfirmCanopy(false);
          void change("canopyMode", "on");
        }}
      />
    </SettingsSection>
  );
}
