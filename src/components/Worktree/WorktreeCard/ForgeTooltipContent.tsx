import type {
  CIStatus,
  ForgeLabel,
  ForgeUser,
  IssueTooltipData,
  NormalizedIssueState,
  PRTooltipData,
} from "@shared/types/forge";
import {
  Calendar,
  CircleCheck,
  CircleDot,
  KeyRound,
  PenLine,
  UserCheck,
  Clock,
  CirclePause,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BadgeFreshnessCause } from "@/components/Layout/FreshnessUtils";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";

// Every body renders at the same width, so the card doesn't resize between the
// skeleton, a short title and a long one as the pointer moves along a column of
// badges. 280px + the content's p-3 sits inside the primitive's max-w-xs.
const CARD_WIDTH = "w-[280px]";

function formatDate(epochMs: number): string {
  const date = new Date(epochMs);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Forge avatar CDNs commonly honour a `?s=` pixel size. Request 2× the
// rendered size for crisp HiDPI, replacing any existing `s=` so we never
// double up the param; providers that ignore it serve the original.
function withAvatarSize(url: string | undefined, size: number): string {
  if (!url) return "";
  if (/[?&]s=\d+/.test(url)) {
    return url.replace(/([?&])s=\d+/, `$1s=${size}`);
  }
  return `${url}${url.includes("?") ? "&" : "?"}s=${size}`;
}

// Author / single-assignee avatar: the login renders as adjacent text, so the
// image is decorative (`alt=""`) and carries no redundant hover title.
function ForgeAvatar({
  user,
  sizeClass,
  urlSize,
}: {
  user: ForgeUser;
  sizeClass: string;
  urlSize: number;
}) {
  return (
    <Avatar
      src={withAvatarSize(user.avatarUrl, urlSize)}
      alt=""
      className={cn(sizeClass, "shrink-0")}
    />
  );
}

// Assignee metadata cell. A `UserCheck` glyph marks the role (vs the author
// row's `PenLine`) so creator and assignee read apart at a glance. One assignee
// → glyph + avatar + login. Two or more → the cell takes a line of its own and
// names everyone in wrapping text, with up to three avatars as support: a
// count of faces told a keyboard user nothing, and a hover title can't be
// reached from focus. The avatars sit apart instead of overlapping: an overlap
// needs a cut-out ring in the card's own colour, which forced-colors strips and
// which has no one token to match across the overlay's light and dark planes.
function AssigneeMeta({ assignees }: { assignees: ForgeUser[] }) {
  if (assignees.length === 1) {
    return (
      <span className="flex items-center gap-1 min-w-0">
        <UserCheck className="w-3 h-3 shrink-0" aria-hidden="true" />
        <ForgeAvatar user={assignees[0]!} sizeClass="w-3.5 h-3.5" urlSize={28} />
        <span className="sr-only">Assigned to </span>
        <span className="truncate">{assignees[0]!.login}</span>
      </span>
    );
  }

  return (
    <span className="flex items-start gap-1 min-w-0 basis-full">
      <UserCheck className="w-3 h-3 mt-px shrink-0" aria-hidden="true" />
      <span className="flex items-center gap-0.5 mt-px shrink-0" aria-hidden="true">
        {assignees.slice(0, 3).map((user) => (
          <Avatar
            key={user.login}
            src={withAvatarSize(user.avatarUrl, 24)}
            alt=""
            className="w-3 h-3 shrink-0"
          />
        ))}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="sr-only">Assigned to </span>
        {assignees.map((u) => u.login).join(", ")}
      </span>
    </span>
  );
}

export interface TooltipFreshness {
  cause: BadgeFreshnessCause | undefined;
  now: number;
  rateLimitResetAt?: number | null;
}

function freshnessItem(
  freshness: TooltipFreshness | undefined
): { Icon: LucideIcon; label: string } | null {
  if (!freshness) return null;
  switch (freshness.cause) {
    case "rate-limit": {
      let label = "Rate limited";
      const { rateLimitResetAt, now } = freshness;
      if (rateLimitResetAt != null && Number.isFinite(rateLimitResetAt) && rateLimitResetAt > now) {
        const retryTime = new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(rateLimitResetAt));
        label += `, retrying at ${retryTime}`;
      }
      return { Icon: Clock, label };
    }
    case "circuit-breaker":
      return {
        Icon: CirclePause,
        label: "PR detection paused, so details may be out of date. Open the pull request to check",
      };
    default:
      return null;
  }
}

/**
 * Freshness status as a metadata-row item: a small Lucide icon + label that
 * matches the author/assignee/date entries. Folds the old `·`-prefixed block
 * line (#9696) onto the metadata row. Rendered standalone with a `className`
 * by the fallback body when there is no data row to host it.
 */
