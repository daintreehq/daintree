import { useId, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitMergeConflict,
  MessageSquare,
  X,
} from "lucide-react";
import type {
  PluginCheck,
  PluginCheckStatus,
  PluginChecksListProps,
  PluginForgeCiStatus,
  PluginForgeLabel,
  PluginForgeReviewDecision,
  PluginForgeRowBaseProps,
  PluginForgeState,
  PluginForgeStateBadgeProps,
  PluginIssueRowProps,
  PluginPullRequestRowProps,
} from "@shared/types/plugin-sdk-react";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LIST_ROW_HOVER_CLASS } from "@/components/ui/paletteRowStyles";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  getCheckOutcomeVisual,
  safeDetailsUrl,
  sanitizeCheckName,
} from "@/components/Worktree/ReviewHub/prChecks";
import { pluralize } from "@/lib/pluralize";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import { cn } from "@/lib/utils";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { useNow } from "../../../packages/plugin-sdk/src/react/useNow";
import {
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  positive,
  str,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { parseLabelHex, swatchNeedsEdge } from "./kitLabelColor";
import { useDaintreeTheme } from "@/pluginUi/theme";
import { toTimestamp } from "./kitTime";
import {
  FOCUS_RING,
  KitAvatar,
  KitTimeAgo,
  count,
  openForgeUrl,
  preventFocusSteal,
  Dot,
  readPerson,
  readPeople,
} from "./kitGitShared";
import { useRovingRows, roveFocus, roveKeyDown } from "./kitRovingRows";

// ---------------------------------------------------------------------------
// ForgeStateBadge, IssueRow and PullRequestRow

const FORGE_STATES = ["open", "closed", "merged", "draft"] as const;

interface ForgeStateLook {
  Glyph: typeof CircleDot;
  tone: string;
  word: string;
  label: string;
}

/** The github builtin's state map, forge-neutral: shape and colour agree, neither substitutes. */
export function forgeStateLook(kind: "issue" | "pr", state: PluginForgeState): ForgeStateLook {
  if (kind === "issue") {
    const open = state === "open";
    return {
      Glyph: open ? CircleDot : CircleCheck,
      tone: getPrStateColor(open ? "open" : "closed"),
      word: open ? "Open" : "Closed",
      label: open ? "Open issue" : "Closed issue",
    };
  }
  const draft = state === "draft";
  const prState = draft ? "open" : state;
  const word = draft
    ? "Draft"
    : state === "merged"
      ? "Merged"
      : state === "open"
        ? "Open"
        : "Closed";
  return {
    Glyph: getPrStateGlyph(prState, draft),
    tone: getPrStateColor(prState, draft),
    word,
    label: `${word} pull request`,
  };
}

export function KitForgeStateBadge({
  kind,
  state,
  variant,
  className,
  ...rest
}: PluginForgeStateBadgeProps) {
  const at = oneOf(state, FORGE_STATES);
  if (!at) return null;
  const forKind = oneOf(kind, ["issue", "pr"] as const) ?? "pr";
  // An issue is open or closed; any other state reads as closed.
  const shown = forKind === "issue" && at !== "open" ? "closed" : at;
  const look = forgeStateLook(forKind, shown);
  if (variant === "badge") {
    return (
      <Badge
        {...pickRootProps(rest)}
        data-forge-state={shown}
        size="sm"
        tone="outline"
        className={cn("text-text-primary", str(className))}
      >
        <look.Glyph aria-hidden="true" className={look.tone} />
        <span>{look.word}</span>
      </Badge>
    );
  }
  return (
    <span
      {...pickRootProps(rest)}
      data-forge-state={shown}
      role="img"
      aria-label={look.label}
      className={cn("inline-flex shrink-0", look.tone, str(className))}
    >
      <look.Glyph aria-hidden="true" className="h-4 w-4" />
    </span>
  );
}

interface CiLook {
  kind: "icon" | "dot";
  Glyph?: typeof Check;
  tone: string;
  label: string;
}

/** The github row's CI slot: a conflict takes it over any roll-up. Exported for tests. */
export function ciLook(ci: PluginForgeCiStatus | undefined, conflict: boolean): CiLook | null {
  if (conflict) {
    return {
      kind: "icon",
      Glyph: GitMergeConflict,
      tone: "text-status-warning",
      label: "Merge conflicts",
    };
  }
  switch (ci) {
    case "success":
      return { kind: "icon", Glyph: Check, tone: "text-status-success", label: "Checks passing" };
    case "failure":
      return { kind: "icon", Glyph: X, tone: "text-status-error", label: "Checks failing" };
    case "pending":
      return { kind: "dot", tone: "bg-status-warning", label: "Checks pending" };
    default:
      return null;
  }
}

const REVIEW_LOOK: Partial<
  Record<PluginForgeReviewDecision, { Glyph: typeof Check; tone: string; label: string }>
> = {
  changes_requested: {
    Glyph: CircleAlert,
    tone: "text-status-warning",
    label: "Changes requested",
  },
  approved: { Glyph: CircleCheck, tone: "text-status-success", label: "Approved" },
};

function readLabels(value: unknown): PluginForgeLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return [];
    const name = nonEmpty(field(raw, "name"));
    return name ? [{ name, color: str(field(raw, "color")) }] : [];
  });
}

