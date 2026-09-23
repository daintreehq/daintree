import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GitBranch } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { useProjectStore } from "@/store/projectStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";
import { IssueBadge } from "../WorktreeCard/IssueBadge";
import { PRBadge } from "../WorktreeCard/PRBadge";
import type { Project } from "@shared/types";
import type {
  CIStatusState,
  ForgeLabel,
  ForgeUser,
  IssueTooltipData,
  NormalizedPRState,
  PRTooltipData,
} from "@shared/types/forge";
import "@/index.css";

/**
 * Standalone visual-review harness for the worktree card's issue and PR badges
 * and their hover card.
 *
 * Mounts the REAL `IssueBadge` and `PRBadge` — hover card, freshness, cold-number
 * gap, credential gate and all — inside a copy of the sidebar card's headline row
 * and secondary row. The bridge answers the four reads the badges make
 * (`forge.resolveProvider`, `forge.getCredentialStatus`, `forge.getIssueTooltip`,
 * `forge.getPRTooltip`) from a fixture; the rate-limit and circuit-breaker states
 * are seeded straight into the stores the badges read. The card around the badges
 * is harness decoration.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?fixture=<name>   one of FIXTURES below
 *
 * Avatars point at `https://avatars.githubusercontent.com/<login>` (the one avatar host the CSP allows); the capture spec
 * routes that host to generated images, and a plain browser shows the fallback.
 */

const PROJECT: Project = {
  id: "proj-daintree",
  path: "/Users/greg/Projects/daintree",
  name: "Daintree",
  emoji: "\u{1F333}",
  lastOpened: Date.now(),
};
const PROVIDER_ID = "daintree.github.github";
const WORKTREE_PATH = "/Users/greg/Projects/daintree-worktrees/issue-4821";

const user = (login: string): ForgeUser => ({
  login,
  avatarUrl: `https://avatars.githubusercontent.com/${login}`,
  rawData: {},
});
const L = (name: string, color: string): ForgeLabel => ({ name, color });

/** A fixed date so captures don't drift between runs. */
const CREATED = new Date(2026, 8, 2, 10, 30).getTime();

const ISSUE: IssueTooltipData = {
  number: 4821,
  title: "Stream upload retries ignore the server's Retry-After header",
  bodyExcerpt:
    "When the ingest API answers 429 the uploader backs off on a fixed 2s step instead of the Retry-After value, so a busy region gets hammered by every client at once.",
  state: "open",
  rawState: "OPEN",
  createdAt: CREATED,
  author: user("avery-l"),
  assignees: [user("gregpriday")],
  labels: [
    L("bug", "d73a4a"),
    L("backend", "e99695"),
    L("good first issue", "7057ff"),
    L("needs triage", "fbca04"),
  ],
};

const ISSUE_CROWDED: IssueTooltipData = {
  ...ISSUE,
  state: "closed",
  rawState: "CLOSED",
  title:
    "Collapse the inspector panel when the window narrows below the medium breakpoint and restore it on widen",
  assignees: ["gregpriday", "avery-l", "sam-okafor", "priya-n", "jo-lee"].map(user),
  labels: [
    L("enhancement", "a2eeef"),
    L("ui", "fbe1d5"),
    L("infrastructure", "0e8a16"),
    L("documentation", "0075ca"),
    L("a-really-long-provider-label-name-that-has-no-spaces-at-all", "c5def5"),
    ...Array.from({ length: 20 }, (_, i) => L(`area-${i + 1}`, i % 2 ? "5319e7" : "bfd4f2")),
  ],
};

const PR: PRTooltipData = {
  number: 4830,
  title: "fix(upload): honour Retry-After on 429 with jittered backoff",
  bodyExcerpt:
    "Reads Retry-After (seconds or HTTP date), clamps it to the ladder's ceiling, and adds full jitter so clients don't resynchronise.",
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  createdAt: CREATED,
  author: user("gregpriday"),
  assignees: [],
  labels: [L("bug", "d73a4a"), L("backend", "e99695")],
};

type Reply<T> = T | "pending" | "error";
type Layout = "issue-headline" | "pr-headline";

interface Fixture {
  layout: Layout;
  active?: boolean;
  /** `null` = no title yet, the cold-number gap. */
  headlineTitle?: string | null;
  prState?: NormalizedPRState;
  ci?: CIStatusState;
  credential?: boolean;
  rateLimited?: boolean;
  prPaused?: boolean;
  issue?: Reply<IssueTooltipData>;
  pr?: Reply<PRTooltipData>;
}