export function FreshnessMetaItem({
  freshness,
  className,
}: {
  freshness?: TooltipFreshness;
  className?: string;
}) {
  const item = freshnessItem(freshness);
  if (!item) return null;
  const { Icon, label } = item;
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

interface TokenMissingTooltipProps {
  type: "issue" | "pr";
}

export function TokenMissingTooltip({ type }: TokenMissingTooltipProps) {
  return (
    <div className="flex items-start gap-2 max-w-[280px]">
      <KeyRound className="w-3.5 h-3.5 mt-px shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="text-xs text-text-primary">
          Add a forge access token to see {type === "pr" ? "pull request" : "issue"} details
        </p>
        <p className="text-2xs text-text-secondary">Click the badge to open forge settings</p>
      </div>
    </div>
  );
}

interface CardHeaderProps {
  Glyph: LucideIcon;
  colorClass: string;
  stateLabel: string;
  number: number;
  title?: string;
  /** Right-aligned on the status line — the PR's CI rollup. */
  trailing?: React.ReactNode;
}

/**
 * Status line, then the title on its own full-width line.
 *
 * State is said three ways at once — glyph shape, colour, and the word — so it
 * never rests on hue (WCAG SC 1.4.1), and the glyph is the same one the badge
 * the pointer is resting on draws. The number steps down to secondary beside
 * the word: it's reference, and the title is what identifies the item. The
 * title owns its line so a state pill can't squeeze it into a narrow column,
 * and gets four lines before it clamps: the card is where the title the
 * sidebar had to truncate is read in full.
 */
function CardHeader({ Glyph, colorClass, stateLabel, number, title, trailing }: CardHeaderProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-2xs">
        <Glyph className={cn("w-3.5 h-3.5 shrink-0", colorClass)} aria-hidden="true" />
        <span className={cn("font-medium", colorClass)}>{stateLabel}</span>
        <span className="text-text-secondary tabular-nums">#{number}</span>
        {trailing}
      </div>
      {title && (
        <p className="text-xs font-medium text-text-primary line-clamp-4 [overflow-wrap:anywhere]">
          {title}
        </p>
      )}
    </div>
  );
}

function issueStateVisual(state: NormalizedIssueState | undefined) {
  return state === "closed"
    ? { Glyph: CircleCheck, colorClass: "text-pr-merged", label: "Closed" }
    : { Glyph: CircleDot, colorClass: "text-pr-open", label: "Open" };
}

function prStateLabel(state: string | undefined, isDraft: boolean): string {
  if (state === "merged") return "Merged";
  if (state === undefined || state === "open") return isDraft ? "Draft" : "Open";
  return "Closed";
}

/** The CI rollup, in words, for the status line of a PR card. */
function CIStatusItem({ status }: { status: CIStatus }) {
  const visual = getCIStatusVisual(status);
  if (!visual) return null;
  const counted =
    status.total > 0
      ? status.state === "failure"
        ? ` · ${status.failed} of ${status.total} failed`
        : status.state === "pending"
          ? ` · ${status.pending} of ${status.total} running`
          : ""
      : "";
  return (
    <span className="ml-auto flex items-center gap-1 shrink-0 text-text-secondary">
      <span className="inline-flex items-center justify-center w-3 h-3 shrink-0" aria-hidden="true">
        {visual.kind === "icon" ? (
          <visual.Icon className={cn("w-3 h-3", visual.colorClass)} />
        ) : (
          <span className={cn("status-mark block w-2 h-2 rounded-full", visual.colorClass)} />
        )}
      </span>
      <span>
        {visual.shortLabel === "neutral" ? "CI neutral" : `CI ${visual.shortLabel}`}
        {counted}
      </span>
    </span>
  );
}

function LabelChip({ name, color }: ForgeLabel) {
  return (
    <span
      // Neutral chip, provider colour on a dot. A provider's label colour is an
      // arbitrary hex chosen against one background, so painting the name in it
      // guaranteed a label unreadable on either the light or the dark themes.
      // The dot keeps the colour recognisable; the name carries the meaning.
      // Same treatment as the forge dropdown's rows.
      // `inline-flex` + a clamped inner span: `break-words` acts on an element's
      // own inline content, so the text node gets its own box to wrap in.
      className="inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 rounded-full border border-divider text-3xs font-medium text-text-secondary"
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: `#${color ?? "8b949e"}` }}
        aria-hidden="true"
      />
      <span className="min-w-0 [overflow-wrap:anywhere] line-clamp-2">{name}</span>
    </span>
  );
}

/**
 * How many label chips a hover tooltip will render.
 *
 * Double the builtin GitHub provider's own `labels(first: 10)` page, so in
 * practice every label an issue carries is shown and this never engages. It
 * exists because `ForgeLabel[]` is unbounded in the provider contract: a plugin
 * forge could return hundreds, and a tooltip can't scroll, so the row would
 * grow past the viewport and be clipped by the tooltip's own `overflow-hidden`.
 */
