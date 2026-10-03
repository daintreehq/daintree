import {
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { X } from "lucide-react";
import { Virtuoso, type ItemProps, type ListProps, type ScrollerProps } from "react-virtuoso";
import type {
  PluginAvatarGroupProps,
  PluginChartColor,
  PluginDiffStatProps,
  PluginFilterChipProps,
  PluginHighlightedTextProps,
  PluginMeterProps,
  PluginSegmentedBarProps,
  PluginSeverity,
  PluginTimelineItem,
  PluginTimelineProps,
} from "@shared/types/plugin-sdk-react";
import { DiffStat } from "@/components/ui/DiffStat";
import { FilterChip } from "@/components/ui/FilterChip";
import { HighlightedText, substringMatchIndices } from "@/components/ui/HighlightedText";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { formatAbsoluteDate } from "@/utils/timeAgo";
import {
  cssLength,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  positive,
  str,
  PluginStyleScope,
} from "./kitProps";
import {
  COLORS,
  Swatch,
  chartColor,
  foldParts,
  share,
  slotColors,
  valueFormats,
} from "./PluginKitCharts";
import { renderIconSource } from "./PluginKitIcons";
import { pluginKitOverlays } from "./PluginKitOverlays";
import { severityGlyph } from "./PluginKitPatterns";
import { useKitOverlayZClass } from "./kitScope";

const KitAvatar = pluginKitOverlays.Avatar;

const TONES = [
  "error",
  "danger",
  "warning",
  "success",
  "info",
  "neutral",
] as const satisfies readonly PluginSeverity[];

const TONE_WORD: Record<PluginSeverity, string> = {
  error: "Error",
  danger: "Danger",
  warning: "Warning",
  success: "Success",
  info: "Info",
  neutral: "",
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// A removable chip is an applied filter, so it stays pressed and its click
// takes it off: the one tab stop and the one action, rather than a second
// button nested beside the label. A long label ellipsises in the host chip's
// slot and reads in full in the chip's one tooltip, above the remove hint.
function KitFilterChip({
  children,
  selected,
  defaultSelected,
  onSelectedChange,
  count,
  onRemove,
  removeLabel,
  disabled,
  className,
  ...rest
}: PluginFilterChipProps) {
  const overlayZ = useKitOverlayZClass();
  const [internal, setInternal] = useState(defaultSelected === true);
  const controlled = typeof selected === "boolean";
  const remove = fn(onRemove);
  const change = fn(onSelectedChange);
  const { onClick, onKeyDown, ...dom } = pickDomProps(rest);
  const clickHandler = typeof onClick === "function" ? onClick : undefined;
  const keyHandler = typeof onKeyDown === "function" ? onKeyDown : undefined;
  const pressed = remove ? true : controlled ? selected : internal;
  const { ref: labelRef, isTruncated } = useTruncationDetection();
  const label = node(children);
  const chip = (
    <FilterChip
      {...dom}
      labelRef={labelRef}
      selected={pressed}
      count={remove ? undefined : finiteNumber(count)}
      disabled={disabled === true}
      className={str(className)}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (clickHandler) Reflect.apply(clickHandler, undefined, [event]);
        if (event.defaultPrevented) return;
        if (remove) {
          remove();
          return;
        }
        if (!controlled) setInternal(!pressed);
        change?.(!pressed);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (keyHandler) Reflect.apply(keyHandler, undefined, [event]);
        if (event.defaultPrevented || !remove) return;
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          remove();
        }
      }}
    >
      {label}
      {remove ? <X className="-mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> : null}
    </FilterChip>
  );
  const hint = remove ? (nonEmpty(removeLabel) ?? "Remove filter") : null;
  // Mounted whether or not the label clips, so a resize never remounts the
  // chip under focus; closed while there is nothing to say.
  return (
    <Tooltip open={isTruncated || hint ? undefined : false} autoDismiss={!isTruncated}>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {isTruncated ? (
          <PluginStyleScope block className="break-words">
            {label}
          </PluginStyleScope>
        ) : null}
        {hint ? (
          <div className={isTruncated ? "text-text-secondary" : undefined}>{hint}</div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function readRanges(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: [number, number][] = [];
  for (const range of value) {
    if (!Array.isArray(range)) continue;
    const [start, end] = range;
    if (Number.isInteger(start) && Number.isInteger(end)) out.push([start, end]);
  }
  return out;
}

function KitHighlightedText({
  text,
  query,
  ranges,
  className,
  ...rest
}: PluginHighlightedTextProps) {
  const value = str(text) ?? "";
  const explicit = readRanges(ranges);
  const indices = explicit ?? substringMatchIndices(value, str(query) ?? "");
  return (
    <span {...pickRootProps(rest)} className={str(className)}>
      <HighlightedText text={value} indices={indices} />
    </span>
  );
}

function KitDiffStat({ additions, deletions, className, ...rest }: PluginDiffStatProps) {
  const added = finiteNumber(additions);
  const removed = finiteNumber(deletions);
  return (
    <DiffStat
      {...pickRootProps(rest)}
      insertions={added === undefined ? undefined : Math.floor(added)}
      deletions={removed === undefined ? undefined : Math.floor(removed)}
      className={str(className)}
    />
  );
}

const AVATAR_SIZES = ["xs", "sm", "md", "lg"] as const;
const DEFAULT_AVATAR_MAX = 4;
// Past this many names the tooltip stops listing and counts the rest, so a
// channel of 300 members is not a tooltip taller than the window.
const OVERFLOW_NAMES_SHOWN = 10;

// Each disc's right side is covered by the next disc's overlap plus its
// cut-out ring; what is left must still hold the initials centred in it, or
// "GH" reads "G(". The overlap is sized from that, per size: the disc's edge
// in px, the initials `Avatar` draws at that size and their type size. Pinned
// by the kit tests, which read the classes below back as pixels.
export const AVATAR_GROUP_FIT = {
  xs: { px: 16, overlap: 2, initials: 1, fontPx: 10 },
  sm: { px: 20, overlap: 4, initials: 1, fontPx: 10 },
  md: { px: 24, overlap: 2, initials: 2, fontPx: 10 },
  lg: { px: 32, overlap: 4, initials: 2, fontPx: 11 },
} as const;
export const AVATAR_CUTOUT_PX = 2;

export const GROUP_OVERLAP = {
  xs: "-space-x-0.5",
  sm: "-space-x-1",
  md: "-space-x-0.5",
  lg: "-space-x-1",
} as const;

const OVERFLOW_SIZE = {
  xs: "h-4 min-w-4 text-3xs",
  sm: "h-5 min-w-5 text-3xs",
  md: "h-6 min-w-6 text-2xs",
  lg: "h-8 min-w-8 text-2xs",
} as const;

// The cut-out between overlapping discs is the pane's own canvas, the same
// ring the fleet dots draw. The strong hairline inside it is each disc's own
// edge: the initials' neutral fill barely steps off a dark canvas, so without
// it the discs and the gaps between them read as one smudge.
const CUTOUT = "ring-2 ring-surface-canvas border border-border-strong";

interface GroupAvatar {
  name: string;
  src: string | undefined;
  shape: "circle" | "square" | undefined;
}

function readAvatars(value: unknown): GroupAvatar[] {
  if (!Array.isArray(value)) return [];
  const out: GroupAvatar[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = nonEmpty(field(entry, "name"));
    if (name === undefined) continue;
    out.push({
      name,
      src: str(field(entry, "src")),
      shape: oneOf(field(entry, "shape"), ["circle", "square"] as const),
    });
  }
  return out;
}

function KitAvatarGroup({
  avatars,
  max,
  size,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginAvatarGroupProps) {
  const overlayZ = useKitOverlayZClass();
  const people = readAvatars(avatars);
  const px = oneOf(size, AVATAR_SIZES) ?? "sm";
  const limit = Math.floor(positive(max, 1000) ?? DEFAULT_AVATAR_MAX);
  const shown = people.slice(0, limit);
  const hidden = people.slice(limit);
  const label = nonEmpty(ariaLabel);
  const listed = hidden.slice(0, OVERFLOW_NAMES_SHOWN).map((person) => person.name);
  const unlisted = hidden.length - listed.length;
  const spoken = `${hidden.length} more: ${listed.join(", ")}${unlisted > 0 ? `, and ${unlisted} more` : ""}`;
  return (
    <div
      {...pickRootProps(rest)}
      {...(label ? { role: "group", "aria-label": label } : {})}
      className={cn("inline-flex items-center", GROUP_OVERLAP[px], str(className))}
    >
      {shown.map((person, index) => (
        <KitAvatar
          key={`${index}:${person.name}`}
          name={person.name}
          src={person.src}
          size={px}
          shape={person.shape}
          tooltip={person.name}
          className={cn(CUTOUT, person.shape === "square" ? "rounded-xs" : "rounded-full")}
        />
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              tabIndex={0}
              aria-label={spoken}
              className={cn(
                "relative inline-flex shrink-0 items-center justify-center rounded-full bg-overlay-medium px-1 font-medium leading-none tabular-nums text-text-secondary",
                OVERFLOW_SIZE[px],
                CUTOUT
              )}
            >
              +{hidden.length.toLocaleString()}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className={overlayZ}>
            <div className="flex flex-col">
              {listed.map((name, index) => (
                <span key={index}>{name}</span>
              ))}
              {unlisted > 0 ? <span>{`and ${pluralize(unlisted, "other")}`}</span> : null}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

type MeterTone = "neutral" | "warning" | "danger";

const METER_FILL: Record<MeterTone, string> = {
  neutral: "bg-text-secondary",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
};

function fraction(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

/** The tone a meter at `ratio` of its limit takes. Exported for tests. */
export function meterTone(ratio: number, thresholds: unknown): MeterTone {
  if (typeof thresholds !== "object" || thresholds === null) return "neutral";
  const danger = fraction(field(thresholds, "danger"));
  const warning = fraction(field(thresholds, "warning"));
  if (danger !== undefined && ratio >= danger) return "danger";
  if (warning !== undefined && ratio >= warning) return "warning";
  return "neutral";
}

interface TrackMark {
  key: string;
  /** Where along the track, 0 to 1. */
  at: number;
  value: number;
  label: string;
  head: boolean;
}

/** Marks from untyped JS on a track `limit` long: a finite value and a label each, clamped onto the track. */
function readMarks(value: unknown, limit: number): TrackMark[] {
  if (!Array.isArray(value)) return [];
  const out: TrackMark[] = [];
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const at = finiteNumber(field(entry, "value"));
    const label = nonEmpty(field(entry, "label"));
    if (at === undefined || label === undefined) return;
    const clamped = Math.min(limit, Math.max(0, at));
    out.push({
      key: `${index}`,
      at: limit > 0 ? clamped / limit : 0,
      value: clamped,
      label,
      head: field(entry, "head") === true,
    });
  });
  return out;
}

type TrackSize = "sm" | "md";

const TRACK_HEIGHT: Record<TrackSize, string> = { sm: "h-1.5", md: "h-2.5" };
// The track's height plus 4px above and below.
const MARK_PX: Record<TrackSize, number> = { sm: 14, md: 18 };
const MARK_BOX: Record<TrackSize, string> = { sm: "h-4", md: "h-5" };
const MARK_BOX_W = 9;

// A 3px rule with an optional 7px cap, outlined in the panel's surface so it
// stands off whatever fill runs under it: the stroke paints first and the
// fill over its inner half, leaving a 1px halo.
function markPath(height: number, head: boolean): string {
  const top = 1;
  const bottom = top + height;
  const stem = `M3,${top}H6V${bottom}H3Z`;
  return head ? `${stem}M1,${top}H8V${top + 2.5}H1Z` : stem;
}

function TrackMarks({ marks, size }: { marks: TrackMark[]; size: TrackSize }) {
  const overlayZ = useKitOverlayZClass();
  const height = MARK_PX[size];
  return (
    <>
      {marks.map((mark) => (
        <Tooltip key={mark.key}>
          <TooltipTrigger asChild>
            <span
              aria-hidden="true"
              data-track-mark={mark.head ? "head" : ""}
              className={cn(
                "absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center",
                MARK_BOX[size]
              )}
              style={{ left: `${mark.at * 100}%`, width: MARK_BOX_W }}
            >
              <svg width={MARK_BOX_W} height={height + 2} className="block shrink-0">
                <path
                  d={markPath(height, mark.head)}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  className="fill-text-primary stroke-surface-panel"
                />
              </svg>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className={overlayZ}>
            {mark.label}
          </TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}

/** The marks in words, for a track's spoken value: "Target at 80%". */
function marksText(marks: TrackMark[], at: (mark: TrackMark) => string): string {
  return marks.map((mark) => `${mark.label} at ${at(mark)}`).join(", ");
}

// The quota meters' instrument (settings, rate limits): a heavier track than
// ProgressBar's, because a level is read at rest where progress is watched.
function KitMeter({
  value,
  max,
  label,
  showLabel,
  valueText,
  thresholds,
  marks,
  readout: showReadout,
  readoutWidth,
  className,
  ...rest
}: PluginMeterProps) {
  const limit = positive(max, Number.MAX_VALUE) ?? 1;
  const amount = Math.min(limit, Math.max(0, finiteNumber(value) ?? 0));
  const ratio = amount / limit;
  const tone = meterTone(ratio, thresholds);
  const name = nonEmpty(label) ?? "Usage";
  const text = nonEmpty(valueText) ?? `${Math.round(ratio * 100)}%`;
  const glyph = tone === "neutral" ? null : severityGlyph(tone, "h-3 w-3");
  const stacked = showLabel !== false;
  const visible = showReadout !== false;
  const width = cssLength(readoutWidth);
  const references = readMarks(marks, limit);
  const spoken = tone === "neutral" ? text : `${text}, ${TONE_WORD[tone].toLowerCase()}`;
  const readout =
    visible || glyph ? (
      <span
        className={cn(
          "inline-flex min-w-0 shrink-0 items-center gap-1 text-2xs tabular-nums text-text-secondary",
          width !== undefined && "justify-end"
        )}
        style={width !== undefined && visible ? { width } : undefined}
      >
        {glyph}
        {visible ? <span className="truncate">{text}</span> : null}
      </span>
    ) : null;
  const track = (
    <div
      {...pickRootProps(rest, { aria: true })}
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={amount}
      aria-valuetext={
        references.length > 0
          ? `${spoken}; ${marksText(references, (mark) => `${Math.round(mark.at * 100)}%`)}`
          : spoken
      }
      data-tone={tone}
      className={cn(
        "h-1.5 overflow-hidden rounded-full bg-overlay-emphasis",
        stacked || references.length > 0 ? "w-full" : "min-w-0 flex-1"
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-150 ease-out",
          METER_FILL[tone]
        )}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
  // The marks rise past the track's clipped edge, so they sit in a box beside it.
  const bar =
    references.length > 0 ? (
      <div className={cn("relative", stacked ? "w-full" : "min-w-0 flex-1")}>
        {track}
        <TrackMarks marks={references} size="sm" />
      </div>
    ) : (
      track
    );
  if (!stacked) {
    return (
      <div className={cn("flex min-w-0 items-center gap-2", str(className))}>
        {bar}
        {readout}
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", str(className))}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span aria-hidden="true" className="min-w-0 truncate text-xs font-medium text-text-primary">
          {name}
        </span>
        {readout}
      </div>
      {bar}
    </div>
  );
}

const DEFAULT_ENTRY_PX = 44;
const DAY_MS = 24 * 60 * 60 * 1000;

type TimelineRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "entry"; key: string; item: PluginTimelineItem; index: number; railBelow: boolean };

function timestampOf(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string" && !(value instanceof Date)) {
    return undefined;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Today", "Yesterday", or the date the relative times fall back to. Exported for tests. */
export function timelineDayLabel(ms: number, now: number): string {
  const key = dayKey(ms);
  if (key === dayKey(now)) return "Today";
  // Noon, not midnight, so a daylight-saving shift cannot land on the wrong day.
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  if (key === dayKey(noon.getTime() - DAY_MS)) return "Yesterday";
  return formatAbsoluteDate(ms, now);
}

/** The rows a timeline draws: its entries, with a header before each new day when grouped. Exported for tests. */
export function timelineRows(
  items: readonly PluginTimelineItem[],
  groupByDay: boolean,
  now: number
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const seenIds = new Set<string>();
  let currentDay: string | undefined;
  items.forEach((item, index) => {
    if (groupByDay) {
      const ms = timestampOf(item.timestamp);
      const key = ms === undefined ? undefined : dayKey(ms);
      if (ms !== undefined && key !== currentDay) {
        currentDay = key;
        rows.push({ kind: "day", key: `day:${key}:${index}`, label: timelineDayLabel(ms, now) });
      }
    }
    // A duplicate id would key two rows the same; the second falls back to its index.
    const id = `${typeof item.id}:${String(item.id)}`;
    const key = seenIds.has(id) ? `index:${index}` : `entry:${id}`;
    seenIds.add(id);
    rows.push({ kind: "entry", key, item, index, railBelow: true });
  });
  rows.forEach((row, at) => {
    if (row.kind === "entry") row.railBelow = rows[at + 1]?.kind === "entry";
  });
  return rows;
}

function readItems(value: unknown): PluginTimelineItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PluginTimelineItem => {
    if (typeof entry !== "object" || entry === null) return false;
    const id = field(entry, "id");
    return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  });
}

// Tints a plugin's own marker icon. `success` stays neutral: an entry on the
// feed is standing history, and green belongs to the severity glyph of a
// result (docs/themes/status-success-policy.md).
const MARKER_TONE_CLASS: Record<PluginSeverity, string> = {
  neutral: "text-text-secondary",
  success: "text-text-secondary",
  info: "text-status-info",
  warning: "text-status-warning",
  error: "text-status-error",
  danger: "text-status-danger",
};

function TimelineMarker({ icon, tone }: { icon: unknown; tone: PluginSeverity | undefined }) {
  const element = renderIconSource(icon);
  if (element) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-3.5 w-3.5 shrink-0 [&>svg]:size-full",
          MARKER_TONE_CLASS[tone ?? "neutral"]
        )}
      >
        {element}
      </span>
    );
  }
  if (tone && tone !== "neutral") return severityGlyph(tone, "h-3.5 w-3.5");
  // A bordered dot rather than a filled disc: forced colours drop backgrounds
  // but keep borders, so the marker survives there.
  return (
    <span aria-hidden="true" className="h-2 w-2 rounded-full border-2 border-text-secondary" />
  );
}

function ActorView({ actor }: { actor: unknown }) {
  if (typeof actor === "string") {
    return actor ? <span className="font-medium text-text-primary">{actor}</span> : null;
  }
  if (typeof actor !== "object" || actor === null) return null;
  const name = nonEmpty(field(actor, "name"));
  if (!name) return null;
  const src = str(field(actor, "src"));
  return (
    <span className="inline-flex min-w-0 items-center gap-1 align-bottom">
      {src ? (
        <KitAvatar
          name={name}
          src={src}
          size="xs"
          decorative
          shape={oneOf(field(actor, "shape"), ["circle", "square"] as const)}
        />
      ) : null}
      <span className="truncate font-medium text-text-primary">{name}</span>
    </span>
  );
}

interface TimelineContext {
  label: string;
  identity: Record<string, string | number | boolean>;
}

function TimelineScroller({
  context: _context,
  ref,
  ...props
}: ScrollerProps & { context: TimelineContext; ref?: Ref<HTMLDivElement> }) {
  // Focusable so the keyboard can scroll a feed whose rows hold no controls.
  return <div {...props} ref={ref} tabIndex={0} />;
}

function TimelineList({
  context,
  ref,
  style,
  children,
}: ListProps & { context: TimelineContext; ref?: Ref<HTMLDivElement> }) {
  return (
    <div {...context.identity} ref={ref} style={style} role="list" aria-label={context.label}>
      {children}
    </div>
  );
}

function TimelineListItem({
  context: _context,
  item: _item,
  ...props
}: ItemProps<unknown> & { context: TimelineContext }) {
  return <div {...props} role="listitem" />;
}

const TIMELINE_COMPONENTS = {
  Scroller: TimelineScroller,
  List: TimelineList,
  Item: TimelineListItem,
};

function TimelineEntry({
  row,
  now,
  verbose,
  renderContent,
}: {
  row: Extract<TimelineRow, { kind: "entry" }>;
  now: number;
  verbose: boolean;
  renderContent: ((item: PluginTimelineItem, index: number) => ReactNode) | undefined;
}) {
  const { item, index } = row;
  const tone = oneOf(item.tone, TONES);
  const ms = timestampOf(item.timestamp);
  const custom = renderContent ? node(renderContent(item, index)) : null;
  const actor = <ActorView actor={item.actor} />;
  const hasActor =
    (typeof item.actor === "string" && item.actor !== "") ||
    (typeof item.actor === "object" && item.actor !== null && nonEmpty(field(item.actor, "name")));
  return (
    <div className="flex gap-2.5 px-3" data-timeline-entry="">
      <div className="relative flex w-5 shrink-0 flex-col items-center">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <TimelineMarker icon={item.icon} tone={tone} />
        </span>
        {row.railBelow ? (
          <span
            aria-hidden="true"
            data-timeline-rail=""
            className="w-0 flex-1 border-l border-border-default"
          />
        ) : null}
      </div>
      <div className={cn("min-w-0 flex-1 pt-0.5", row.railBelow ? "pb-4" : "pb-1")}>
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="min-w-0 flex-1 text-xs text-text-primary">
            {tone && tone !== "neutral" ? (
              <span className="sr-only">{`${TONE_WORD[tone]}: `}</span>
            ) : null}
            {hasActor ? <>{actor} </> : null}
            {node(item.title)}
          </div>
          {ms !== undefined ? (
            <TimeAgo
              timestamp={ms}
              now={now}
              verbose={verbose}
              className="shrink-0 text-2xs text-text-secondary"
            />
          ) : null}
        </div>
        {hasContent(item.description) ? (
          <div className="mt-0.5 min-w-0 text-xs text-text-secondary">{node(item.description)}</div>
        ) : null}
        {hasContent(custom) ? <div className="mt-1.5 min-w-0">{custom}</div> : null}
      </div>
    </div>
  );
}

function KitTimeline({
  items,
  "aria-label": ariaLabel,
  renderContent,
  groupByDay,
  timeFormat,
  now,
  estimatedItemSize,
  onEndReached,
  className,
  ...rest
}: PluginTimelineProps) {
  const tick = useGlobalMinuteClock();
  const clock = finiteNumber(now) ?? tick;
  const rows = timelineRows(readItems(items), groupByDay === true, clock);
  const render = fn(renderContent);
  const endReached = fn(onEndReached);
  const verbose = timeFormat === "verbose";
  const rowPx = positive(estimatedItemSize, 10_000) ?? DEFAULT_ENTRY_PX;
  // As tall as its rows up to the container, so a short feed sits in flow
  // without a sized parent and a long one scrolls inside a sized pane.
  const [listPx, setListPx] = useState<number | null>(null);
  const context: TimelineContext = {
    label: str(ariaLabel) ?? "",
    identity: pickRootProps(rest),
  };
  const lastEntry = rows.reduce((last, row) => (row.kind === "entry" ? row.index : last), -1);
  return (
    <div
      className={cn("max-h-full min-h-0", str(className))}
      style={{ height: listPx ?? rows.length * rowPx }}
    >
      <Virtuoso
        className="focus-visible:-outline-offset-2"
        style={{ height: "100%" }}
        context={context}
        components={TIMELINE_COMPONENTS}
        data={rows}
        defaultItemHeight={rowPx}
        increaseViewportBy={rowPx * 4}
        computeItemKey={(_index, row) => row.key}
        totalListHeightChanged={(height) => setListPx(Math.ceil(height))}
        endReached={endReached && lastEntry >= 0 ? () => endReached(lastEntry) : undefined}
        itemContent={(_index, row) =>
          row.kind === "day" ? (
            <div className="px-3 pt-2 pb-1.5 text-xs font-medium text-text-secondary">
              {row.label}
            </div>
          ) : (
            <TimelineEntry row={row} now={clock} verbose={verbose} renderContent={render} />
          )
        }
      />
    </div>
  );
}

interface BarPart {
  key: string;
  label: string;
  value: number;
  color: string;
  /** The value in words, or the formatted value and share. */
  text: string;
  /** The formatted value, `undefined` when the plugin's `valueText` stands in. */
  figure: string | undefined;
  share: string | undefined;
}

/**
 * A SegmentedBar's parts from untyped JS: positive finite sizes only, folded
 * past the fifth as a DonutChart's are, and coloured from the charts' slots
 * around any pinned colours. `whole` is the larger of `total` and the parts'
 * sum, so the bar never overflows and no share passes 100%. Exported for tests.
 */
export function segmentedParts(
  segments: unknown,
  total: unknown,
  format: (value: number) => string
): { parts: BarPart[]; sum: number; whole: number } {
  const valid: {
    value: number;
    label: string;
    pin: PluginChartColor | undefined;
    valueText: string | undefined;
  }[] = [];
  let running = 0;
  if (Array.isArray(segments)) {
    for (const entry of segments as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const value = finiteNumber(field(entry, "value"));
      // A part whose size would push the sum past what a number holds has no share to draw.
      if (value === undefined || value <= 0 || !Number.isFinite(running + value)) continue;
      running += value;
      valid.push({
        value,
        label: str(field(entry, "label")) ?? "",
        pin: oneOf(field(entry, "color"), COLORS),
        valueText: nonEmpty(field(entry, "valueText")),
      });
    }
  }
  const { named, rest } = foldParts(valid);
  const hues = slotColors(named.map((part) => part.pin));
  const drawn = named.map((part, index) => ({
    key: String(index),
    label: part.label,
    value: part.value,
    color: chartColor(hues[index] ?? "neutral"),
    valueText: part.valueText,
  }));
  if (rest !== null) {
    drawn.push({
      key: "other",
      label: "Other",
      value: rest,
      color: chartColor("neutral"),
      valueText: undefined,
    });
  }
  const sum = drawn.reduce((acc, part) => acc + part.value, 0);
  const whole = Math.max(positive(total, Number.MAX_VALUE) ?? 0, sum);
  const parts = drawn.map((part) => {
    const portion = share(part.value, whole);
    const figure = part.valueText === undefined ? format(part.value) : undefined;
    return {
      key: part.key,
      label: part.label,
      value: part.value,
      color: part.color,
      text: part.valueText ?? `${figure}, ${portion}`,
      figure,
      share: part.valueText === undefined ? portion : undefined,
    };
  });
  return { parts, sum, whole };
}

/** A part's share of the track, and its colour as the fill variable so forced colours can replace it. */
function segmentStyle(
  grow: number,
  color: string
): CSSProperties & Record<"--kit-segment", string> {
  return { flex: `${grow} 1 0px`, "--kit-segment": color };
}

function KitSegmentedBar({
  segments,
  label,
  showLabel,
  total,
  formatValue,
  legend,
  marks,
  size,
  className,
  ...rest
}: PluginSegmentedBarProps) {
  const overlayZ = useKitOverlayZClass();
  const name = nonEmpty(label) ?? "Parts";
  const format = valueFormats(formatValue).full;
  const { parts, sum, whole } = segmentedParts(segments, total, format);
  const height = oneOf(size, ["sm", "md"] as const) ?? "sm";
  const references = readMarks(marks, whole);
  const empty = whole - sum;
  const pieces = parts.map((part) => (part.label ? `${part.label} ${part.text}` : part.text));
  if (parts.length === 0) pieces.push("no data");
  if (empty > 0 && parts.length > 0) pieces.push(`of ${format(whole)}`);
  const summary = `${name}: ${pieces.join("; ")}${
    references.length > 0 ? `; ${marksText(references, (mark) => format(mark.value))}` : ""
  }`;
  const stacked = showLabel !== false;
  // Grow factors that sum below 1 leave part of the track unclaimed, so each
  // is its percentage of the whole rather than the raw value.
  const grow = (value: number) => (value / whole) * 100;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", str(className))}>
      {stacked ? (
        <span aria-hidden="true" className="min-w-0 truncate text-xs font-medium text-text-primary">
          {name}
        </span>
      ) : null}
      <div className="relative w-full">
        <div
          {...pickRootProps(rest, { aria: true })}
          role="img"
          aria-label={summary}
          data-segmented-track=""
          className={cn(
            "flex w-full gap-px overflow-hidden rounded-full forced-colors:outline forced-colors:outline-1 forced-colors:outline-[CanvasText]",
            TRACK_HEIGHT[height]
          )}
        >
          {parts.map((part) => (
            <Tooltip key={part.key}>
              <TooltipTrigger asChild>
                <span
                  data-segment={part.key}
                  className="h-full min-w-0.5 bg-[var(--kit-segment)] forced-colors:bg-[CanvasText]"
                  style={segmentStyle(grow(part.value), part.color)}
                />
              </TooltipTrigger>
              <TooltipContent side="top" className={overlayZ}>
                {part.label ? `${part.label}: ${part.text}` : part.text}
              </TooltipContent>
            </Tooltip>
          ))}
          {empty > 0 || parts.length === 0 ? (
            <span
              data-segment-rest=""
              className="h-full bg-overlay-emphasis"
              style={{ flex: `${parts.length === 0 ? 1 : grow(empty)} 1 0px` }}
            />
          ) : null}
        </div>
        {references.length > 0 ? <TrackMarks marks={references} size={height} /> : null}
      </div>
      {legend !== false && parts.length > 0 ? (
        <ul
          aria-label="Legend"
          className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary"
        >
          {parts.map((part) => (
            <li key={part.key} className="flex min-w-0 items-center gap-1.5">
              <Swatch color={part.color} shape="bar" />
              {part.label ? <span className="min-w-0 truncate">{part.label}</span> : null}
              {part.figure === undefined ? (
                <span className="tabular-nums text-text-primary">{part.text}</span>
              ) : (
                <>
                  <span className="tabular-nums text-text-primary">{part.figure}</span>
                  <span className="tabular-nums">{part.share}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const pluginKitDisplay = {
  FilterChip: KitFilterChip,
  HighlightedText: KitHighlightedText,
  DiffStat: KitDiffStat,
  AvatarGroup: KitAvatarGroup,
  Meter: KitMeter,
  SegmentedBar: KitSegmentedBar,
  Timeline: KitTimeline,
};
