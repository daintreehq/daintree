import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { useCodexQuota } from "@/hooks/useCodexQuota";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { formatTimeAgo } from "@/utils/timeAgo";
import {
  CODEX_QUOTA_STALE_AFTER_MS,
  type CodexQuotaUnavailableReason,
  type CodexQuotaWindow,
} from "@shared/types/ipc/agentQuota";

const UNAVAILABLE_COPY: Record<CodexQuotaUnavailableReason, string> = {
  "cli-missing": "Codex CLI isn't installed, so there's no quota to read",
  timeout: "Codex didn't answer in time. Daintree will ask again shortly.",
  "read-failed": "Codex didn't report a quota. Signing in with ChatGPT makes it available.",
  "unsupported-response": "Codex answered in a format Daintree doesn't read yet",
  "no-windows": "Codex didn't report any limit windows for this account",
};

export function windowLabel(windowDurationMins: number): string {
  if (windowDurationMins === 10080) return "Weekly limit";
  if (windowDurationMins % 1440 === 0) return `${windowDurationMins / 1440}-day limit`;
  if (windowDurationMins % 60 === 0) return `${windowDurationMins / 60}-hour limit`;
  return `${windowDurationMins}-minute limit`;
}

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

function QuotaWindowRow({
  window,
  now,
  stale,
}: {
  window: CodexQuotaWindow;
  now: number;
  stale: boolean;
}) {
  const label = windowLabel(window.windowDurationMins);
  const used = Math.round(window.usedPercent);
  // A reset that has passed means the reading describes a window that's over.
  // Showing 0% would be a guess, so the old figure stays, marked stale.
  const resetPassed = window.resetsAt !== null && window.resetsAt <= now;
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
            aria-label={`${label} used`}
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

function CodexQuota() {
  const result = useCodexQuota(true);
  const now = useGlobalMinuteClock();

  // Settings renders chrome immediately and fills in on resolve: an empty group
  // rather than a spinner, and never a meter before there's a number for it.
  if (result === null) {
    return (
      <SettingsGroup>
        <SettingsRow label="Codex quota" description="Checking…" />
      </SettingsGroup>
    );
  }

  if (result.status === "unavailable") {
    return (
      <SettingsGroup>
        <SettingsRow label="Quota unavailable" description={UNAVAILABLE_COPY[result.reason]} />
      </SettingsGroup>
    );
  }

  const stale = now - result.fetchedAt > CODEX_QUOTA_STALE_AFTER_MS;
  const checked = `Last checked ${formatTimeAgo(result.fetchedAt, now)}`;
  return (
    <SettingsGroup>
      {result.windows.map((window) => (
        <QuotaWindowRow key={window.windowDurationMins} window={window} now={now} stale={stale} />
      ))}
      <SettingsRow
        label={stale ? "Stale reading" : "Current reading"}
        description={result.planType ? `${checked} · ${result.planType} plan` : checked}
      />
    </SettingsGroup>
  );
}

/**
 * Live account quota under the agent picker (#12797). Codex reports its own
 * through the app-server; Claude's is never read — its credentials and usage
 * endpoints are off limits to other apps — so it says so beside "View usage".
 */
export function AgentQuotaSection({ agentId }: { agentId: string }) {
  if (agentId === "codex") {
    return (
      <SettingsSection
        title="Account quota"
        description="Read from Codex for the signed-in account, not from any one terminal"
      >
        <CodexQuota />
      </SettingsSection>
    );
  }
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