const MAX_TOOLTIP_LABELS = 20;

/**
 * Every label, not the first four.
 *
 * The row used to cut off at four and count the rest, which put the tail behind
 * a "+N more" that sits inside a hover tooltip — there is no further surface to
 * open from there, so the count named content the user could not reach
 * (#12001). `LabelChip` wraps rather than widens, so a single long
 * provider-supplied label can't push the tooltip past its width.
 *
 * Past `MAX_TOOLTIP_LABELS` the row names the route rather than counting a
 * remainder — a tooltip has no surface of its own to open, but the badge this
 * one describes does open the item, so that is where the rest live.
 */
function LabelRow({ labels, subject }: { labels: readonly ForgeLabel[]; subject: string }) {
  const shown = labels.slice(0, MAX_TOOLTIP_LABELS);
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      {shown.map((label) => (
        <LabelChip key={label.name} name={label.name} color={label.color} />
      ))}
      {labels.length > shown.length && (
        <span className="text-3xs text-text-secondary">
          Showing {shown.length} of {labels.length} — open the {subject} for the rest
        </span>
      )}
    </div>
  );
}

function MetaRow({
  author,
  assignees,
  createdAt,
  freshness,
}: {
  author?: ForgeUser;
  assignees: ForgeUser[];
  createdAt: number;
  freshness?: TooltipFreshness;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-text-secondary">
      {author && (
        <span className="flex items-center gap-1 min-w-0">
          <PenLine className="w-3 h-3 shrink-0" aria-hidden="true" />
          <ForgeAvatar user={author} sizeClass="w-3.5 h-3.5" urlSize={28} />
          <span className="sr-only">Created by </span>
          <span className="truncate">{author.login}</span>
        </span>
      )}

      <span className="flex items-center gap-1">
        <Calendar className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span className="sr-only">Opened </span>
        {formatDate(createdAt)}
      </span>

      {/* After the date: several assignees take a line of their own, and here
          that line doesn't strand the author alone on the one above it. */}
      {assignees.length > 0 && <AssigneeMeta assignees={assignees} />}

      <FreshnessMetaItem freshness={freshness} />
    </div>
  );
}

interface IssueTooltipContentProps {
  data: IssueTooltipData;
  freshness?: TooltipFreshness;
}

export function IssueTooltipContent({ data, freshness }: IssueTooltipContentProps) {
  const { Glyph, colorClass, label } = issueStateVisual(data.state);

  return (
    <div className={cn("space-y-2", CARD_WIDTH)}>
      <CardHeader
        Glyph={Glyph}
        colorClass={colorClass}
        stateLabel={label}
        number={data.number}
        title={data.title}
      />

      {data.bodyExcerpt && (
        <p className="text-2xs text-text-secondary line-clamp-3">{data.bodyExcerpt}</p>
      )}

      <MetaRow
        author={data.author}
        assignees={data.assignees}
        createdAt={data.createdAt}
        freshness={freshness}
      />

      {data.labels.length > 0 && <LabelRow labels={data.labels} subject="issue" />}
    </div>
  );
}

interface PRTooltipContentProps {
  data: PRTooltipData;
  freshness?: TooltipFreshness;
  /** The badge's CI rollup; the tooltip payload itself carries none. */
  ciStatus?: CIStatus | null;
}

export function PRTooltipContent({ data, freshness, ciStatus }: PRTooltipContentProps) {
  // Merged and closed PRs keep their last CI result on the badge, but a
  // finished PR's checks don't change what anyone does next.
  const showCI = ciStatus && (data.state === "open" || data.state === undefined);

  return (
    <div className={cn("space-y-2", CARD_WIDTH)}>
      <CardHeader
        Glyph={getPrStateGlyph(data.state, data.isDraft)}
        colorClass={getPrStateColor(data.state, data.isDraft)}
        stateLabel={prStateLabel(data.state, data.isDraft)}
        number={data.number}
        title={data.title}
        trailing={showCI ? <CIStatusItem status={ciStatus} /> : undefined}
      />

      {data.bodyExcerpt && (
        <p className="text-2xs text-text-secondary line-clamp-3">{data.bodyExcerpt}</p>
      )}

      <MetaRow
        author={data.author}
        assignees={data.assignees}
        createdAt={data.createdAt}
        freshness={freshness}
      />

      {data.labels.length > 0 && <LabelRow labels={data.labels} subject="pull request" />}
    </div>
  );
}

