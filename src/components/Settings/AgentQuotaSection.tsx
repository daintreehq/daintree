import { useMemo, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getMergedPresetIdentities, getMergedPresets, type AgentPreset } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { pluralNoun } from "@/lib/pluralize";
import { formatLastChecked, formatTimeAgo } from "@/utils/timeAgo";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { useCodexQuota } from "@/hooks/useCodexQuota";
import { useClaudeUsage } from "@/hooks/useClaudeUsage";
import { windowLabel } from "@/utils/codexQuotaFormat";
import { claudeWindowLabel } from "@/utils/agentAccountHeadroom";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import {
  CODEX_QUOTA_STALE_AFTER_MS,
  type ClaudeUsageAccount,
  type ClaudeUsageReading,
  type CodexQuotaProfile,
  type CodexQuotaProfileHomeReason,
  type CodexQuotaUnavailableReason,
  type CodexQuotaWindow,
} from "@shared/types/ipc/agentQuota";

const UNAVAILABLE_COPY: Record<CodexQuotaUnavailableReason, string> = {
  "cli-missing": "Codex CLI isn't installed, so there's no quota to read",
  timeout: "Codex didn't answer in time. Daintree will ask again shortly.",
  "read-failed":
    "Codex didn't return a quota. It only reports one when signed in with ChatGPT, not an API key.",
  "unsupported-response": "Codex answered in a format Daintree doesn't read yet",
  "no-windows": "Codex didn't report any limit windows for this account",
};

// The default profile's home comes from Codex's own environment variables
// (#15047); every other profile's from a preset.
const HOME_COPY: Record<CodexQuotaProfileHomeReason, { preset: string; default: string }> = {
  "home-missing": {
    preset:
      "This preset's CODEX_HOME isn't a folder Daintree can open. Check the path, or launch Codex with the preset once to sign in.",
    default:
      "The CODEX_HOME in Codex's environment variables isn't a folder Daintree can open. Check the path, or launch Codex once to sign in.",
  },
  "home-not-absolute": {
    preset:
      "This preset's CODEX_HOME isn't a full path. Codex doesn't expand ~, so write it out in full.",
    default:
      "The CODEX_HOME in Codex's environment variables isn't a full path. Codex doesn't expand ~, so write it out in full.",
  },
};

function unavailableCopy(
  reason: CodexQuotaUnavailableReason | CodexQuotaProfileHomeReason,
  isDefault: boolean
): string {
  if (reason === "home-missing" || reason === "home-not-absolute") {
    return HOME_COPY[reason][isDefault ? "default" : "preset"];
  }
  return UNAVAILABLE_COPY[reason];
}

const presetList = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

// An empty value counts: it still moves the pane off the default, onto
// Codex's own `~/.codex`.
function setsCodexHome(preset: AgentPreset): boolean {
  return Object.keys(preset.env ?? {}).some((name) => name.toUpperCase() === "CODEX_HOME");
}

/**
 * Project-shared presets that would launch into a home of their own. Main
 * never reads those (#15047): a repository's file naming a home isn't the
 * user choosing one, so opening Settings doesn't start Codex against it. A
 * custom preset with the same id is the one that launches, so it hides its
 * namesake here as it does everywhere else.
 */
function useUnreadProjectCodexPresets(): string[] {
  const customPresets = useAgentSettingsStore((s) => s.settings?.agents?.codex?.customPresets);
  const projectPresets = useProjectPresetsStore((s) => s.presetsByAgent.codex);
  return useMemo(() => {
    if (!projectPresets?.length) return [];
    const fromProject = new Set(
      getMergedPresetIdentities("codex", customPresets, undefined, projectPresets)
        .filter((identity) => identity.source === "project")
        .map((identity) => identity.id)
    );
    return getMergedPresets("codex", customPresets, undefined, projectPresets)
      .filter((preset) => fromProject.has(preset.id) && setsCodexHome(preset))
      .map((preset) => preset.name);
  }, [customPresets, projectPresets]);
}

