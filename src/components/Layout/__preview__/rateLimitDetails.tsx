import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clock } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveRateLimitCountdown, RateLimitDetailsPanel } from "../RateLimitDetails";
import type { RateLimitBucket, RateLimitDetails } from "@shared/types/forge";
import "@/index.css";

/**
 * Standalone visual-review harness for the toolbar's rate-limit details panel.
 *
 * Mounts the REAL `RateLimitDetailsPanel` inside the real `TooltipContent`, forced
 * open under a clock trigger shaped like the toolbar's, so the panel is judged in
 * the bubble it actually ships in. The states worth looking at (a secondary limit,
 * one bucket spent while another is nearly spent, a provider with no inspectable
 * quota) are ones a real session reaches rarely and never on demand.
 *
 * Every time is relative to `Date.now()` at module evaluation, and the capture spec
 * freezes the page clock, so a countdown photographs the same on every run.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?fixture=<name>   one of FIXTURE_NAMES below
 */

const second = 1_000;
const minute = 60 * second;
const hour = 60 * minute;

interface PanelFixture {
  kind: "panel";
  what: string;
  providerName: string;
  limitKind: "primary" | "secondary" | null;
  /** `"pending"` = the details read has not answered; `null` = it answered with nothing. */
  details: RateLimitBucket[] | "pending" | null;
  /** Offset from now of the reset time the stats push carried, or `null`. */
  resetInMs: number | null;
}

interface BannerFixture {
  kind: "banner";
  what: string;
  /** Offsets from now, one banner line each. */
  offsets: number[];
}

type Fixture = PanelFixture | BannerFixture;

function bucket(name: string, limit: number, remaining: number, resetInMs: number) {
  return { name, limit, remaining, used: limit - remaining, resetInMs };
}

type BucketSpec = ReturnType<typeof bucket>;

const NOW = Date.now();

function toBuckets(specs: BucketSpec[]): RateLimitBucket[] {
  return specs.map(({ resetInMs, ...rest }) => ({ ...rest, resetAt: NOW + resetInMs }));
}

