import type { PulseRangeDays } from "@shared/types";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  Clock,
  CircleMinus,
  Tag,
  ShieldAlert,
  GitPullRequest,
  CircleDot,
  GitMerge,
} from "lucide-react";
import { systemClient } from "@/clients/systemClient";
import { Badge } from "@/components/ui/badge";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMediumDate, formatTimeAgo } from "@/utils/timeAgo";
import { formatCompactCount, formatCountExact } from "@/lib/formatCount";

type ChipTone = "neutral" | "error" | "warning";

// Routine signals share the neutral badge; only a state that asks the user to
// act takes a status tone, so a failing build or an open alert is the one
// coloured thing in the row instead of one hue among six. The tone stays on
// the fill and the glyph: the label keeps primary ink, which holds 4.5:1 on
// every theme where status-coloured text does not.
const TONE_CLASS: Record<ChipTone, string> = {
  neutral:
    "border-border-default group-hover:bg-overlay-medium group-hover:text-text-primary [&_svg]:text-text-secondary",
  error: "border-transparent text-text-primary group-hover:bg-status-error/15",
  warning: "border-transparent text-text-primary group-hover:bg-status-warning/15",
};

interface HealthChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  tone?: ChipTone;
  ref?: React.Ref<HTMLButtonElement>;
}

// A clickable badge is a real button wrapping `Badge`, as badge.tsx asks. Spreads
// the rest so a TooltipTrigger can wrap it `asChild`.
function HealthChip({ icon, children, tone = "neutral", className, ...props }: HealthChipProps) {
  return (
    <button
      type="button"
      {...props}
      className={cn("group inline-flex min-w-0 shrink-0 cursor-pointer rounded-full", className)}
    >
      <Badge
        tone={tone}
        shape="pill"
        className={cn(
          "h-6 min-w-0 max-w-full gap-1.5 border px-2 tabular-nums [&_svg]:h-3.5 [&_svg]:w-3.5",
          TONE_CLASS[tone]
        )}
      >
        {icon}
        {children}
      </Badge>
    </button>
  );
}

/**
 * "12 issues" visible; the accessible name continues it ("12 issues open"), so
 * it starts with exactly what is on screen. A compacted count ("1.3k") adds the
 * exact total for assistive tech rather than replacing what is shown.
 */
function CountLabel({ count, one, many }: { count: number; one: string; many: string }) {
  const shown = formatCompactCount(count);
  const exact = formatCountExact(count);
  return (
    <span>
      {shown} {count === 1 ? one : many}
      <span className="sr-only">{shown === exact ? " open" : ` (${exact} open)`}</span>
    </span>
  );
}

const { Icon: FailedIcon, toneClass: failedTone } = SEVERITY_VISUAL.error;

function FailedMark() {
  return <FailedIcon aria-hidden="true" className={failedTone} />;
}

function ciChip(status: ForgeProjectHealthPayload["ciStatus"]): {
  icon: React.ReactNode;
  label: string;
  tone: ChipTone;
} {
  switch (status) {
    case "failure":
      return { icon: <FailedMark />, label: "CI failing", tone: "error" };
    case "error":
      return { icon: <FailedMark />, label: "CI error", tone: "error" };
    case "pending":
    case "expected":
      return { icon: <Clock />, label: "CI running", tone: "neutral" };
    case "success":
      return { icon: <CheckCircle2 />, label: "CI passing", tone: "neutral" };
    default:
      return { icon: <CircleMinus />, label: "No CI", tone: "neutral" };
  }
}

/** "5d" rather than "5d ago": the chip is already about the past. */
function compactAge(timestamp: number): string {
  return formatTimeAgo(timestamp).replace(/^(\d+[mhd]) ago$/, "$1");
}

