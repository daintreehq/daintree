import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SeverityMark } from "@/lib/statusSeverity";
import type { DecisionsDevice, DecisionsStatus } from "@shared/types/decisions";
import { DecisionsPairingDialog } from "./DecisionsPairingDialog";
import { deviceRoleLabel } from "./devicesCopy";
import { useDecisionsDevices } from "./useDecisionsDevices";

const SECTION_ID = "decisions-devices";
const PAIR_BUTTON_ATTR = "data-decisions-pair-phone";

/** The Pair a phone button on screen now: the empty row's, or the header's once a device is listed. */
function currentPairButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${SECTION_ID} [${PAIR_BUTTON_ATTR}]`);
}

/** Role, when it was last seen, and whether the relay can notify it: what the relay observed. */
function DeviceFacts({ device }: { device: DecisionsDevice }) {
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-x-1">
        <span>{deviceRoleLabel(device.role)}</span>
        <span aria-hidden="true">·</span>
        {device.lastSeenAt ? (
          <TimeAgo timestamp={device.lastSeenAt} verbose prefix="Seen " />
        ) : (
          <span>Not seen since pairing</span>
        )}
        <span aria-hidden="true">·</span>
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
 * Devices (#16009): the phones and Hosts paired with this computer's relay
 * identity, as the relay lists them and their owner-signed certificates
 * verify, and "Pair a phone". The list is read again on Refresh, after a
 * pairing, and when the window regains focus. Revoking (#16010) and enrolled
 * Hosts (#16021) add to the same list.
 */
export function DecisionsDevicesSection({
  status,
  locked = false,
}: {
  status: DecisionsStatus;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
}) {
  const relaySetUp = status.relayOrigin !== undefined;
  const { devices, failure, loading, reload } = useDecisionsDevices(relaySetUp);
  const [pairingOpen, setPairingOpen] = useState(false);

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

  const listed = devices !== null && devices.length > 0;
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
  } else if (devices === null && failure) {
    content = (
      <SettingsLoadErrorBanner
        title="Couldn't read the paired devices"
        message={failure}
        onRetry={reload}
      />
    );
  } else if (devices === null) {
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
          {devices.length === 0 ? (
            <SettingsEmptyRow action={pairButton}>
              Pair a phone to answer your agents&apos; questions from it
            </SettingsEmptyRow>
          ) : (
            devices.map((device) => (
              <SettingsRow
                key={device.deviceId}
                id={`decisions-device-${device.deviceId}`}
                label={device.label}
                description={<DeviceFacts device={device} />}
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
      description="Each paired device can read and answer every question your agents ask"
      id={SECTION_ID}
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
