import type { DecisionsRelayCheck, DecisionsStatus } from "@shared/types/decisions";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { deviceKind } from "./devicesCopy";
import type { UseDecisionsDevicesResult } from "./useDecisionsDevices";
import { useDecisionsSwitch } from "./useDecisionsSwitch";

const WHAT_SHOWS = "questions, follow-ups that want a reply and answers that couldn't be typed in";

/**
 * What keeps agent-stopped pushes from reaching a phone, as last observed:
 * the relay's latest list of devices has no phone or tablet with
 * notifications on, or the latest check of the relay set up here found it
 * doesn't advertise them. Unread, failed or another relay's reads say nothing.
 */
export function agentStoppedPushesNote(
  status: DecisionsStatus,
  relayCheck: DecisionsRelayCheck | null,
  devices: UseDecisionsDevicesResult
): string | undefined {
  const notes: string[] = [];
  if (
    devices.devices !== null &&
    devices.failure === null &&
    !devices.devices.some((device) => deviceKind(device.role) === "answers" && device.pushEnabled)
  ) {
    notes.push("No paired phone or tablet has notifications turned on, so none can reach one.");
  }
  if (
    relayCheck !== null &&
    "advertisesAgentStoppedPushes" in relayCheck &&
    relayCheck.origin === status.relayOrigin &&
    !relayCheck.advertisesAgentStoppedPushes
  ) {
    notes.push("Your relay doesn't advertise support for them, so it can't send them.");
  }
  return notes.length > 0 ? notes.join(" ") : undefined;
}

interface DecisionsNotificationsSectionProps {
  status: DecisionsStatus;
  /** The latest check of a relay, from Connection; only one of the relay set up here counts. */
  relayCheck: DecisionsRelayCheck | null;
  /** The relay's devices, as Devices reads them. */
  devices: UseDecisionsDevicesResult;
  /** The Decisions switch is changing, so nothing behind it is. */
  locked: boolean;
  /** A status main answered a change with, or null to read it again. */
  onChanged: (next: DecisionsStatus | null) => void;
}

/**
 * Notifications (#18061): how Decisions' desktop notifications follow
 * Settings → Notifications (#17232), whether a new question's phone push
 * waits while the person is here (#17240), which only holds while desktop
 * notifications can show it here, and whether the phone hears when an agent
 * stops while they're away (#17319), with what keeps that from reaching one.
 */
export function DecisionsNotificationsSection({
  status,
  relayCheck,
  devices,
  locked,
  onChanged,
}: DecisionsNotificationsSectionProps) {
  const desktopOff = status.desktopNotifications === false;
  const hold = useDecisionsSwitch(
    status.holdPhonePushes !== false,
    (enabled) => window.electron.decisions.setHoldPhonePushes(enabled),
    onChanged
  );
  const holdLocked = locked || hold.saving;
  const holdFailure = hold.failure;
  const stopped = useDecisionsSwitch(
    status.agentStoppedPushes === true,
    (enabled) => window.electron.decisions.setAgentStoppedPushes(enabled),
    onChanged
  );
  const stoppedLocked = locked || stopped.saving;
  const stoppedFailure = stopped.failure;
  const openNotificationSettings = () => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "notifications" },
      { source: "user" }
    );
  };
  return (
    <SettingsSection title="Notifications" id="decisions-notifications">
      <SettingsGroup>
        <SettingsRow
          id="decisions-desktop-notifications"
          label="Desktop notifications"
          description={
            desktopOff
              ? `Off in Settings → Notifications: ${WHAT_SHOWS} don't show on this computer`
              : `On in Settings → Notifications: ${WHAT_SHOWS} show on this computer, unless a project turns its own off`
          }
          control={({ descriptionId }) => (
            <Button
              variant="outline"
              size="sm"
              aria-describedby={descriptionId}
              onClick={openNotificationSettings}
              data-testid="decisions-open-notification-settings"
            >
              Open notification settings
            </Button>
          )}
        />
        <SettingsDependents
          disabled={desktopOff}
          reason="Nothing is held while desktop notifications are off: your relay notifies your phone of a new question at once"
        >
          <SettingsSwitchCard
            id="decisions-hold-phone-pushes"
            title="Hold phone notifications while I'm at this computer"
            subtitle="While desktop notifications are on, tells your relay whether you're here, so it waits up to two minutes before notifying your phone of a new question"
            isEnabled={hold.enabled}
            onChange={() => {
              if (!holdLocked) void hold.set(!hold.enabled);
            }}
            disabled={holdLocked}
            isModified={status.holdPhonePushes === false}
            onReset={() => {
              if (!holdLocked) void hold.set(true);
            }}
            resetAriaLabel="Hold phone notifications again"
          />
        </SettingsDependents>
        <SettingsSwitchCard
          id="decisions-agent-stopped-pushes"
          title="Notify my phone when an agent stops"
          subtitle="While you're away and outside quiet hours, your relay tells your phone only that an agent stopped, never which one. That covers this computer and the Remote Hosts it's connected to: one with a project open here, or with its notifications turned on."
          note={agentStoppedPushesNote(status, relayCheck, devices)}
          isEnabled={stopped.enabled}
          onChange={() => {
            if (!stoppedLocked) void stopped.set(!stopped.enabled);
          }}
          disabled={stoppedLocked}
          isModified={status.agentStoppedPushes === true}
          onReset={() => {
            if (!stoppedLocked) void stopped.set(false);
          }}
          resetAriaLabel="Stop notifying my phone when an agent stops"
        />
      </SettingsGroup>
      {holdFailure && (
        <SettingsLoadErrorBanner
          title={
            holdFailure.enabled
              ? "Couldn't turn on holding phone notifications"
              : "Couldn't turn off holding phone notifications"
          }
          message={holdFailure.message}
          onRetry={() => {
            if (!holdLocked) void hold.set(holdFailure.enabled);
          }}
        />
      )}
      {stoppedFailure && (
        <SettingsLoadErrorBanner
          title={
            stoppedFailure.enabled
              ? "Couldn't turn on phone notifications when an agent stops"
              : "Couldn't turn off phone notifications when an agent stops"
          }
          message={stoppedFailure.message}
          onRetry={() => {
            if (!stoppedLocked) void stopped.set(stoppedFailure.enabled);
          }}
        />
      )}
    </SettingsSection>
  );
}