function ReleaseChip({
  release,
  onOpen,
}: {
  release: NonNullable<ForgeProjectHealthPayload["latestRelease"]>;
  onOpen: () => void;
}) {
  const published = release.publishedAt ? new Date(release.publishedAt).getTime() : null;
  const age = published !== null ? compactAge(published) : null;
  // A past-30-days release shows an absolute date ("Aug 20, 2025"), which the
  // narrow cap cannot hold beside the tag; it takes the row instead, and the
  // pair's wrap moves the merged count below it.
  const narrowCap = age !== null && !/^\d+[mhd]$|^just now$/.test(age) ? "max-w-full" : "max-w-28";
  return (
    // The body IS the content (the untruncated tag), so it stays while read.
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <HealthChip
          icon={<Tag />}
          onClick={onOpen}
          className={cn("shrink @sm:max-w-56", narrowCap)}
        >
          <span className="min-w-[6ch] truncate font-mono">{release.tagName}</span>
          {age !== null && <span className="shrink-0 text-text-secondary">{age}</span>}
          <span className="sr-only">, latest release</span>
        </HealthChip>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="block break-all font-mono">{release.tagName}</span>
        <span className="block text-text-secondary">
          Latest release{published !== null ? `, ${formatMediumDate(published)}` : ""}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function PulseHealthSignals({
  health,
  rangeDays,
}: {
  health: ForgeProjectHealthPayload;
  rangeDays: PulseRangeDays;
}) {
  const openUrl = (path: string) => {
    const url = path.startsWith("http") ? path : `${health.repoUrl}${path}`;
    void systemClient.openExternal(url);
  };

  const ci = ciChip(health.ciStatus);
  const alerts = health.securityAlerts.visible ? health.securityAlerts.count : 0;
  const mergedInRange = health.mergeVelocity.mergedCounts[rangeDays] ?? 0;
  // The same window the forge counted, so the list it opens matches the number.
  const mergedSince = new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 10);

  const ciChipEl = (
    <HealthChip key="ci" icon={ci.icon} onClick={() => openUrl("/actions")} tone={ci.tone}>
      {ci.label}
    </HealthChip>
  );
  const alertsChip = alerts > 0 && (
    <HealthChip
      key="alerts"
      icon={<ShieldAlert aria-hidden="true" className="text-status-warning" />}
      onClick={() => openUrl("/security/dependabot")}
      tone="warning"
    >
      <CountLabel count={alerts} one="security alert" many="security alerts" />
    </HealthChip>
  );
  const issuesChip = (
    <HealthChip key="issues" icon={<CircleDot />} onClick={() => openUrl("/issues")}>
      <CountLabel count={health.issueCount} one="issue" many="issues" />
    </HealthChip>
  );
  const prsChip = (
    <HealthChip key="prs" icon={<GitPullRequest />} onClick={() => openUrl("/pulls")}>
      <CountLabel count={health.prCount} one="PR" many="PRs" />
    </HealthChip>
  );
  const releaseChip = health.latestRelease && (
    <ReleaseChip
      key="release"
      release={health.latestRelease}
      onOpen={() => openUrl(health.latestRelease!.url)}
    />
  );
  const mergedChip = mergedInRange > 0 && (
    <HealthChip
      key="merged"
      icon={<GitMerge />}
      onClick={() =>
        openUrl(`/pulls?q=${encodeURIComponent(`is:pr is:merged merged:>=${mergedSince}`)}`)
      }
    >
      {formatCompactCount(mergedInRange)} merged
      <span className="text-text-secondary">· {rangeDays}d</span>
      <span className="sr-only"> in the last {rangeDays} days</span>
    </HealthChip>
  );

  // Chips wrap in pairs, so a narrow card breaks between pairs and never ends
  // on one stranded chip: the build and anything asking for action, the open
  // counts, then release history. With no alert and no release the pairs
  // re-split as [CI, issues] [PRs, merged], which keeps reading order and
  // still leaves no chip alone.
  const units: React.ReactNode[][] =
    !alertsChip && !releaseChip && mergedChip
      ? [
          [ciChipEl, issuesChip],
          [prsChip, mergedChip],
        ]
      : [
          [ciChipEl, alertsChip],
          [issuesChip, prsChip],
          [releaseChip, mergedChip],
        ];

  return (
    // `@container` lets the release tag take more room only where the card has it.
    <div className="@container flex flex-wrap items-center gap-x-1.5 gap-y-2">
      {units
        .map((unit) => unit.filter(Boolean))
        .filter((unit) => unit.length > 0)
        .map((unit, index) => (
          // Last resort for a pair whose minimum still cannot fit (an old
          // release's absolute date beside a four-digit 180-day count): it
          // wraps inside itself rather than overflowing the card.
          <div key={index} className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
            {unit}
          </div>
        ))}
    </div>
  );
}