/** A label's colour as the dot's fill variable, as `ColoredLabel` sets it. */
function labelDotStyle(rgb: readonly number[]): CSSProperties & Record<"--kit-label-dot", string> {
  return { "--kit-label-dot": `rgb(${rgb.join(", ")})` };
}

/**
 * The github row's label run: the first label as a dot and its name, then a
 * count for the rest, all of them named in the tooltip. Plain text rather than
 * chips, so a row of labels reads as metadata and never as a strip of buttons.
 */
function ForgeLabels({ labels, max }: { labels: PluginForgeLabel[]; max: number }) {
  const theme = useDaintreeTheme();
  const overlayZ = useKitOverlayZClass();
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  const names = labels.map((label) => label.name).join(", ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Labels: ${names}`}
          data-forge-labels=""
          className="inline-flex min-w-0 items-center gap-1.5"
        >
          {shown.map((label, index) => {
            const hex = parseLabelHex(label.color);
            return (
              <span
                key={`${index}:${label.name}`}
                aria-hidden="true"
                className="inline-flex min-w-0 items-center gap-1"
              >
                {hex ? (
                  <span
                    data-edged={
                      swatchNeedsEdge(label.color, theme.tokens["surface-panel"], theme.colorMode)
                        ? ""
                        : undefined
                    }
                    className="h-2 w-2 shrink-0 rounded-full bg-[var(--kit-label-dot)] data-[edged]:ring-1 data-[edged]:ring-text-secondary data-[edged]:ring-inset forced-colors:bg-[CanvasText]"
                    style={labelDotStyle(hex)}
                  />
                ) : null}
                <span className="max-w-[130px] truncate">{label.name}</span>
              </span>
            );
          })}
          {rest > 0 ? (
            <span aria-hidden="true" className="shrink-0 tabular-nums">
              +{rest}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {names}
      </TooltipContent>
    </Tooltip>
  );
}

interface ForgeRowExtra {
  look: ForgeStateLook;
  state: PluginForgeState;
  kind: "issue" | "pr";
  ci?: CiLook | null;
  review?: { Glyph: typeof Check; tone: string; label: string };
  headRef?: string;
  baseRef?: string;
}

function ForgeRow({ props, extra }: { props: PluginForgeRowBaseProps; extra: ForgeRowExtra }) {
  const {
    number,
    title,
    url,
    onOpen,
    author,
    assignees,
    labels,
    maxLabels,
    commentCount,
    updatedAt,
    timePrefix,
    selected,
    actions,
    titleTabIndex,
    className,
    ...rest
  } = props;
  const overlayZ = useKitOverlayZClass();
  const num =
    typeof number === "number" && Number.isFinite(number)
      ? String(number)
      : (nonEmpty(number) ?? "");
  const heading = str(title) ?? "";
  const titleTab =
    typeof titleTabIndex === "number" && Number.isInteger(titleTabIndex)
      ? titleTabIndex
      : undefined;
  const open = fn(onOpen);
  const href = safeDetailsUrl(str(url));
  const person = readPerson(author);
  const people = readPeople(assignees);
  const [lead, ...others] = people;
  const tags = readLabels(labels);
  const comments = count(commentCount) ?? 0;
  const age = toTimestamp(updatedAt);
  const titleClass = "min-w-0 flex-1 truncate text-left text-sm font-medium text-text-primary";
  const titleNode =
    open || href ? (
      <button
        type="button"
        data-forge-row-title=""
        tabIndex={titleTab}
        // Out of the tab order means the list owns focus: a press must not
        // take it either, or the list's search field stops hearing the arrows.
        onMouseDown={titleTab !== undefined && titleTab < 0 ? preventFocusSteal : undefined}
        aria-current={selected === true ? "true" : undefined}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          if (open) open();
          else openForgeUrl(href);
        }}
        className={cn(titleClass, "cursor-pointer rounded-sm hover:underline", FOCUS_RING)}
      >
        {heading}
      </button>
    ) : (
      <span className={titleClass}>{heading}</span>
    );
  const ci = extra.ci;
  return (
    <div
      {...pickRootProps(rest)}
      data-forge-row={extra.kind}
      data-forge-state={extra.state}
      data-selected={selected === true ? "true" : undefined}
      className={cn(
        // The github row's box: 64px, its state mark level with a 24px title line.
        "group relative flex min-h-16 items-start gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-150 ease-out",
        LIST_ROW_HOVER_CLASS,
        "data-[selected=true]:bg-overlay-highlight",
        str(className)
      )}
    >
      <span
        role="img"
        aria-label={extra.look.label}
        className={cn("mt-1 inline-flex shrink-0", extra.look.tone)}
      >
        <extra.look.Glyph aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex h-6 min-w-0 items-center gap-2">
          <TruncatedTooltip content={heading} contentClassName={overlayZ}>
            {titleNode}
          </TruncatedTooltip>
          <div data-rail="" className="flex shrink-0 items-center gap-1.5">
            {ci ? (
              <span
                data-rail-slot="ci"
                role="img"
                aria-label={ci.label}
                title={ci.label}
                className="flex h-3.5 w-4 shrink-0 items-center justify-center"
              >
                {ci.kind === "icon" && ci.Glyph ? (
                  <ci.Glyph aria-hidden="true" className={cn("h-3.5 w-3.5", ci.tone)} />
                ) : (
                  <span className={cn("status-mark block h-2 w-2 rounded-full", ci.tone)} />
                )}
              </span>
            ) : null}
            {lead ? (
              // The github row's assignee slot: a count of the rest to the
              // left, so the one avatar holds a single column down the list.
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-rail-slot="assignee"
                    role="img"
                    aria-label={`Assigned to ${people.map((p) => p.name).join(", ")}`}
                    className="flex shrink-0 items-center gap-1.5"
                  >
                    {others.length > 0 ? (
                      <span
                        aria-hidden="true"
                        className="text-3xs text-text-secondary tabular-nums"
                      >
                        +{others.length}
                      </span>
                    ) : null}
                    <KitAvatar name={lead.name} src={lead.avatarUrl} size="xs" decorative />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className={overlayZ}>
                  {`Assigned to ${people.map((p) => p.name).join(", ")}`}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {hasContent(actions) ? (
              <span className="flex shrink-0 items-center">{node(actions)}</span>
            ) : null}
          </div>
        </div>
        {/* One fixed 16px line that wraps what does not fit onto a second,
            hidden one: an item that cannot fit drops out whole, with its
            separator, rather than leaving a clipped fragment at the edge.
            Items are in the order they matter, so the labels go first. */}
        <div
          data-forge-row-meta=""
          className="mt-1 flex h-4 min-w-0 flex-wrap items-center gap-x-1.5 overflow-hidden text-xs leading-4 text-text-secondary"
        >
          <span className="shrink-0 tabular-nums">#{num}</span>
          {extra.review ? (
            <span
              role="img"
              aria-label={`Review: ${extra.review.label}`}
              className={cn("inline-flex shrink-0 items-center gap-1", extra.review.tone)}
            >
              <span aria-hidden="true" className="text-text-secondary">
                &middot;
              </span>
              <extra.review.Glyph aria-hidden="true" className="h-3 w-3" />
              <span>{extra.review.label}</span>
            </span>
          ) : null}
          {person ? (
            <span className="inline-flex max-w-[120px] shrink-0 items-center gap-1.5">
              <Dot />
              <TruncatedTooltip content={person.name} contentClassName={overlayZ} focusable={false}>
                <span className="min-w-0 truncate">{person.name}</span>
              </TruncatedTooltip>
            </span>
          ) : null}
          {!Number.isNaN(age) ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
              <Dot />
              <KitTimeAgo value={age} prefix={str(timePrefix)} />
            </span>
          ) : null}
          {comments > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Dot />
              <span
                role="img"
                aria-label={pluralize(comments, "comment")}
                className="inline-flex items-center gap-0.5 tabular-nums"
              >
                <MessageSquare aria-hidden="true" className="h-3 w-3" />
                <span aria-hidden="true">{comments}</span>
              </span>
            </span>
          ) : null}
          {extra.headRef ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={
                    extra.baseRef
                      ? `Merges ${extra.headRef} into ${extra.baseRef}`
                      : `From ${extra.headRef}`
                  }
                  // Placed on the line at 5ch, then grown into whatever room is
                  // left, up to its own width: the branch shows as much of
                  // itself as fits rather than all or nothing.
                  className="inline-flex max-w-max min-w-0 shrink-0 grow basis-[5ch] items-center gap-1.5"
                >
                  <Dot />
                  <span aria-hidden="true" className="min-w-0 max-w-[150px] truncate">
                    {extra.headRef}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className={overlayZ}>
                {extra.baseRef ? `${extra.headRef} → ${extra.baseRef}` : extra.headRef}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {tags.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Dot />
              <ForgeLabels labels={tags} max={positive(maxLabels, 20) ?? 1} />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function KitIssueRow(props: PluginIssueRowProps) {
  const state = props.state === "closed" ? "closed" : "open";
  return (
    <ForgeRow
      props={props}
      extra={{ kind: "issue", state, look: forgeStateLook("issue", state) }}
    />
  );
}

export function KitPullRequestRow(props: PluginPullRequestRowProps) {
  const state = oneOf(props.state, FORGE_STATES) ?? "open";
  const live = state === "open" || state === "draft";
  const ci = live
    ? ciLook(
        oneOf(props.ci, ["success", "failure", "pending", "neutral"] as const),
        props.mergeConflict === true
      )
    : null;
  const review = live
    ? REVIEW_LOOK[
        oneOf(props.review, ["approved", "changes_requested", "review_required"] as const) ??
          "review_required"
      ]
    : undefined;
  return (
    <ForgeRow
      props={props}
      extra={{
        kind: "pr",
        state,
        look: forgeStateLook("pr", state),
        ci,
        review,
        headRef: nonEmpty(props.headRef),
        baseRef: nonEmpty(props.baseRef),
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// ChecksList

const CHECK_STATUSES = [
  "queued",
  "running",
  "success",
  "failure",
  "skipped",
  "cancelled",
  "timed_out",
  "neutral",
  "action_required",
] as const satisfies readonly PluginCheckStatus[];

/** The words the summary counts in, in the order a reader acts on them. */
const CHECK_SUMMARY: { word: string; statuses: PluginCheckStatus[] }[] = [
  { word: "failing", statuses: ["failure", "timed_out"] },
  { word: "need action", statuses: ["action_required"] },
  { word: "cancelled", statuses: ["cancelled"] },
  { word: "running", statuses: ["running"] },
  { word: "queued", statuses: ["queued"] },
  { word: "passing", statuses: ["success"] },
  { word: "skipped", statuses: ["skipped"] },
  { word: "neutral", statuses: ["neutral"] },
];

/** "3 failing, 1 running, 12 passing". Exported for tests. */
export function checksSummary(statuses: readonly PluginCheckStatus[]): string {
  return CHECK_SUMMARY.flatMap(({ word, statuses: members }) => {
    const n = statuses.filter((status) => members.includes(status)).length;
    return n > 0 ? [`${n} ${word}`] : [];
  }).join(", ");
}

function checkRank(status: PluginCheckStatus): number {
  if (status === "failure" || status === "timed_out") return 0;
  if (status === "action_required" || status === "cancelled") return 1;
  if (status === "running" || status === "queued") return 2;
  return 3;
}

function asCheckRun(status: PluginCheckStatus): ForgeCheckRun {
  if (status === "queued") return { name: "", status: "queued" };
  if (status === "running") return { name: "", status: "in_progress" };
  return { name: "", status: "completed", conclusion: status };
}

interface CheckEntry {
  check: PluginCheck;
  key: string;
  name: string;
  status: PluginCheckStatus;
  workflow?: string;
  required?: boolean;
  duration: number | null;
  started: number;
  detailsUrl?: string;
  index: number;
}

function readChecks(value: unknown): CheckEntry[] {
  if (!Array.isArray(value)) return [];
  const out: CheckEntry[] = [];
  // Keys are the kit's own: an author id shapes one, but a repeated or
  // colliding id can never make two checks share it.
  const used = new Set<string>();
  value.forEach((raw: PluginCheck, index) => {
    if (typeof raw !== "object" || raw === null) return;
    const status = oneOf(field(raw, "status"), CHECK_STATUSES);
    if (!status) return;
    const name = sanitizeCheckName(str(field(raw, "name")) ?? "");
    const durationMs = field(raw, "durationMs");
    const started = toTimestamp(field(raw, "startedAt"));
    const finished = toTimestamp(field(raw, "finishedAt"));
    const required = field(raw, "required");
    out.push({
      check: raw,
      key: (() => {
        const id = nonEmpty(field(raw, "id"));
        const key = id !== undefined && !used.has(`id:${id}`) ? `id:${id}` : `at:${index}`;
        used.add(key);
        return key;
      })(),
      name,
      status,
      workflow: nonEmpty(field(raw, "workflow")),
      required: typeof required === "boolean" ? required : undefined,
      duration:
        typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
          ? durationMs
          : !Number.isNaN(started) && !Number.isNaN(finished) && finished >= started
            ? finished - started
            : null,
      started,
      detailsUrl: safeDetailsUrl(str(field(raw, "detailsUrl"))),
      index,
    });
  });
  return out;
}

function sortChecks(entries: CheckEntry[]): CheckEntry[] {
  return [...entries].sort((a, b) => {
    const rank = checkRank(a.status) - checkRank(b.status);
    if (rank !== 0) return rank;
    const required = (a.required === true ? 0 : 1) - (b.required === true ? 0 : 1);
    return required !== 0 ? required : a.index - b.index;
  });
}

function checkDuration(entry: CheckEntry, now: number): string | null {
  if (entry.status === "running" && entry.duration === null && !Number.isNaN(entry.started)) {
    return formatElapsedDuration(Math.max(0, now - entry.started));
  }
  return entry.duration === null ? null : formatElapsedDuration(entry.duration);
}

function CheckRow({
  entry,
  now,
  detailsLabel,
  onDetails,
  reserveDetails,
}: {
  entry: CheckEntry;
  now: number;
  detailsLabel: string;
  onDetails?: () => void;
  /** Holds the details button's slot open, so every duration shares one column. */
  reserveDetails: boolean;
}) {
  const { visual } = getCheckOutcomeVisual(asCheckRun(entry.status));
  const { Icon, toneClass, label } = visual;
  const duration = checkDuration(entry, now);
  const outcome =
    entry.required === true
      ? `${label} · Required`
      : entry.required === false
        ? `${label} · Not required`
        : label;
  return (
    <li
      data-check-status={entry.status}
      data-kit-rove-row=""
      className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-overlay-subtle focus-within:bg-overlay-subtle"
    >
      <Icon aria-hidden="true" className={cn("mt-px h-3.5 w-3.5 shrink-0", toneClass)} />
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium text-text-primary">{entry.name}</span>
        <span className="block text-text-secondary">{outcome}</span>
      </span>
      {duration ? (
        <span className="shrink-0 pt-px text-2xs text-text-secondary tabular-nums">{duration}</span>
      ) : null}
      {onDetails ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDetails}
          aria-label={detailsLabel}
          data-kit-rove=""
          className="-my-1 shrink-0 [&_svg]:size-3.5"
        >
          <ExternalLink aria-hidden="true" />
        </Button>
      ) : reserveDetails ? (
        <span aria-hidden="true" className="w-6 shrink-0" />
      ) : null}
    </li>
  );
}

export function KitChecksList({
  checks,
  title,
  summary,
  actions,
  onOpenDetails,
  empty,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginChecksListProps) {
  const entries = readChecks(checks);
  const openDetails = fn(onOpenDetails);
  const ticking = entries.some(
    (entry) => entry.status === "running" && !Number.isNaN(entry.started)
  );
  const now = useNow({ intervalMs: ticking ? 1000 : 60_000 });
  const line = checksSummary(entries.map((entry) => entry.status));
  const showSummary = summary !== false && line !== "";
  const hasHeader = hasContent(title) || showSummary || hasContent(actions);
  const sectionRef = useRef<HTMLElement>(null);
  useRovingRows(sectionRef);
  const baseId = useId();
  // The Review Hub's fold: while something needs a look, the clean results in
  // each workflow wait behind a count, so the reader never scrolls past passes
  // to find the failure in the next group.
  const needsLook = entries.some((entry) => checkRank(entry.status) < 3);
  const [shownSettled, setShownSettled] = useState<ReadonlySet<string>>(() => new Set());

  // Groups in the order their worst check ranks, first seen breaking ties.
  const groups = new Map<string, CheckEntry[]>();
  for (const entry of entries) {
    const key = entry.workflow ?? "";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const ordered = [...groups.entries()]
    .map(([workflow, members], order) => ({
      workflow,
      members: sortChecks(members),
      worst: Math.min(...members.map((member) => checkRank(member.status))),
      order,
    }))
    .sort((a, b) => a.worst - b.worst || a.order - b.order);
  const grouped = ordered.some((group) => group.workflow !== "");

  // Matrix jobs repeat names: an ordinal tells two identical buttons apart.
  const base = new Map(
    entries.map((entry) => [
      entry.key,
      `${entry.workflow ? `${entry.workflow} / ` : ""}${entry.name}`,
    ])
  );
  const totals = new Map<string, number>();
  for (const text of base.values()) totals.set(text, (totals.get(text) ?? 0) + 1);
  const seen = new Map<string, number>();
  const detailsLabels = new Map<string, string>();
  for (const entry of entries) {
    const text = base.get(entry.key) ?? entry.name;
    const nth = (seen.get(text) ?? 0) + 1;
    seen.set(text, nth);
    const total = totals.get(text) ?? 1;
    detailsLabels.set(
      entry.key,
      `Open details for ${text}${total > 1 ? `, ${nth} of ${total}` : ""}`
    );
  }

  const detailsFor = (entry: CheckEntry) => {
    if (openDetails) return () => openDetails(entry.check);
    const url = entry.detailsUrl;
    return url ? () => openForgeUrl(url) : undefined;
  };
  const reserveDetails = entries.some((entry) => detailsFor(entry) !== undefined);

  return (
    <section
      {...pickRootProps(rest)}
      ref={sectionRef}
      onFocus={roveFocus}
      onKeyDown={roveKeyDown}
      aria-label={nonEmpty(ariaLabel)}
      data-kit-checks-list=""
      className={cn("flex min-w-0 flex-col text-xs", str(className))}
    >
      {hasHeader ? (
        <div className="flex min-h-7 shrink-0 items-center gap-2 pr-1.5 pl-2">
          {hasContent(title) ? (
            <h3 className={cn(SECTION_LABEL_CLASS, "m-0 shrink-0")}>{node(title)}</h3>
          ) : null}
          {showSummary ? (
            <span
              data-kit-checks-summary=""
              className="min-w-0 flex-1 py-1 text-xs font-medium text-text-primary tabular-nums"
            >
              {line}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {hasContent(actions) ? (
            <div className="flex shrink-0 items-center gap-0.5">{node(actions)}</div>
          ) : null}
        </div>
      ) : null}
      {entries.length === 0 ? (
        hasContent(empty) ? (
          <div className="px-2 py-2 text-text-secondary">{node(empty)}</div>
        ) : null
      ) : (
        ordered.map((group) => (
          <div key={`workflow:${group.workflow}`} data-kit-checks-group={group.workflow}>
            {grouped ? (
              <div className="flex items-center gap-2 px-2 pt-2 pb-1">
                <span className="min-w-[8ch] flex-1 truncate font-medium text-text-secondary">
                  {group.workflow || "Other checks"}
                </span>
                <span className="min-w-0 shrink text-right text-2xs text-text-secondary tabular-nums">
                  {checksSummary(group.members.map((member) => member.status))}
                </span>
              </div>
            ) : null}
            {(() => {
              const settled = group.members.filter((member) => checkRank(member.status) === 3);
              const folds =
                needsLook && settled.length > 0 && settled.length < group.members.length;
              const open = !folds || shownSettled.has(group.workflow);
              const visible = open
                ? group.members
                : group.members.filter((member) => checkRank(member.status) < 3);
              const listId = `${baseId}-${group.order}`;
              return (
                <>
                  <ul
                    id={listId}
                    aria-label={grouped ? group.workflow || "Other checks" : undefined}
                    className="m-0 flex list-none flex-col p-0"
                  >
                    {visible.map((entry) => (
                      <CheckRow
                        key={entry.key}
                        entry={entry}
                        now={now}
                        detailsLabel={
                          detailsLabels.get(entry.key) ?? `Open details for ${entry.name}`
                        }
                        onDetails={detailsFor(entry)}
                        reserveDetails={reserveDetails}
                      />
                    ))}
                  </ul>
                  {folds ? (
                    <div data-kit-rove-row="">
                      <button
                        type="button"
                        data-kit-rove=""
                        data-kit-checks-fold=""
                        aria-expanded={open}
                        aria-controls={listId}
                        onClick={() =>
                          setShownSettled((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.workflow)) next.delete(group.workflow);
                            else next.add(group.workflow);
                            return next;
                          })
                        }
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary",
                          FOCUS_RING,
                          "focus-visible:-outline-offset-2"
                        )}
                      >
                        <ChevronRight
                          aria-hidden="true"
                          data-animated-chevron
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-transform duration-150 ease-out",
                            open && "rotate-90"
                          )}
                        />
                        {open ? "Hide" : "Show"}{" "}
                        {checksSummary(settled.map((member) => member.status))}
                      </button>
                    </div>
                  ) : null}
                </>
              );
            })()}
          </div>
        ))
      )}
    </section>
  );
}