export const FIXTURES: Record<string, Fixture> = {
  "primary-single": {
    kind: "panel",
    what: "primary limit, the one REST bucket spent",
    providerName: "GitHub",
    limitKind: "primary",
    details: toBuckets([bucket("core", 5_000, 0, 14 * minute + 5 * second)]),
    resetInMs: 14 * minute + 5 * second,
  },
  "primary-multi": {
    kind: "panel",
    what: "primary limit across three buckets — REST spent, GraphQL and Search healthy",
    providerName: "GitHub",
    limitKind: "primary",
    details: toBuckets([
      bucket("core", 5_000, 0, 14 * minute + 5 * second),
      bucket("graphql", 5_000, 4_212, 38 * minute + 40 * second),
      bucket("search", 30, 28, 42 * second),
    ]),
    resetInMs: 14 * minute + 5 * second,
  },
  "near-vs-spent": {
    kind: "panel",
    what: "GraphQL spent while REST core is down to its last handful",
    providerName: "GitHub",
    limitKind: "primary",
    details: toBuckets([
      bucket("core", 5_000, 7, 51 * minute + 12 * second),
      bucket("graphql", 5_000, 0, 1 * hour + 3 * minute + 20 * second),
    ]),
    resetInMs: 1 * hour + 3 * minute + 20 * second,
  },
  secondary: {
    kind: "panel",
    what: "secondary limit — every bucket has budget, the pause is abuse protection",
    providerName: "GitHub",
    limitKind: "secondary",
    details: toBuckets([
      bucket("core", 5_000, 3_904, 27 * minute),
      bucket("graphql", 5_000, 4_958, 51 * minute + 30 * second),
    ]),
    resetInMs: 47 * second,
  },
  "secondary-no-details": {
    kind: "panel",
    what: "secondary limit, the provider reported no buckets",
    providerName: "GitHub",
    limitKind: "secondary",
    details: null,
    resetInMs: 2 * minute + 30 * second,
  },
  "kind-unknown": {
    kind: "panel",
    what: "kind null — only the fallback reset time from the stats push",
    providerName: "GitHub",
    limitKind: null,
    details: null,
    resetInMs: 1 * hour + 12 * minute,
  },
  "details-pending": {
    kind: "panel",
    what: "the details read is still in flight",
    providerName: "GitHub",
    limitKind: "primary",
    details: "pending",
    resetInMs: 14 * minute + 5 * second,
  },
  "details-missing": {
    kind: "panel",
    what: "the details read answered null and there is no fallback time",
    providerName: "GitHub",
    limitKind: "primary",
    details: null,
    resetInMs: null,
  },
  gitlab: {
    kind: "panel",
    what: "GitLab's single REST bucket, spent",
    providerName: "GitLab",
    limitKind: "primary",
    details: toBuckets([bucket("rest", 2_000, 0, 44 * second)]),
    resetInMs: 44 * second,
  },
  "reset-due": {
    kind: "panel",
    what: "a bucket whose reset time has already passed while another is still spent",
    providerName: "GitHub",
    limitKind: "primary",
    details: toBuckets([
      bucket("core", 5_000, 0, -3 * second),
      bucket("graphql", 5_000, 0, 9 * minute),
    ]),
    resetInMs: 9 * minute,
  },
  "resume-passed": {
    kind: "panel",
    what: "the provider's resume time has passed but no clearing push has landed yet",
    providerName: "GitHub",
    limitKind: "primary",
    details: toBuckets([bucket("core", 5_000, 0, -4 * second)]),
    resetInMs: -4 * second,
  },
  "countdown-ladder": {
    kind: "panel",
    what: "the countdown label either side of each boundary (h, m, s)",
    providerName: "GitHub",
    limitKind: "primary",
    details: toBuckets([
      bucket("2h 05m", 100, 0, 2 * hour + 5 * minute + 30 * second),
      bucket("1h exactly", 100, 0, 1 * hour),
      bucket("59m 59s", 100, 0, 59 * minute + 59 * second),
      bucket("10m 00s", 100, 0, 10 * minute),
      bucket("1m 01s", 100, 0, 1 * minute + 1 * second),
      bucket("59s", 100, 0, 59 * second),
      bucket("5s", 100, 0, 5 * second),
    ]),
    resetInMs: 5 * second,
  },
  "banner-ladder": {
    kind: "banner",
    what: "LiveRateLimitCountdown in the resource-list banner sentence at each boundary",
    offsets: [
      2 * hour + 5 * minute + 30 * second,
      59 * minute + 59 * second,
      14 * minute + 5 * second,
      1 * minute + 1 * second,
      42 * second,
      -1 * second,
    ],
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "primary-multi";
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

installPreviewShims();

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const CLOCK_TICK_MS = second;

function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function PanelPreview({ f }: { f: PanelFixture }) {
  const now = useSecondClock();
  const details: RateLimitDetails | null | undefined =
    f.details === "pending"
      ? undefined
      : f.details === null
        ? null
        : { buckets: f.details, fetchedAt: NOW };
  return (
    <div
      data-preview-shell
      className="surface-toolbar flex h-12 w-[420px] items-center justify-end border-b border-divider px-4"
    >
      <Tooltip open autoDismiss={false}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${f.providerName} rate limit`}
            className="flex h-7 w-7 items-center justify-center"
          >
            <Clock className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="px-0 py-0" data-preview-panel="">
          <RateLimitDetailsPanel
            providerName={f.providerName}
            kind={f.limitKind}
            details={details}
            now={now}
            fallbackResetAt={f.resetInMs === null ? null : NOW + f.resetInMs}
          />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The resource list's paused banner, reproduced so the countdown is read in its sentence. */
function BannerPreview({ f }: { f: BannerFixture }) {
  return (
    <div data-preview-shell data-preview-ready="" className="w-[520px] surface-panel py-2">
      {f.offsets.map((offset) => (
        <div
          key={offset}
          className="px-3 py-2 border-b border-divider flex items-center gap-2 text-text-secondary bg-overlay-soft"
        >
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span className="text-xs truncate">GitHub requests are paused.</span>
          <span className="text-xs text-text-secondary shrink-0 whitespace-nowrap tabular-nums">
            · Resumes <LiveRateLimitCountdown resetAt={NOW + offset} />
          </span>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      {fixture.kind === "panel" ? <PanelPreview f={fixture} /> : <BannerPreview f={fixture} />}
    </TooltipProvider>
  </StrictMode>
);
