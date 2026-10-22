import { Button } from "@/components/ui/button";
import { formatLastChecked } from "@/utils/timeAgo";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { useCodexQuota } from "@/hooks/useCodexQuota";
import { windowLabel } from "@/utils/codexQuotaFormat";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import {
  CODEX_QUOTA_STALE_AFTER_MS,
  type CodexQuotaProfile,
  type CodexQuotaProfileHomeReason,
  type CodexQuotaUnavailableReason,
  type CodexQuotaWindow,
} from "@shared/types/ipc/agentQuota";

const UNAVAILABLE_COPY: Record<CodexQuotaUnavailableReason | CodexQuotaProfileHomeReason, string> =
  {
    "cli-missing": "Codex CLI isn't installed, so there's no quota to read",
    timeout: "Codex didn't answer in time. Daintree will ask again shortly.",
    "read-failed":
      "Codex didn't return a quota. It only reports one when signed in with ChatGPT, not an API key.",
    "unsupported-response": "Codex answered in a format Daintree doesn't read yet",
    "no-windows": "Codex didn't report any limit windows for this account",
    "home-missing":
      "This preset's CODEX_HOME isn't a folder Daintree can open. Check the path, or launch Codex with the preset once to sign in.",
    "home-not-absolute":
      "This preset's CODEX_HOME isn't a full path. Codex doesn't expand ~, so write it out in full.",
  };

/** The group name once a section holds several profiles; a lone one goes unnamed. */
export function profileLabel(profile: CodexQuotaProfile): string {
  const names = profile.presetNames.join(", ");
  if (!profile.isDefault) return names;
  return names ? `Default profile · ${names}` : "Default profile";
}

export { windowLabel };

function formatReset(resetsAt: number, now: number): string {
  const time = new Date(resetsAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay = new Date(resetsAt).toDateString() === new Date(now).toDateString();
  if (sameDay) return `Resets at ${time}`;
  const day = new Date(resetsAt).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `Resets ${day}, ${time}`;
}

function hasResetPassed(window: CodexQuotaWindow, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt <= now;
}

function QuotaWindowRow({
  window,
  now,
  stale,
  profile,
}: {
  window: CodexQuotaWindow;
  now: number;
  stale: boolean;
  /** Prefixes the meter's name once several profiles each have one of these. */
  profile?: string;
}) {
  const label = windowLabel(window.windowDurationMins);
  const meterLabel = profile ? `${profile} ${label.toLowerCase()} used` : `${label} used`;
  const used = Math.round(window.usedPercent);
  // A reset that has passed means the reading describes a window that's over.
  // Showing 0% would be a guess, so the old figure stays, marked stale.
  const resetPassed = hasResetPassed(window, now);
  const isStale = stale || resetPassed;
  const description =
    window.resetsAt === null
      ? "Reset time not reported"
      : resetPassed
        ? "Reset time has passed. Waiting for a new reading."
        : formatReset(window.resetsAt, now);

  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <div className="flex w-52 items-center gap-2">
          <div
            role="meter"
            aria-label={meterLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={used}
            aria-valuetext={`${used}% used${isStale ? ", stale" : ""}`}
            className="bg-overlay-emphasis h-1.5 flex-1 overflow-hidden rounded-full"
          >
            <div className="h-full rounded-full bg-text-secondary" style={{ width: `${used}%` }} />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-text-secondary">{used}% used</span>
        </div>
      }
    />
  );
}

function CodexQuotaGroup({
  profile,
  label,
  now,
  refresh,
}: {
  profile: CodexQuotaProfile;
  label?: string;
  now: number;
  refresh: () => void;
}) {
  const { result } = profile;
  if (result.status === "unavailable") {
    return (
      <SettingsGroup label={label}>
        <SettingsRow
          label="Quota unavailable"
          description={UNAVAILABLE_COPY[result.reason]}
          control={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </SettingsGroup>
    );
  }

  const stale = now - result.fetchedAt > CODEX_QUOTA_STALE_AFTER_MS;
  const anyStale = stale || result.windows.some((window) => hasResetPassed(window, now));
  const checked = formatLastChecked(result.fetchedAt, now);
  return (
    <SettingsGroup label={label}>
      {result.windows.map((window, index) => (
        // Index-qualified: nothing stops two windows reporting the same duration.
        <QuotaWindowRow
          key={`${index}-${window.windowDurationMins}`}
          window={window}
          now={now}
          stale={stale}
          profile={label}
        />
      ))}
      <SettingsRow
        label={anyStale ? "Stale reading" : "Current reading"}
        description={result.planType ? `${checked} · ${result.planType} plan` : checked}
      />
    </SettingsGroup>
  );
}

function CodexQuota() {
  const { profiles, refresh } = useCodexQuota(true);
  const now = useGlobalMinuteClock();
  const several = profiles !== null && profiles.length > 1;

  return (
    <SettingsSection
      title="Account quota"
      description={
        several
          ? "Read from Codex for each CODEX_HOME your presets use, not from any one terminal"
          : "Read from Codex for the signed-in account, not from any one terminal"
      }
    >
      {profiles === null ? (
        // Settings renders chrome immediately and fills in on resolve: an empty
        // group rather than a spinner, and never a meter before there's a number.
        <SettingsGroup>
          <SettingsRow label="Checking…" />
        </SettingsGroup>
      ) : (
        profiles.map((profile) => (
          <CodexQuotaGroup
            key={profile.key}
            profile={profile}
            label={several ? profileLabel(profile) : undefined}
            now={now}
            refresh={refresh}
          />
        ))
      )}
    </SettingsSection>
  );
}

/**
 * Live account quota under the agent picker (#12797). Codex reports its own
 * through the app-server, once per distinct `CODEX_HOME` (#13686); Claude's is never read — its credentials and usage
 * endpoints are off limits to other apps — so it says so beside "View usage".
 */
export function AgentQuotaSection({ agentId }: { agentId: string }) {
  if (agentId === "codex") return <CodexQuota />;
  if (agentId === "claude") {
    return (
      <SettingsSection title="Account quota">
        <SettingsGroup>
          <SettingsRow
            label="Live quota unavailable"
            description="Claude doesn't share usage with other apps. Use View usage to check it on claude.ai."
          />
        </SettingsGroup>
      </SettingsSection>
    );
  }
  return null;
}
