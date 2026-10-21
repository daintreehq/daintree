import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyableCommand } from "@/components/Setup/CopyableCommand";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { SettingsNumberInput } from "@/components/Settings/SettingsNumberInput";
import {
  SettingsDependents,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsInlineError,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useDeviceAnswer } from "@/hooks/useDeviceAnswer";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import type { PairedDevice } from "@shared/types/ipc/deviceAnswer";

const DEFAULT_PORT = 7421;
const RECENT_ANSWERS_SHOWN = 8;
const COUNTDOWN_TICK_MS = 1000;

/** Seconds left on the open pairing code, ticking only while one is open. */
function useSecondsLeft(expiresAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (expiresAt === null) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * "Answer from another device": the switch that serves this machine's waiting
 * agents to a phone or another computer through the user's own tunnel, the
 * pairing step that is the consent moment, and the devices paired so far.
 */
export default function DeviceAnswerGroup() {
  const device = useDeviceAnswer();
  const { status } = device;
  const enabled = status?.enabled ?? false;
  const port = status?.port ?? DEFAULT_PORT;
  const locked = status === null || device.busy;
  const pairing = status?.pairing ?? null;
  const secondsLeft = useSecondsLeft(pairing?.expiresAt ?? null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PairedDevice | null>(null);

  const commitPort = () => {
    if (portDraft === null) return;
    const next = Number(portDraft);
    setPortDraft(null);
    if (next === port) return;
    void device.setEnabled({ enabled, port: next });
  };
  const commitHost = () => {
    if (hostDraft === null) return;
    const next = hostDraft.trim();
    setHostDraft(null);
    if (next === (status?.tailnetHost ?? "")) return;
    void device.setEnabled({ enabled, tailnetHost: next === "" ? null : next });
  };

  const tailnetHost = status?.tailnetHost ?? null;
  const devices = status?.devices ?? [];
  const answers = (status?.recentAnswers ?? []).slice(0, RECENT_ANSWERS_SHOWN);

  return (
    <SettingsSection
      title="Answer from another device"
      description="Pick the options your waiting agents show from a phone or another computer, through your own Tailscale or SSH"
      id="device-answer"
    >
      {status === null && device.loadError !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't read whether devices can answer"
          message={device.loadError}
          onRetry={() => void device.reload()}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          title="Allow paired devices to answer"
          subtitle="Serves one page on 127.0.0.1 only. Nothing is reachable from another device until you open a tunnel to it and pair"
          isEnabled={enabled}
          onChange={() => void device.setEnabled({ enabled: !enabled })}
          disabled={locked}
        />
        <SettingsDependents disabled={!enabled} reason="Turn it on to pair a device">
          <SettingsNumberInput
            label="Port"
            rowId="device-answer-port"
            description={`Default: ${DEFAULT_PORT}. The page listens on this machine's loopback address only`}
            min={1024}
            max={65535}
            value={portDraft ?? String(port)}
            onChange={(event) => setPortDraft(event.target.value)}
            onBlur={commitPort}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPort();
            }}
            disabled={locked || !enabled}
            error={enabled && status?.error ? status.error : undefined}
          />
          <SettingsInput
            label="Tailnet name"
            rowId="device-answer-tailnet-host"
            description="The name tailscale serve gives this machine, like mac.tail1234.ts.net. Leave empty if you only use an SSH tunnel"
            layout="inline"
            controlWidth="wide"
            placeholder="mac.tail1234.ts.net"
            spellCheck={false}
            value={hostDraft ?? tailnetHost ?? ""}
            onChange={(event) => setHostDraft(event.target.value)}
            onBlur={commitHost}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitHost();
            }}
            disabled={locked || !enabled}
          />
          <SettingsRow
            label="Open a tunnel"
            layout="stacked"
            id="device-answer-tunnel"
            description={
              <>
                Run one of these on this machine, then open the address on your device.
                <span className="mt-2 block">
                  <CopyableCommand command={`tailscale serve --bg ${port}`} wrap />
                </span>
                <span className="mt-2 block">
                  Over SSH, from the device: forward port {port} to this machine, then open
                  http://localhost:{port}
                </span>
                <span className="mt-2 block">
                  <CopyableCommand
                    command={`ssh -L ${port}:127.0.0.1:${port} <this machine>`}
                    wrap
                  />
                </span>
              </>
            }
          />
          <SettingsRow
            label="Pair a device"
            layout="stacked"
            id="device-answer-pair"
            description="A paired device sees the screens of agents waiting in every project, parked and snoozed ones included, and can pick the options those screens show. It can't type, start agents or read anything else. Each answer is recorded with the device's name"
            control={({ disabled }) =>
              pairing && secondsLeft !== null && secondsLeft > 0 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className="font-mono text-base tracking-widest text-text-primary select-text"
                    aria-label={`Pairing code ${pairing.code}`}
                  >
                    {pairing.code}
                  </span>
                  <span className="text-xs text-text-secondary" aria-live="polite">
                    Expires in {formatCountdown(secondsLeft)}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || locked}
                    onClick={() => void device.cancelPairingCode()}
                  >
                    Cancel code
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || locked || !status?.listening}
                  onClick={() => void device.createPairingCode()}
                >
                  Show pairing code
                </Button>
              )
            }
          />
        </SettingsDependents>
      </SettingsGroup>
      {device.actionError && (
        <SettingsInlineError role="alert">{device.actionError}</SettingsInlineError>
      )}

      <SettingsGroup label="Paired devices">
        {devices.length === 0 ? (
          <SettingsEmptyRow>Pair a device to answer from it</SettingsEmptyRow>
        ) : (
          devices.map((paired) => (
            <SettingsRow
              key={paired.id}
              label={paired.name}
              description={`Paired ${formatRelativeTime(paired.pairedAt)}${
                paired.lastSeenAt ? ` · Last seen ${formatRelativeTime(paired.lastSeenAt)}` : ""
              }`}
              control={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost-danger"
                      size="icon-sm"
                      aria-label={`Remove ${paired.name}`}
                      disabled={locked}
                      onClick={() => setRemoveTarget(paired)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Remove device</TooltipContent>
                </Tooltip>
              }
            />
          ))
        )}
      </SettingsGroup>

      {answers.length > 0 && (
        <SettingsGroup label="Recent answers">
          {answers.map((answer) => (
            <SettingsRow
              key={`${answer.at}-${answer.deviceId}-${answer.runId}`}
              label={`${answer.deviceName} picked “${answer.label}”`}
              description={`${formatRelativeTime(answer.at)}${
                answer.outcome === "refused" && answer.reason ? ` · ${answer.reason}` : ""
              }`}
            />
          ))}
        </SettingsGroup>
      )}

      <ConfirmDialog
        isOpen={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        variant="destructive"
        title={`Remove '${removeTarget?.name ?? "device"}'?`}
        description="It can no longer see this machine's waiting agents or answer them. To use it again, pair it with a new code."
        confirmLabel="Remove device"
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (target) void device.revokeDevice(target.id);
        }}
      />
    </SettingsSection>
  );
}

export { DeviceAnswerGroup };