interface TooltipFallbackProps {
  type: "issue" | "pr";
  number: number;
  /** What the badge already knows — never say less than the badge did. */
  title?: string;
  prState?: string;
  /** The badge's CI rollup, so the fallback keeps the mark the badge shows. */
  ciStatus?: CIStatus | null;
  status: "loading" | "failed" | "idle";
  freshness?: TooltipFreshness;
}

/**
 * The body when there are no details yet: the fetch is in flight, failed, or
 * hasn't been asked. It leads with what the badge under the pointer already
 * knows — the state the card has, the number, the title — so a slow or
 * unreachable forge costs the extra detail and nothing else.
 *
 * Loading skeletonises only the detail below that header. `animate-pulse-delayed`
 * is the one 400ms gate: a cache-warm answer lands before the bars ever show,
 * so the header alone is what a fast hover sees, with nothing flashing past.
 */
export function TooltipFallback({
  type,
  number,
  title,
  prState,
  ciStatus,
  status,
  freshness,
}: TooltipFallbackProps) {
  const header =
    type === "pr"
      ? {
          Glyph: getPrStateGlyph(prState),
          colorClass: getPrStateColor(prState),
          label: prStateLabel(prState, false),
        }
      : // A badge knows an issue's number and title but not whether it's
        // still open, so the header claims neither.
        { Glyph: CircleDot, colorClass: "text-text-secondary", label: "Issue" };
  const hasFreshness = freshnessItem(freshness) !== null;
  const subject = type === "pr" ? "pull request" : "issue";

  return (
    <div className={cn("space-y-2", CARD_WIDTH)}>
      <CardHeader
        Glyph={header.Glyph}
        colorClass={header.colorClass}
        stateLabel={header.label}
        number={number}
        title={title}
        trailing={
          type === "pr" && ciStatus && (prState === undefined || prState === "open") ? (
            <CIStatusItem status={ciStatus} />
          ) : undefined
        }
      />
      {status === "loading" && (
        <div className="space-y-2" aria-hidden="true">
          <div className="space-y-1.5">
            <div className="animate-pulse-delayed h-2.5 w-full rounded-full bg-tint/[0.1]" />
            <div className="animate-pulse-delayed h-2.5 w-2/3 rounded-full bg-tint/[0.1]" />
          </div>
          <div className="flex items-center gap-3">
            <div className="animate-pulse-delayed h-2.5 w-16 rounded-full bg-tint/[0.1]" />
            <div className="animate-pulse-delayed h-2.5 w-20 rounded-full bg-tint/[0.1]" />
          </div>
        </div>
      )}
      {status === "failed" && !hasFreshness && (
        <p className="text-2xs text-text-secondary">
          Couldn't load details. Hover again to retry, or click to open the {subject}.
        </p>
      )}
      <FreshnessMetaItem freshness={freshness} className="text-2xs text-text-secondary" />
    </div>
  );
}

function joinList(parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(". ") + ".";
}

interface DescribeOptions {
  /** Speak the title too — for a trigger whose own name doesn't carry it. */
  includeTitle?: boolean;
}

function describeMeta(
  data: IssueTooltipData | PRTooltipData,
  freshness: TooltipFreshness | undefined,
  { includeTitle = false }: DescribeOptions
): (string | null)[] {
  return [
    includeTitle ? data.title : null,
    data.bodyExcerpt || null,
    data.author ? `Created by ${data.author.login}` : null,
    data.assignees.length > 0
      ? `Assigned to ${data.assignees.map((u) => u.login).join(", ")}`
      : null,
    `Opened ${formatDate(data.createdAt)}`,
    data.labels.length > 0 ? `Labels: ${data.labels.map((l) => l.name).join(", ")}` : null,
    freshnessItem(freshness)?.label ?? null,
  ];
}

/**
 * What a screen reader hears for the issue card. The visual layout's rows and
 * chips carry the boundaries a sighted reader uses; flattened into the
 * tooltip's description they'd run together, so this spells them out as
 * sentences. The title is left out by default because it's the trigger's name;
 * a trigger that shows only the number asks for it with `includeTitle`.
 */
export function describeIssueTooltip(
  data: IssueTooltipData,
  freshness?: TooltipFreshness,
  options: DescribeOptions = {}
): string {
  return joinList([
    `${issueStateVisual(data.state).label} issue #${data.number}`,
    ...describeMeta(data, freshness, options),
  ]);
}

export function describePRTooltip(
  data: PRTooltipData,
  freshness?: TooltipFreshness,
  ciStatus?: CIStatus | null,
  options: DescribeOptions = {}
): string {
  const ci = getCIStatusVisual(ciStatus);
  return joinList([
    `${prStateLabel(data.state, data.isDraft)} pull request #${data.number}`,
    ci && (data.state === "open" || data.state === undefined) ? ci.ariaLabel : null,
    ...describeMeta(data, freshness, options),
  ]);
}
