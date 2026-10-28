import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { HostId } from "@shared/types/remoteHosts";
import { formatHostTime } from "@/components/Hosts/hostTime";
import { clientErrorText } from "@/utils/clientAppError";
import { pluralize } from "@/lib/pluralize";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { describeAttachedShell, describeDriverRow, describeLinkEvent } from "./hostSessionsModel";
import { useHostLinkActivity } from "./useHostLinkActivity";

/** Recent events shown before the rest is asked for. */
const RECENT_EVENTS = 10;

interface HostSessionsSectionProps {
  hostId: HostId;
  hostName: string;
  connected: boolean;
  /** When the host's latest summary was sampled: each new one reads the activity again. */
  sampledAt: number | null;
}

/**
 * Settings → Hosts → a host → Sessions: what the host reports about its
 * links, so "why is this window read-only?" and "where did my session go?"
 * read here rather than in two machines' logs. Who drives each project and
 * whether that holder is away inside its reservation, which Shells are
 * attached, and what the host saw happen to its links since it started.
 */
export function HostSessionsSection({
  hostId,
  hostName,
  connected,
  sampledAt,
}: HostSessionsSectionProps) {
  const { state, refresh } = useHostLinkActivity(hostId, connected, sampledAt);
  const [showAll, setShowAll] = useState(false);

  const section = (children: ReactNode) => (
    <SettingsSection
      id="host-sessions"
      title="Sessions"
      description={`What ${hostName} reports about who drives its projects, which Shells are attached and what happened to its links`}
    >
      {children}
    </SettingsSection>
  );
  const notice = (children: ReactNode, action?: ReactNode) =>
    section(
      <SettingsGroup>
        <SettingsEmptyRow action={action}>{children}</SettingsEmptyRow>
      </SettingsGroup>
    );

  if (!connected) return notice(`Connect to ${hostName} to see its sessions`);
  if (state.kind === "unsupported") {
    return notice(`${hostName}'s build can't report its sessions. Update it to see them here`);
  }
  if (state.kind === "error") {
    return notice(
      clientErrorText(state.error, `Couldn't read ${hostName}'s sessions`),
      <Button variant="outline" size="sm" onClick={refresh}>
        Retry
      </Button>
    );
  }
  if (state.kind !== "ready") return notice(`Asking ${hostName} about its sessions`);

  const { activity, self } = state.result;
  const now = activity.observedAt;
  const events = showAll ? activity.events : activity.events.slice(0, RECENT_EVENTS);
  const hidden = activity.events.length - events.length;

  return section(
    <>
      <SettingsGroup label="Projects driven">
        {activity.drivers.length === 0 ? (
          <SettingsEmptyRow>Nobody is driving a project on {hostName}</SettingsEmptyRow>
        ) : (
          activity.drivers.map((driver) => {
            const text = describeDriverRow(driver, hostName, self, now);
            return (
              <SettingsRow
                key={driver.projectId}
                label={text.label}
                description={text.description}
              />
            );
          })
        )}
      </SettingsGroup>

      <SettingsGroup label="Attached now">
        {activity.attached.length === 0 ? (
          <SettingsEmptyRow>No Shells are attached to {hostName}</SettingsEmptyRow>
        ) : (
          activity.attached.map((shell) => {
            const text = describeAttachedShell(shell, activity.drivers, self, now);
            return (
              <SettingsRow
                key={shell.sessionId}
                label={text.label}
                description={text.description}
              />
            );
          })
        )}
      </SettingsGroup>

      <SettingsGroup label="Recent activity">
        {events.length === 0 && activity.listeningSince === null && (
          <SettingsEmptyRow>
            {hostName} hasn&apos;t recorded anything about its links
          </SettingsEmptyRow>
        )}
        {events.map((event, index) => {
          const text = describeLinkEvent(event, self, now);
          return (
            <SettingsRow
              key={`${event.at}-${event.kind}-${index}`}
              label={text.label}
              description={text.description}
            />
          );
        })}
        {hidden > 0 && (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
                Show all
              </Button>
            }
          >
            {pluralize(hidden, "earlier event")}
          </SettingsEmptyRow>
        )}
        {activity.listeningSince !== null && hidden === 0 && (
          <SettingsRow
            label="Started taking connections"
            description={`Daintree ${activity.version} · ${formatHostTime(activity.listeningSince, now)}${
              activity.eventsTruncated ? " · some events since then weren't kept" : ""
            }`}
          />
        )}
      </SettingsGroup>
    </>
  );
}