/** The group name once a section holds several profiles; a lone one goes unnamed. */
export function profileLabel(profile: CodexQuotaProfile): string {
  // Accounts first: they're what a home is for now (#16040); presets that
  // still name one follow.
  const names = [...(profile.accountNames ?? []), ...profile.presetNames].join(", ");
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
          description={unavailableCopy(result.reason, profile.isDefault)}
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
  const unreadProjectPresets = useUnreadProjectCodexPresets();
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
      {unreadProjectPresets.length > 0 && (
        <SettingsGroup>
          <SettingsRow
            label="Project presets not included"
            description={`${presetList.format(unreadProjectPresets)} ${pluralNoun(unreadProjectPresets.length, "sets its", "set their")} own CODEX_HOME in this project's .daintree/presets. Daintree doesn't start Codex against a home a repository names, so ${pluralNoun(unreadProjectPresets.length, "it's", "they're")} left out of the profiles above.`}
          />
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}

/**
 * What a message said, in its own terms: a percent only where it printed one,
 * and "over" kept as a floor rather than turned into a remaining share.
 */
export function claudeStatementText(
  reading: Pick<ClaudeUsageReading, "statement" | "usedPercent">
): string {
  const percent = reading.usedPercent === null ? null : Math.round(reading.usedPercent);
  switch (reading.statement) {
    case "used":
      return percent === null ? "Approaching limit" : `${percent}% used`;
    case "over":
      return percent === null ? "Approaching limit" : `Over ${percent}% used`;
    case "approaching":
      return "Approaching limit";
    case "reached":
      return "Limit reached";
  }
}

export { claudeWindowLabel };

// No title is all a closed pane and a host that didn't answer have in common,
// so neither is claimed.
function paneSource(reading: ClaudeUsageReading): string {
  const pane = reading.paneTitle ?? "a terminal";
  return reading.projectName ? `${pane} (${reading.projectName})` : pane;
}

function ClaudeUsageRow({
  reading,
  now,
  group,
}: {
  reading: ClaudeUsageReading;
  now: number;
  /** Prefixes the meter's name once several logins each have one. */
  group?: string;
}) {
  const label = claudeWindowLabel(reading.window);
  const stale = reading.resetsAt !== null && reading.resetsAt <= now;
  const reset =
    reading.resetsAt === null
      ? null
      : stale
        ? "Reset time has passed"
        : formatReset(reading.resetsAt, now);
  const seen = `Seen ${formatTimeAgo(reading.observedAt, now)} in ${paneSource(reading)}`;
  const description = reset ? `${reset} · ${seen}` : seen;
  const percent = reading.usedPercent === null ? null : Math.round(reading.usedPercent);

  const statement = claudeStatementText(reading);
  let control: ReactNode;
  if (reading.statement === "used" && percent !== null) {
    const meterLabel = group ? `${group} ${label.toLowerCase()} used` : `${label} used`;
    control = (
      <div className="flex w-52 items-center gap-2">
        <div
          role="meter"
          aria-label={meterLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${statement}, as a terminal showed it${stale ? ", stale" : ""}`}
          className="bg-overlay-emphasis h-1.5 flex-1 overflow-hidden rounded-full"
        >
          <div className="h-full rounded-full bg-text-secondary" style={{ width: `${percent}%` }} />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">{statement}</span>
      </div>
    );
  } else {
    control = <span className="text-xs tabular-nums text-text-secondary">{statement}</span>;
  }

  return (
    <SettingsRow
      label={label}
      accessory={stale ? <Badge size="xs">Stale</Badge> : undefined}
      description={description}
      control={control}
    />
  );
}

/**
 * The group name for one login. A lone default-login group goes unnamed while
 * no account is saved; any other group is named, so a reading never looks
 * like it describes a login it doesn't.
 */
export function claudeUsageGroupLabels(
  accounts: readonly ClaudeUsageAccount[],
  hasSavedAccounts: boolean
): (string | undefined)[] {
  const others = accounts.filter((account) => account.kind === "other").length;
  let otherIndex = 0;
  const lone = accounts.length === 1 && accounts[0]!.kind === "default" && !hasSavedAccounts;
  return accounts.map((account) => {
    if (lone) return undefined;
    const names = account.accountNames.join(", ");
    switch (account.kind) {
      case "default":
        return names ? `Default login · ${names}` : "Default login";
      case "account":
        return names;
      case "other":
        otherIndex++;
        return others > 1 ? `Other config folder ${otherIndex}` : "Other config folder";
      case "unknown":
        return "Unknown config folder";
    }
  });
}

/**
 * What Claude Code's own usage messages said in the host's panes (#15727,
 * #16370). Its credentials and usage endpoints are off limits to other apps,
 * so this is never a live figure: each row is the latest message a pane showed
 * for one limit, under the login that pane ran on.
 */
function ClaudeUsage() {
  const { accounts, failed, refresh } = useClaudeUsage(true);
  const now = useGlobalMinuteClock();
  const hasSavedAccounts = useAgentSettingsStore(
    (s) => (s.settings?.agents?.claude?.accounts?.length ?? 0) > 0
  );
  const labels = accounts ? claudeUsageGroupLabels(accounts, hasSavedAccounts) : [];

  let body: ReactNode;
  if (accounts === null) {
    body = failed ? (
      <SettingsGroup>
        <SettingsRow
          label="Usage unavailable"
          description="Daintree couldn't read what its terminals showed"
          control={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </SettingsGroup>
    ) : (
      <SettingsGroup>
        <SettingsRow label="Checking…" />
      </SettingsGroup>
    );
  } else if (accounts.length === 0) {
    body = (
      <SettingsGroup>
        <SettingsRow
          label="No usage seen yet"
          description="Claude Code reports usage in a terminal as a limit approaches, and the latest it showed appears here. Use View usage to check the account on claude.ai."
        />
      </SettingsGroup>
    );
  } else {
    body = accounts.map((account, index) => (
      <SettingsGroup key={account.key} label={labels[index]}>
        {account.readings.map((reading) => (
          <ClaudeUsageRow key={reading.window} reading={reading} now={now} group={labels[index]} />
        ))}
      </SettingsGroup>
    ));
  }
  // What's shown stays, but a read that failed since says so.
  const refreshFailed = accounts !== null && failed && (
    <SettingsGroup>
      <SettingsRow
        label="Couldn't check for newer readings"
        description="What's shown above may be out of date"
        control={
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        }
      />
    </SettingsGroup>
  );

  return (
    <SettingsSection
      title="Account quota"
      description="Claude Code's own usage messages, as your terminals showed them. Not a live account reading."
    >
      {body}
      {refreshFailed}
    </SettingsSection>
  );
}

/**
 * Account quota under the agent picker (#12797). Codex reports its own
 * through the app-server, once per distinct `CODEX_HOME` (#13686); Claude's is
 * never read, so its section shows what its panes printed (#16370) beside
 * "View usage".
 */
export function AgentQuotaSection({ agentId }: { agentId: string }) {
  if (agentId === "codex") return <CodexQuota />;
  if (agentId === "claude") return <ClaudeUsage />;
  return null;
}
