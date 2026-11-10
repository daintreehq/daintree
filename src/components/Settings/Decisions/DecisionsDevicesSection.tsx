import { useEffect, useEffectEvent, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SeverityMark } from "@/lib/statusSeverity";
import type { DecisionsDevice } from "@shared/types/decisions";
import { DecisionsPairingDialog } from "./DecisionsPairingDialog";
import { deviceKind, deviceRoleLabel } from "./devicesCopy";
import type { UseDecisionsDevicesResult } from "./useDecisionsDevices";
import type { DecisionsRevokeTarget } from "./useDecisionsKeyActions";
import {
  currentPairButton,
  DEVICES_SECTION_ID,
  landOnPairPhone,
  PAIR_BUTTON_ATTR,
} from "./pairPhoneLanding";

/** Role, when it was last seen, and whether the relay can notify it: what the relay observed. */
function DeviceFacts({ device }: { device: DecisionsDevice }) {
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-x-1">
        <span>{deviceRoleLabel(device.role)}</span>
        <FactSeparator />
        {device.lastSeenAt ? (
          <TimeAgo timestamp={device.lastSeenAt} verbose prefix="Seen " />
        ) : (
          <span>Not seen since pairing</span>
        )}
        <FactSeparator />
        {device.pushEnabled ? (
          <span>Notifications on</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-text-primary">
            <SeverityMark severity="warning" label="Warning" className="h-3.5 w-3.5" decorative />
            No notifications
          </span>
        )}
      </span>
      {!device.pushEnabled && (
        <span className="mt-1 block">
          To get notified, open Decisions on it and turn notifications on. iPhone and iPad deliver
          them only to the Home Screen app.
        </span>
      )}
    </>
  );
}

/**
 * Devices (#16009): the phones and tablets a person answers from, as the
 * relay lists them and their owner-signed certificates verify, and "Pair a
 * phone". Each can be revoked after a confirmation (#16010). Remote Hosts
 * share the relay's list but have their own section (#16222), so header,
 * empty state and rows here count only what answers.
 */
export function DecisionsDevicesSection({
  relaySetUp,
  read,
  locked = false,
  actionsLocked = false,
  onRevoke,
  pairFocusRequest = 0,
  onPairFocused,
}: {
  relaySetUp: boolean;
  /** The relay's device list, every role; this section shows the ones a person answers from. */
  read: UseDecisionsDevicesResult;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
  /** Nothing may change the key now: the switch is changing, or a key change is running. */
  actionsLocked?: boolean;
  onRevoke: (target: DecisionsRevokeTarget) => void;
  /** Above zero, and bumped, to land on Pair a phone once it shows (#16200). */
  pairFocusRequest?: number;
  /** The request was met, so a later mount doesn't take focus again. */
  onPairFocused?: () => void;
}) {
  const { devices, failure, loading, reload } = read;
  // Pair a phone shows only once the devices are read, so a request waits for it.
  const landOnPair = useEffectEvent(() => {
    const button = currentPairButton();
    if (!button) return;
    landOnPairPhone();
    if (document.activeElement === button) onPairFocused?.();
  });
  useEffect(() => {
    if (pairFocusRequest > 0) landOnPair();
  }, [pairFocusRequest, relaySetUp, devices, failure]);
  const [pairingOpen, setPairingOpen] = useState(false);

  const answering =
    devices === null ? null : devices.filter((device) => deviceKind(device.role) === "answers");

  const pairButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={locked}
      onClick={() => setPairingOpen(true)}
      {...{ [PAIR_BUTTON_ATTR]: "" }}
    >
      <Plus />
      Pair a phone
    </Button>
  );

  const listed = answering !== null && answering.length > 0;
  const headerActions = listed ? (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              if (!loading) reload();
            }}
            // Busy, not unavailable: the rotating glyph says so, and the button keeps focus.
            aria-busy={loading || undefined}
            aria-disabled={loading || undefined}
            aria-label="Refresh devices"
          >
            <SpinningIcon icon={RefreshCw} active={loading} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Refresh devices</TooltipContent>
      </Tooltip>
      {pairButton}
    </>
  ) : undefined;

  let content: React.ReactNode;
  if (!relaySetUp) {
    content = (
      <SettingsGroup>
        <SettingsEmptyRow>Connect a relay above, then pair a phone here</SettingsEmptyRow>
      </SettingsGroup>
    );
  } else if (answering === null && failure) {
    content = (
      <SettingsLoadErrorBanner
        title="Couldn't read the paired devices"
        message={failure}
        onRetry={reload}
      />
    );
  } else if (answering === null) {
    content = (
      <SettingsGroup>
        <div className="space-y-2 py-3.5 pr-4 pl-4" aria-hidden="true">
          <SkeletonBone className="h-3.5 w-32" />
          <SkeletonBone className="h-3 w-64" />
        </div>
      </SettingsGroup>
    );
  } else {
    // A refresh that failed keeps the rows it had; the failure sits above them,
    // the same banner a failed first read shows, so the list still reads as the list.
    content = (
      <>
        {failure && (
          <SettingsLoadErrorBanner
            title="Couldn't refresh the paired devices"
            message={`${failure} The list below is from the last read.`}
            onRetry={reload}
          />
        )}
        <SettingsGroup>
          {answering.length === 0 ? (
            <SettingsEmptyRow action={pairButton}>
              Pair a phone to answer your agents&apos; questions from it
            </SettingsEmptyRow>
          ) : (
            answering.map((device) => (
              <SettingsRow
                key={device.deviceId}
                id={`decisions-device-${device.deviceId}`}
                label={device.label}
                description={<DeviceFacts device={device} />}
                disabled={actionsLocked}
                control={({ descriptionId, disabled }) => (
                  <Button
                    type="button"
                    variant="ghost-danger"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Revoke ${device.label}`}
                    aria-describedby={descriptionId}
                    onClick={() => onRevoke(device)}
                  >
                    Revoke
                  </Button>
                )}
              />
            ))
          )}
        </SettingsGroup>
      </>
    );
  }

  return (
    <SettingsSection
      title="Devices"
      description="Each phone or tablet you pair can read and answer every question your agents ask"
      id={DEVICES_SECTION_ID}
      action={headerActions}
    >
      {content}
      <DecisionsPairingDialog
        isOpen={pairingOpen}
        onClose={() => {
          setPairingOpen(false);
          reload();
        }}
        onPaired={reload}
        restoreFocusTo={currentPairButton}
      />
    </SettingsSection>
  );
}