export const FIXTURES: Record<string, Fixture> = {
  "issue-card": { layout: "issue-headline", active: true, ci: "success" },
  "issue-card-inactive": {
    layout: "issue-headline",
    active: false,
    ci: "failure",
    prState: "merged",
  },
  "pr-card": { layout: "pr-headline", active: true, ci: "pending" },
  "pr-card-draft": {
    layout: "pr-headline",
    active: true,
    ci: "pending",
    pr: { ...PR, isDraft: true },
  },
  "pr-card-merged": {
    layout: "pr-headline",
    active: true,
    ci: "success",
    prState: "merged",
    pr: { ...PR, state: "merged", rawState: "MERGED" },
  },
  "pr-card-closed": {
    layout: "pr-headline",
    active: true,
    prState: "closed",
    pr: { ...PR, state: "closed", rawState: "CLOSED" },
  },
  "cold-gap": { layout: "issue-headline", active: true, headlineTitle: null, ci: "success" },
  "no-token": { layout: "issue-headline", active: true, ci: "success", credential: false },
  "rate-limited": { layout: "issue-headline", active: true, ci: "success", rateLimited: true },
  "rate-limited-error": {
    layout: "issue-headline",
    active: true,
    ci: "success",
    rateLimited: true,
    issue: "error",
  },
  "pr-paused": { layout: "issue-headline", active: true, ci: "success", prPaused: true },
  "issue-crowded": { layout: "issue-headline", active: true, ci: "neutral", issue: ISSUE_CROWDED },
  loading: {
    layout: "issue-headline",
    active: true,
    ci: "success",
    issue: "pending",
    pr: "pending",
  },
  error: { layout: "issue-headline", active: true, ci: "success", issue: "error", pr: "error" },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "issue-card";
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

function inert(): unknown {
  const settled = Promise.resolve(undefined);
  const fn = () => undefined;
  return Object.assign(fn, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function answering(methods: Record<string, unknown>): unknown {
  return new Proxy(methods, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()),
  });
}

function reply<T>(value: Reply<T>): Promise<T | null> {
  if (value === "pending") return new Promise(() => undefined);
  if (value === "error") return Promise.resolve(null);
  return Promise.resolve(value);
}

installPreviewShims({
  project: answering({
    getCurrent: async () => PROJECT,
    onStatsUpdated: () => () => undefined,
  }),
  forge: answering({
    resolveProvider: async () => ({
      entry: {
        pluginId: "daintree.github",
        contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
      },
      resolvedVia: "hostname",
    }),
    getCredentialStatus: async () => ({ hasCredential: fixture.credential ?? true }),
    getIssueTooltip: () => reply(fixture.issue ?? ISSUE),
    getPRTooltip: () => reply(fixture.pr ?? PR),
  }),
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

useProjectStore.setState({ currentProject: PROJECT });
usePRCircuitBreakerStore.setState({ tripped: !!fixture.prPaused });
if (fixture.rateLimited) {
  useForgeProviderHealthStore.setState({
    providers: {
      [PROVIDER_ID]: {
        ...DEFAULT_PROVIDER_HEALTH,
        rateLimitBlocked: true,
        rateLimitKind: "primary",
        rateLimitResetAt: Date.now() + 14 * 60_000,
      },
    },
  });
}

function ci(state: CIStatusState | undefined) {
  if (!state) return null;
  return { state, total: 12, passed: 9, failed: 1, pending: 2, rawData: {} };
}

/** Copy of the sidebar card's branch line — harness decoration. */
function BranchLine({ branch }: { branch: string }) {
  return (
    <div className="flex items-center gap-1 text-xs text-text-secondary min-w-0">
      <GitBranch className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span className="truncate font-mono">{branch}</span>
    </div>
  );
}

function Card() {
  const active = fixture.active ?? true;
  const prState = fixture.prState ?? "open";
  const isPrCard = fixture.layout === "pr-headline";
  const title = fixture.headlineTitle === null ? undefined : isPrCard ? PR.title : ISSUE.title;

  return (
    <div
      className="sidebar-worktree-card relative isolate"
      data-variant="sidebar"
      data-active={active ? "true" : undefined}
    >
      <div className="px-3 pt-2 pb-2.5">
        <div className="flex items-center gap-2 min-h-[22px]">
          <div className="flex items-center gap-2 min-w-0 flex-1" data-shot="headline">
            {isPrCard ? (
              <PRBadge
                prNumber={PR.number}
                prTitle={title}
                prState={prState}
                prCiStatus={ci(fixture.ci)}
                isSubordinate={false}
                worktreePath={WORKTREE_PATH}
                isHeadline
                isActive={active}
              />
            ) : (
              <IssueBadge
                issueNumber={ISSUE.number}
                issueTitle={title}
                worktreePath={WORKTREE_PATH}
                isHeadline
                isActive={active}
              />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-0.5 mt-2.5 px-1">
          {isPrCard && (
            <div data-shot="secondary-issue">
              <IssueBadge
                issueNumber={ISSUE.number}
                issueTitle={ISSUE.title}
                worktreePath={WORKTREE_PATH}
                isActive={active}
              />
            </div>
          )}
          <BranchLine
            branch={isPrCard ? "fix/upload-retry-after" : "feature/issue-4821-stream-upload-retry"}
          />
          {!isPrCard && prState !== "closed" && (
            <div data-shot="secondary-pr">
              <PRBadge
                prNumber={PR.number}
                prState={prState}
                prCiStatus={ci(fixture.ci)}
                isSubordinate
                worktreePath={WORKTREE_PATH}
                isActive={active}
                prDetectionPaused={fixture.prPaused}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Preview() {
  return (
    <div
      data-preview-shell
      className="w-[320px] border-r border-divider"
      style={{ background: "var(--color-surface-sidebar)" }}
    >
      <Card />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider
      delayDuration={UI_TOOLTIP_DELAY_DURATION}
      skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
      disableHoverableContent
    >
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
