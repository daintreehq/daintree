import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  type MouseEvent,
} from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Cloud,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitMergeConflict,
  Globe,
  MessageSquare,
  Tag,
  X,
  XCircle,
} from "lucide-react";
import type {
  PluginBranchBadgeProps,
  PluginCheck,
  PluginCheckStatus,
  PluginChecksListProps,
  PluginCommit,
  PluginCommitListProps,
  PluginCommitRef,
  PluginCommitRowProps,
  PluginDevServerState,
  PluginDevServerStatusProps,
  PluginFileIconProps,
  PluginFileLinkProps,
  PluginForgeCiStatus,
  PluginForgeLabel,
  PluginForgePerson,
  PluginForgeReviewDecision,
  PluginForgeRowBaseProps,
  PluginForgeState,
  PluginForgeStateBadgeProps,
  PluginGitFileStatus,
  PluginGitStatusBadgeProps,
  PluginIssueRowProps,
  PluginPortLinkProps,
  PluginPullRequestRowProps,
  PluginWorktreeBadgeProps,
  PluginWorktreeItem,
  PluginWorktreePickerProps,
} from "@shared/types/plugin-sdk-react";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import { isAbsolute, isPathInside, join, normalize, toWorktreeRelative } from "@shared/utils/path";
import { isLocalhostUrl } from "@shared/utils/urlUtils";
import { Badge } from "@/components/ui/badge";
import { BranchBadge } from "@/components/ui/BranchBadge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { DiffStat } from "@/components/ui/DiffStat";
import {
  LIST_ROW_HOVER_CLASS,
  PALETTE_ROW_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
} from "@/components/ui/paletteRowStyles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PathTail } from "@/components/ui/PathTail";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { clearSearchBeforeDismiss } from "@/components/ui/SearchField";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { selectTriggerVariants } from "@/components/ui/select";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  getCheckOutcomeVisual,
  safeDetailsUrl,
  sanitizeCheckName,
} from "@/components/Worktree/ReviewHub/prChecks";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { getGitStatusPresentation } from "@/lib/gitStatusPresentation";
import { pluralize } from "@/lib/pluralize";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import { cn } from "@/lib/utils";
import {
  FILE_TREE_ICON_CLASS,
  FILE_TREE_ICON_COLOR_CLASS,
  getFileTypeIcon,
} from "@/panels/file-browser/fileTypeIcons";
import { actionService } from "@/services/ActionService";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { useNow } from "../../../packages/plugin-sdk/src/react/useNow";
import {
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  positive,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { parseLabelHex, swatchNeedsEdge } from "./kitLabelColor";
import { useDaintreeTheme } from "@/pluginUi/theme";
import { pluginKitDates } from "./PluginKitDates";
import { pluginKitOverlays } from "./PluginKitOverlays";
import { pluginKitTypography } from "./PluginKitTypography";
import { reportPluginFault } from "./kitDiagnostics";

const KitAvatar = pluginKitOverlays.Avatar;
const KitTimeAgo = pluginKitDates.TimeAgo;
const KitPathLabel = pluginKitTypography.PathLabel;

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toTimestamp(value: unknown): number {
  if (value instanceof Date) {
    // Read through the intrinsic: a Date-shaped object from plugin code can
    // lack the internal slot, or carry its own throwing getTime.
    try {
      return Date.prototype.getTime.call(value);
    } catch {
      return NaN;
    }
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value !== "") return Date.parse(value);
  return NaN;
}

/** Runs a host action for a press, logging a refusal: dispatch resolves `{ ok: false }` rather than throwing. */
function dispatchFromKit(actionId: string, args: Record<string, unknown>): void {
  actionService.dispatch(actionId, args, { source: "user" }).then(
    (result) => {
      if (!result.ok) reportPluginFault(`${actionId} failed`, result.error);
    },
    (error: unknown) => reportPluginFault(`${actionId} failed`, error)
  );
}

function dispatchOpen(actionId: "browser.openExternal" | "browser.openUrl", url: string): void {
  dispatchFromKit(actionId, { url });
}

/** An http(s) URL a forge or CI provider handed over, opened in the system browser. */
function openForgeUrl(url: string | undefined): void {
  const safe = safeDetailsUrl(url);
  if (safe) dispatchOpen("browser.openExternal", safe);
}

/**
 * Keeps a press from moving DOM focus: Chromium focuses a pressed button or
 * link even at tabIndex -1, which would pull focus out of a list's own field.
 */
function preventFocusSteal(event: MouseEvent<HTMLElement>): void {
  event.preventDefault();
}

/** The middot between a row's metadata, kept inside the item it introduces. */
function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0">
      &middot;
    </span>
  );
}

// ---------------------------------------------------------------------------
// GitStatusBadge

const GIT_STATUSES = [
  "modified",
  "added",
  "deleted",
  "untracked",
  "renamed",
  "copied",
  "ignored",
  "conflicted",
] as const satisfies readonly PluginGitFileStatus[];

function KitGitStatusBadge({ status, variant, className, ...rest }: PluginGitStatusBadgeProps) {
  const at = oneOf(status, GIT_STATUSES);
  if (!at) return null;
  const { marker, name, colorClass } = getGitStatusPresentation(at);
  const letter = (
    <span
      aria-hidden={variant === "label" ? true : undefined}
      className="inline-flex w-4 shrink-0 justify-center font-mono font-bold"
    >
      {marker}
    </span>
  );
  if (variant === "label") {
    return (
      <span
        {...pickRootProps(rest)}
        data-git-status={at}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 text-xs",
          colorClass,
          str(className)
        )}
      >
        {letter}
        <span>{name}</span>
      </span>
    );
  }
  return (
    <span
      {...pickRootProps(rest)}
      data-git-status={at}
      role="img"
      aria-label={name}
      className={cn("inline-flex shrink-0 text-xs", colorClass, str(className))}
    >
      {letter}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FileIcon and FileLink

function KitFileIcon({
  path,
  kind,
  expanded,
  size,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginFileIconProps) {
  const name = str(path) ?? "";
  const Glyph =
    kind === "directory"
      ? expanded === true
        ? FolderOpen
        : Folder
      : getFileTypeIcon(name.split(/[\\/]/).pop() ?? name).Icon;
  const px = positive(size, 256) ?? 14;
  const label = nonEmpty(ariaLabel);
  return (
    <span
      {...pickRootProps(rest)}
      className={cn("inline-flex shrink-0", str(className))}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <Glyph
        aria-hidden="true"
        className={cn(FILE_TREE_ICON_CLASS, FILE_TREE_ICON_COLOR_CLASS, "shrink-0")}
        style={{ width: px, height: px }}
      />
    </span>
  );
}

/**
 * The absolute file a link opens, or null when it has no usable root or lands
 * outside it. Lexical only: the viewer confines its reads to the root on the
 * real path, which catches a symlink pointing out.
 */
export function resolveFileLink(path: unknown, rootPath: unknown): string | null {
  const target = nonEmpty(path);
  const root = nonEmpty(rootPath);
  if (!target || !root || !isAbsolute(root)) return null;
  const base = normalize(root);
  const absolute = isAbsolute(target) ? normalize(target) : normalize(join(base, target));
  return isPathInside(absolute, base) || absolute === base ? absolute : null;
}

function validLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function KitFileLink({
  path,
  rootPath,
  line,
  children,
  icon,
  mono,
  onClick,
  tabIndex,
  className,
  ...rest
}: PluginFileLinkProps) {
  const given = str(path) ?? "";
  const at = validLine(line);
  const absolute = resolveFileLink(path, rootPath);
  const linkTab = typeof tabIndex === "number" && Number.isInteger(tabIndex) ? tabIndex : undefined;
  // Read against the root, as the host's change lists do: a checkout's
  // absolute prefix is the same on every row and says nothing.
  const shown =
    absolute !== null && isAbsolute(given)
      ? toWorktreeRelative(absolute, normalize(str(rootPath) ?? ""))
      : given;
  const ownClick = fn(onClick);
  const body = (
    <>
      {icon !== false ? <KitFileIcon path={shown} /> : null}
      {hasContent(children) ? (
        <span className="min-w-0 truncate">{node(children)}</span>
      ) : (
        <KitPathLabel path={shown} mono={mono === true} focusable={false} />
      )}
      {at !== undefined ? (
        <span
          className={cn("shrink-0 text-text-secondary tabular-nums", mono === true && "font-mono")}
        >
          :{at}
        </span>
      ) : null}
    </>
  );
  const frame = "inline-flex min-w-0 max-w-full items-center gap-1.5 align-bottom";
  if (absolute === null) {
    return (
      <span
        {...pickRootProps(rest)}
        data-kit-file-link=""
        className={cn(frame, "text-text-primary", str(className))}
      >
        {body}
      </span>
    );
  }
  const root = normalize(str(rootPath) ?? "");
  return (
    <a
      {...pickRootProps(rest)}
      data-kit-file-link=""
      href={given}
      tabIndex={linkTab}
      onMouseDown={linkTab !== undefined && linkTab < 0 ? preventFocusSteal : undefined}
      aria-label={at !== undefined ? `${shown}, line ${at}` : undefined}
      onClick={(event) => {
        try {
          ownClick?.(event);
        } catch (error) {
          // The href must never navigate the view, even past a throwing handler.
          event.preventDefault();
          throw error;
        }
        if (event.defaultPrevented) return;
        event.preventDefault();
        dispatchFromKit("file.view", {
          path: absolute,
          rootPath: root,
          confineToRoot: true,
          ...(at !== undefined && { line: at }),
        });
      }}
      onAuxClick={(event) => event.preventDefault()}
      className={cn(
        frame,
        "cursor-pointer rounded-xs text-text-primary decoration-1 underline-offset-2 hover:underline",
        FOCUS_RING,
        str(className)
      )}
    >
      {body}
    </a>
  );
}

// ---------------------------------------------------------------------------
// BranchBadge, WorktreeBadge and WorktreePicker

function KitBranchBadge({ branch, className, ...rest }: PluginBranchBadgeProps) {
  const name = nonEmpty(branch);
  if (!name) return null;
  const root = pickRootProps(rest);
  return (
    <span {...root} className="inline-flex min-w-0 max-w-full">
      <BranchBadge branch={name} className={str(className)} />
    </span>
  );
}

interface WorktreeEntry {
  item: PluginWorktreeItem;
  id: string;
  name: string;
  branch?: string;
  path?: string;
  current: boolean;
  main: boolean;
  ahead: number;
  behind: number;
  changed: number;
  group?: string;
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function readWorktree(value: PluginWorktreeItem): WorktreeEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const id = nonEmpty(field(value, "id"));
  if (!id) return null;
  const branch = nonEmpty(field(value, "branch"));
  const path = nonEmpty(field(value, "path"));
  const name = nonEmpty(field(value, "name")) ?? branch ?? (path ? lastSegment(path) : id);
  const status = field(value, "status");
  const changed =
    count(field(value, "changedFileCount")) ??
    (typeof status === "object" && status !== null
      ? count(field(status, "changedFileCount"))
      : undefined) ??
    0;
  return {
    item: value,
    id,
    name,
    branch,
    path,
    current: field(value, "isCurrent") === true,
    main: field(value, "isMainWorktree") === true,
    ahead: count(field(value, "aheadCount")) ?? 0,
    behind: count(field(value, "behindCount")) ?? 0,
    changed,
    group: nonEmpty(field(value, "group")),
  };
}

function readWorktrees(value: unknown): WorktreeEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: WorktreeEntry[] = [];
  for (const raw of value) {
    const entry = readWorktree(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function syncWords(entry: WorktreeEntry): string[] {
  const words: string[] = [];
  if (entry.changed > 0) words.push(`${pluralize(entry.changed, "changed file")}`);
  if (entry.ahead > 0) words.push(`${entry.ahead} ahead`);
  if (entry.behind > 0) words.push(`${entry.behind} behind`);
  return words;
}

/** Changed files, then ahead in the success ink and behind in the warning ink, as the card draws them. */
function WorktreeSync({ entry }: { entry: WorktreeEntry }) {
  const words = syncWords(entry);
  if (words.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={words.join(", ")}
      data-kit-worktree-sync=""
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums"
    >
      {entry.changed > 0 ? (
        <span className="inline-flex items-center gap-1 font-sans text-text-secondary">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-warning" />
          {pluralize(entry.changed, "file")}
        </span>
      ) : null}
      {entry.ahead > 0 ? <span className="text-status-success">↑{entry.ahead}</span> : null}
      {entry.behind > 0 ? <span className="text-status-warning">↓{entry.behind}</span> : null}
    </span>
  );
}

function KitWorktreeBadge({
  worktree,
  showBranch,
  showStatus,
  className,
  ...rest
}: PluginWorktreeBadgeProps) {
  const entry = readWorktree(worktree);
  if (!entry) return null;
  const branch = showBranch !== false && entry.branch !== entry.name ? entry.branch : undefined;
  return (
    <span
      {...pickRootProps(rest)}
      data-kit-worktree-badge=""
      data-current={entry.current ? "true" : undefined}
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs", str(className))}
    >
      <FolderGit2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
      <TruncatedTooltip content={entry.path ?? entry.name}>
        {/* The name is what tells worktrees apart, so the branch gives way first. */}
        <span className="min-w-[6ch] max-w-[60%] shrink-0 truncate font-medium text-text-primary">
          {entry.name}
        </span>
      </TruncatedTooltip>
      {branch ? (
        <span className="inline-flex min-w-0 shrink items-center gap-1 text-text-secondary">
          <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{branch}</span>
        </span>
      ) : null}
      {entry.current ? <span className="shrink-0 text-text-secondary">Current</span> : null}
      {showStatus !== false ? <WorktreeSync entry={entry} /> : null}
    </span>
  );
}

type WorktreeRow = { kind: "label"; label: string } | { kind: "worktree"; entry: WorktreeEntry };

function worktreeMatches(entry: WorktreeEntry, query: string): boolean {
  return [entry.name, entry.branch, entry.path].some(
    (text) => text !== undefined && text.toLowerCase().includes(query)
  );
}

/**
 * The picker's rows for a query: under the author's own groups when any
 * worktree names one, otherwise the main checkout first and the rest after
 * it, each under its heading. Exported for tests.
 */
export function worktreeRows(entries: readonly WorktreeEntry[], query: string): WorktreeRow[] {
  const q = query.trim().toLowerCase();
  const kept = q === "" ? entries : entries.filter((entry) => worktreeMatches(entry, q));
  const grouped = entries.some((entry) => entry.group !== undefined);
  const groups = new Map<string, WorktreeEntry[]>();
  for (const entry of kept) {
    const label = grouped
      ? (entry.group ?? "Other worktrees")
      : entry.main
        ? "Main worktree"
        : "Worktrees";
    const list = groups.get(label) ?? [];
    list.push(entry);
    groups.set(label, list);
  }
  const order = grouped
    ? [...groups.keys()]
    : ["Main worktree", "Worktrees"].filter((label) => groups.has(label));
  const rows: WorktreeRow[] = [];
  for (const label of order) {
    const members = groups.get(label) ?? [];
    if (order.length > 1) rows.push({ kind: "label", label });
    for (const entry of members) rows.push({ kind: "worktree", entry });
  }
  return rows;
}

function WorktreeTriggerContent({ entry }: { entry: WorktreeEntry }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <FolderGit2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
      <span className="min-w-0 shrink truncate">{entry.name}</span>
      {entry.branch && entry.branch !== entry.name ? (
        <span className="min-w-0 shrink-[2] truncate font-mono text-xs text-text-secondary">
          {entry.branch}
        </span>
      ) : null}
    </span>
  );
}

const WORKTREE_LIST_MAX_PX = 320;

function KitWorktreePicker(props: PluginWorktreePickerProps) {
  const {
    worktrees,
    defaultValue,
    onValueChange,
    defaultOpen,
    onOpenChange,
    placeholder,
    searchPlaceholder,
    emptyMessage,
    disabled,
    density,
    "aria-label": ariaLabel,
    className,
  } = props;
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const listId = useId();
  const optionBase = useId();
  const optionId = (index: number) => `${optionBase}wt-${index}`;
  const valueControlled = Object.hasOwn(props, "value");
  const openControlled = typeof props.open === "boolean";
  const [ownValue, setOwnValue] = useState(() => str(defaultValue) ?? "");
  const [ownOpen, setOwnOpen] = useState(() => defaultOpen === true);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const pointerOpen = useRef(false);

  const entries = readWorktrees(worktrees);
  const current = valueControlled ? (str(props.value) ?? "") : ownValue;
  const chosen = entries.find((entry) => entry.id === current);
  const inert = disabled === true;
  const open = !inert && (openControlled ? props.open === true : ownOpen);
  const change = fn(onValueChange);
  const announceOpen = fn(onOpenChange);

  // A fresh search each time the list opens, however it was opened: by the
  // trigger, or by a parent flipping a controlled `open`.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setCursor(
        worktreeRows(entries, "").findIndex(
          (row) => row.kind === "worktree" && row.entry.id === current
        )
      );
    }
  }

  const rows = worktreeRows(entries, query);
  const selectable = rows.flatMap((row, index) => (row.kind === "worktree" ? [index] : []));
  const active = selectable.includes(cursor)
    ? cursor
    : query.trim() !== ""
      ? (selectable[0] ?? -1)
      : -1;

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${optionBase}wt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, optionBase]);

  const setOpen = (next: boolean) => {
    if (next && pointerOpen.current) {
      // A pointer opening places no cursor; the session reset above would
      // otherwise land it on the current choice.
      setWasOpen(true);
      setQuery("");
      setCursor(-1);
    }
    pointerOpen.current = false;
    if (!openControlled) setOwnOpen(next);
    announceOpen?.(next);
  };

  const pick = (entry: WorktreeEntry) => {
    if (inert) return;
    setOpen(false);
    if (entry.id === current) return;
    if (!valueControlled) setOwnValue(entry.id);
    change?.(entry.id, entry.item);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const position = selectable.indexOf(active);
    const next = keyBelongsToField(event)
      ? null
      : stepListboxCursor(event.key, position, selectable.length);
    if (next !== null) {
      event.preventDefault();
      setCursor(selectable[next] ?? -1);
      return;
    }
    // Modified Enter belongs to whatever encloses the picker (a dialog's submit).
    if (event.key === "Enter" && !keyBelongsToField(event)) {
      event.preventDefault();
      event.stopPropagation();
      const row = active >= 0 ? rows[active] : undefined;
      if (row?.kind === "worktree") pick(row.entry);
    }
  };

  const label = nonEmpty(ariaLabel) ?? "Worktree";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...pickRootProps(props, { aria: true })}
          aria-label={label}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={inert}
          data-placeholder={chosen ? undefined : ""}
          onPointerDown={() => {
            pointerOpen.current = true;
          }}
          onKeyDown={(event) => {
            pointerOpen.current = false;
            if (
              (event.key === "ArrowDown" || event.key === "ArrowUp") &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className={cn(
            selectTriggerVariants({ density: oneOf(density, ["default", "compact"] as const) }),
            "group min-w-0 text-left data-[placeholder]:text-text-secondary",
            str(className)
          )}
        >
          {chosen ? (
            <WorktreeTriggerContent entry={chosen} />
          ) : (
            <span className="min-w-0 flex-1 truncate">
              {nonEmpty(placeholder) ?? "Choose a worktree"}
            </span>
          )}
          <ChevronDown
            data-animated-chevron
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...owner}
        align="start"
        sideOffset={4}
        motion="drop"
        className={cn(
          "w-[var(--radix-popover-trigger-width)] min-w-96 max-w-[calc(100vw-2rem)] p-0",
          overlayZ
        )}
        onEscapeKeyDown={(event) =>
          clearSearchBeforeDismiss(event, searchRef.current, () => {
            setQuery("");
            setCursor(-1);
          })
        }
      >
        <PopoverSearchField
          ref={searchRef}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(-1);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder={nonEmpty(searchPlaceholder) ?? "Search worktrees"}
          role="combobox"
          aria-label={`Search ${label.toLowerCase() === "worktree" ? "worktrees" : label}`}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        />
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="overflow-y-auto p-1"
          style={{ maxHeight: WORKTREE_LIST_MAX_PX }}
        >
          {rows.map((row, index) =>
            row.kind === "label" ? (
              <div
                key={`group:${row.label}`}
                role="option"
                aria-disabled="true"
                aria-selected="false"
                aria-label={row.label}
                className={cn("px-2 pt-2 pb-1", PALETTE_SECTION_LABEL_CLASS)}
              >
                {row.label}
              </div>
            ) : (
              <div
                key={`worktree:${row.entry.id}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                aria-current={row.entry.current ? "true" : undefined}
                data-worktree-id={row.entry.id}
                onPointerMove={() => {
                  if (index !== active) setCursor(index);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(row.entry)}
                className={cn(
                  PALETTE_ROW_CLASS,
                  "group flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] px-2 py-1.5"
                )}
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0 text-text-primary",
                    row.entry.id !== current && "invisible"
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2 text-xs">
                    {/* The name keeps its width; the branch takes what is left. */}
                    <span className="max-w-[60%] shrink-0 truncate font-medium text-text-primary">
                      {row.entry.name}
                    </span>
                    {row.entry.branch && row.entry.branch !== row.entry.name ? (
                      <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">
                        {row.entry.branch}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {row.entry.current ? (
                      <span className="shrink-0 text-text-secondary">Current</span>
                    ) : null}
                    <WorktreeSync entry={row.entry} />
                  </span>
                  {row.entry.path ? (
                    // Cut from the left: worktree paths share their prefix, so
                    // the tail is the part that tells them apart.
                    <PathTail className="font-mono text-2xs text-text-secondary group-aria-selected:text-text-primary">
                      {row.entry.path}
                    </PathTail>
                  ) : null}
                </span>
              </div>
            )
          )}
        </div>
        {selectable.length === 0 ? (
          <div role="status" className="px-3 pb-3 text-xs text-text-secondary">
            {content(emptyMessage) ??
              (entries.length === 0 ? "No worktrees" : "No matching worktrees")}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// CommitRow and CommitList

interface CommitEntry {
  commit: PluginCommit;
  sha: string;
  subject: string;
  author?: { name: string; avatarUrl?: string; email?: string };
  date: number;
  refs: { name: string; kind: NonNullable<PluginCommitRef["kind"]> }[];
  additions?: number;
  deletions?: number;
  unpushed: boolean;
}

const REF_KINDS = ["branch", "tag", "remote", "head"] as const;

function readPerson(value: unknown): PluginForgePerson | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = nonEmpty(field(value, "name"));
  if (!name) return undefined;
  return {
    name,
    avatarUrl: nonEmpty(field(value, "avatarUrl")),
    email: nonEmpty(field(value, "email")),
  };
}

function readPeople(value: unknown): PluginForgePerson[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const person = readPerson(raw);
    return person ? [person] : [];
  });
}

function readCommit(value: PluginCommit | undefined): CommitEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const sha = nonEmpty(field(value, "sha"));
  if (!sha) return null;
  const refsRaw = field(value, "refs");
  const refs = Array.isArray(refsRaw)
    ? refsRaw.flatMap((ref: unknown) => {
        if (typeof ref !== "object" || ref === null) return [];
        const name = nonEmpty(field(ref, "name"));
        if (!name) return [];
        return [{ name, kind: oneOf(field(ref, "kind"), REF_KINDS) ?? ("branch" as const) }];
      })
    : [];
  return {
    commit: value,
    sha,
    subject: str(field(value, "subject")) ?? "",
    author: readPerson(field(value, "author")),
    date: toTimestamp(field(value, "date")),
    refs,
    additions: count(field(value, "additions")),
    deletions: count(field(value, "deletions")),
    unpushed: field(value, "unpushed") === true,
  };
}

const REF_GLYPH = { branch: GitBranch, head: GitBranch, remote: Cloud, tag: Tag } as const;
const REF_WORD = { branch: "Branch", head: "Checked out", remote: "Remote branch", tag: "Tag" };
const MAX_REFS = 2;

function CommitRefs({ refs }: { refs: CommitEntry["refs"] }) {
  if (refs.length === 0) return null;
  const shown = refs.slice(0, MAX_REFS);
  const rest = refs.length - shown.length;
  return (
    // The subject outranks its decorations: the refs give way three times as
    // fast, each cut to an ellipsis with its full name in a tooltip.
    <span className="flex min-w-[6ch] shrink-[3] items-center gap-1">
      {shown.map((ref) => {
        const Glyph = REF_GLYPH[ref.kind];
        return (
          <Badge
            key={`${ref.kind}:${ref.name}`}
            size="xs"
            tone="outline"
            data-ref-kind={ref.kind}
            aria-label={`${REF_WORD[ref.kind]} ${ref.name}`}
            className={cn(
              "max-w-[140px] shrink font-mono",
              // A tag cut to "v0…" names no version; it keeps room for one.
              ref.kind === "tag" ? "min-w-[12ch]" : "min-w-0",
              ref.kind === "head" && "text-text-primary"
            )}
          >
            <Glyph aria-hidden="true" />
            <TruncatedTooltip content={ref.name} focusable={false}>
              <span className="min-w-0 truncate">{ref.name}</span>
            </TruncatedTooltip>
          </Badge>
        );
      })}
      {rest > 0 ? (
        <span
          className="shrink-0 text-2xs text-text-secondary tabular-nums"
          aria-label={`${rest} more: ${refs
            .slice(MAX_REFS)
            .map((ref) => ref.name)
            .join(", ")}`}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

function ShaButton({ sha, length }: { sha: string; length: number }) {
  const overlayZ = useKitOverlayZClass();
  const { copied, copy } = useCopyWithFeedback();
  const short = sha.slice(0, length);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-kit-commit-sha=""
          data-kit-rove=""
          onClick={(event) => {
            event.stopPropagation();
            void copy(sha);
          }}
          aria-label={`Copy hash ${short}`}
          className={cn(
            // 24px tall to the pointer without growing the metadata line.
            "relative after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']",
            "ml-auto flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 font-mono text-xs text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary",
            FOCUS_RING,
            copied && "text-text-primary"
          )}
        >
          {copied ? <Check aria-hidden="true" className="size-3" /> : null}
          <span>{short}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {copied ? "Copied" : "Copy hash"}
      </TooltipContent>
    </Tooltip>
  );
}

const COMMIT_ROW_CLASS = "flex items-start gap-2 px-3 py-2.5";

function CommitSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-kit-commit-skeleton=""
      className={cn(COMMIT_ROW_CLASS, "h-[58px] box-border")}
    >
      <SkeletonBone className="mt-0.5 size-4 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <SkeletonBone className="h-5 w-3/4 rounded-[var(--radius-sm)]" />
        <div className="mt-0.5 flex items-center gap-1.5">
          <SkeletonBone className="h-4 w-20 rounded-[var(--radius-sm)]" />
          <SkeletonBone className="h-4 w-12 rounded-[var(--radius-sm)]" />
          <SkeletonBone className="ml-auto h-4 w-14 rounded-[var(--radius-sm)]" />
        </div>
      </div>
    </div>
  );
}

function CommitBody({
  entry,
  onActivate,
  shaLength,
}: {
  entry: CommitEntry;
  onActivate?: (commit: PluginCommit) => void;
  shaLength: number;
}) {
  const overlayZ = useKitOverlayZClass();
  const subjectClass = "min-w-0 truncate text-sm font-medium text-text-primary";
  const subject = onActivate ? (
    <button
      type="button"
      data-kit-commit-subject=""
      data-kit-rove=""
      onClick={() => onActivate(entry.commit)}
      className={cn(
        subjectClass,
        "cursor-pointer rounded-sm text-left hover:underline",
        FOCUS_RING
      )}
    >
      {entry.subject}
    </button>
  ) : (
    <p className={cn(subjectClass, "m-0")}>{entry.subject}</p>
  );
  const dated = !Number.isNaN(entry.date);
  return (
    <>
      {entry.author ? (
        <KitAvatar
          name={entry.author.name}
          src={entry.author.avatarUrl}
          size="xs"
          decorative
          className="mt-0.5"
        />
      ) : (
        <GitCommitHorizontal
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-text-secondary"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <TruncatedTooltip content={entry.subject} contentClassName={overlayZ}>
            {subject}
          </TruncatedTooltip>
          <CommitRefs refs={entry.refs} />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
          {/* Like the forge row's: one line whose items drop out whole, with
              their separators, when the row is too narrow. "Not pushed" leads
              and the hash keeps its own place at the end. */}
          <div
            data-kit-commit-meta=""
            className="flex h-4 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden leading-4"
          >
            {entry.unpushed ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-text-primary">
                <ArrowUp aria-hidden="true" className="size-3" />
                Not pushed
              </span>
            ) : null}
            {entry.author ? (
              // Placed at 6ch and grown into the room left, so the author
              // truncates before the age and churn are lost.
              <span className="inline-flex min-w-0 max-w-max shrink-0 grow basis-[6ch] items-center gap-1.5">
                {entry.unpushed ? <Dot /> : null}
                {entry.author.email ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="min-w-0 truncate">{entry.author.name}</span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className={overlayZ}>
                      {entry.author.email}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="min-w-0 truncate">{entry.author.name}</span>
                )}
              </span>
            ) : null}
            {dated ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                {entry.unpushed || entry.author ? <Dot /> : null}
                <KitTimeAgo value={entry.date} />
              </span>
            ) : null}
            {entry.additions || entry.deletions ? (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                {entry.unpushed || entry.author || dated ? <Dot /> : null}
                <DiffStat insertions={entry.additions} deletions={entry.deletions} />
              </span>
            ) : null}
          </div>
          <ShaButton sha={entry.sha} length={shaLength} />
        </div>
      </div>
    </>
  );
}

function shaLengthOf(value: unknown): number {
  const length = count(value);
  return length !== undefined && length >= 4 && length <= 40 ? length : 7;
}

function KitCommitRow({
  commit,
  skeleton,
  onActivate,
  shaLength,
  className,
  ...rest
}: PluginCommitRowProps) {
  if (skeleton === true) {
    return (
      <div {...pickRootProps(rest)} className={str(className)}>
        <CommitSkeleton />
      </div>
    );
  }
  const entry = readCommit(commit);
  if (!entry) return null;
  return (
    <div
      {...pickRootProps(rest)}
      data-kit-commit={entry.sha}
      className={cn(
        COMMIT_ROW_CLASS,
        "rounded-[var(--radius-md)]",
        LIST_ROW_HOVER_CLASS,
        str(className)
      )}
    >
      <CommitBody entry={entry} onActivate={fn(onActivate)} shaLength={shaLengthOf(shaLength)} />
    </div>
  );
}

const ROVE = "[data-kit-rove]";
const ROVE_ROW = "[data-kit-rove-row]";
const ROVE_STOP = "data-kit-rove-stop";

function setRoveStop(root: HTMLElement, stop: HTMLElement | undefined): void {
  for (const control of root.querySelectorAll<HTMLElement>(ROVE)) {
    control.tabIndex = control === stop ? 0 : -1;
    control.toggleAttribute(ROVE_STOP, control === stop);
  }
}

/**
 * One Tab stop for a list of rows that each hold controls: the control last
 * focused (else the first) is the only one in the tab order. Pair with
 * {@link roveFocus} and {@link roveKeyDown} on the same element.
 */
function useRovingRows(root: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const controls = [...element.querySelectorAll<HTMLElement>(ROVE)];
    setRoveStop(element, controls.find((c) => c.hasAttribute(ROVE_STOP)) ?? controls[0]);
  });
}

function roveFocus(event: FocusEvent<HTMLElement>): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.matches(ROVE)) {
    setRoveStop(event.currentTarget, target);
  }
}

/** Up and Down: the same control in the next row; Left and Right: along the row; Home and End: the first and last row. */
function roveKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(ROVE)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROVE_ROW)];
  const row = target.closest<HTMLElement>(ROVE_ROW);
  if (!row) return;
  const inRow = (r: HTMLElement) => [...r.querySelectorAll<HTMLElement>(ROVE)];
  const at = rows.indexOf(row);
  const col = inRow(row).indexOf(target);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const step = event.key === "ArrowDown" ? 1 : -1;
    for (let i = at + step; i >= 0 && i < rows.length && !next; i += step) {
      const cells = inRow(rows[i]!);
      next = cells[Math.min(col, cells.length - 1)];
    }
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    next = inRow(row)[col + (event.key === "ArrowRight" ? 1 : -1)];
  } else if (event.key === "Home" || event.key === "End") {
    const edge = event.key === "Home" ? rows[0] : rows[rows.length - 1];
    next = edge ? inRow(edge)[0] : undefined;
  } else {
    return;
  }
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function KitCommitList({
  commits,
  loading,
  onActivate,
  shaLength,
  empty,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginCommitListProps) {
  const entries = Array.isArray(commits)
    ? commits.flatMap((raw: PluginCommit) => {
        const entry = readCommit(raw);
        return entry ? [entry] : [];
      })
    : [];
  const skeletons =
    loading === true ? 3 : count(loading) !== undefined ? Math.min(count(loading) ?? 0, 20) : 0;
  const activate = fn(onActivate);
  const length = shaLengthOf(shaLength);
  const listRef = useRef<HTMLUListElement>(null);
  useRovingRows(listRef);
  if (entries.length === 0 && skeletons === 0) {
    return hasContent(empty) ? (
      <div
        {...pickRootProps(rest)}
        className={cn("px-3 py-2 text-xs text-text-secondary", str(className))}
      >
        {node(empty)}
      </div>
    ) : null;
  }
  const seen = new Map<string, number>();
  return (
    <div
      {...pickRootProps(rest)}
      data-kit-commit-list=""
      className={cn("flex min-w-0 flex-col", str(className))}
    >
      <ul
        ref={listRef}
        aria-label={nonEmpty(ariaLabel)}
        aria-busy={skeletons > 0 ? true : undefined}
        onFocus={roveFocus}
        onKeyDown={roveKeyDown}
        className="m-0 flex list-none flex-col p-0"
      >
        {entries.map((entry) => {
          // A list repeats a hash only by mistake; the second copy still draws.
          const nth = (seen.get(entry.sha) ?? 0) + 1;
          seen.set(entry.sha, nth);
          const key = nth === 1 ? entry.sha : `${entry.sha}:${nth}`;
          return (
            <li
              key={key}
              data-kit-rove-row=""
              data-kit-commit={entry.sha}
              className={cn(COMMIT_ROW_CLASS, "rounded-[var(--radius-md)]", LIST_ROW_HOVER_CLASS)}
            >
              <CommitBody entry={entry} onActivate={activate} shaLength={length} />
            </li>
          );
        })}
        {Array.from({ length: skeletons }, (_, index) => (
          <li key={`skeleton:${index}`} aria-hidden="true">
            <CommitSkeleton />
          </li>
        ))}
      </ul>
      {skeletons > 0 ? (
        <span role="status" className="sr-only">
          Loading commits
        </span>
      ) : null}
    </div>
  );
}

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

function KitForgeStateBadge({
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

function KitIssueRow(props: PluginIssueRowProps) {
  const state = props.state === "closed" ? "closed" : "open";
  return (
    <ForgeRow
      props={props}
      extra={{ kind: "issue", state, look: forgeStateLook("issue", state) }}
    />
  );
}

function KitPullRequestRow(props: PluginPullRequestRowProps) {
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

function KitChecksList({
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

// ---------------------------------------------------------------------------
// PortLink and DevServerStatus

/** The loopback URL a `PortLink` opens, or null. Exported for tests. */
export function portLinkUrl(url: unknown, port: unknown): string | null {
  const given = nonEmpty(url);
  if (given !== undefined) {
    if (!isLocalhostUrl(given)) return null;
    const parsed = new URL(given);
    // Credentials would ride along to the panel unseen: the label hides them.
    return parsed.username || parsed.password ? null : parsed.toString();
  }
  if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
    return `http://localhost:${port}/`;
  }
  return null;
}

function addressOf(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.host}${path}${parsed.search}`;
}

function KitPortLink({
  url,
  port,
  target,
  copyable,
  children,
  className,
  ...rest
}: PluginPortLinkProps) {
  const href = portLinkUrl(url, port);
  const external = target === "external";
  const shown = hasContent(children) ? node(children) : href ? addressOf(href) : (str(url) ?? "");
  if (!href) {
    return (
      <span
        {...pickRootProps(rest)}
        className={cn("font-mono text-xs text-text-secondary", str(className))}
      >
        {shown}
      </span>
    );
  }
  return (
    <span
      {...pickRootProps(rest)}
      data-kit-port-link=""
      className={cn("inline-flex min-w-0 max-w-full items-center gap-0.5", str(className))}
    >
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          dispatchOpen(external ? "browser.openExternal" : "browser.openUrl", href);
        }}
        onAuxClick={(event) => event.preventDefault()}
        aria-label={`Open ${addressOf(href)}${external ? " in your browser" : " in a browser panel"}`}
        className={cn(
          "min-w-0 truncate rounded-xs font-mono text-xs text-text-link underline decoration-1 underline-offset-2 hover:decoration-2",
          FOCUS_RING
        )}
      >
        {shown}
      </a>
      {copyable !== false ? (
        <CopyButton text={href} aria-label={`Copy ${addressOf(href)}`} tooltip="Copy address" />
      ) : null}
    </span>
  );
}

const DEV_STATES = [
  "starting",
  "installing",
  "running",
  "crashed",
  "stopping",
  "stopped",
] as const satisfies readonly PluginDevServerState[];

const DEV_WORD: Record<PluginDevServerState, string> = {
  starting: "Starting…",
  installing: "Installing dependencies…",
  running: "Running",
  crashed: "Crashed",
  stopping: "Stopping…",
  stopped: "Stopped",
};

function DevGlyph({ status }: { status: PluginDevServerState }) {
  switch (status) {
    case "running":
      return <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-activity-working" />;
    case "crashed":
      return <XCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-status-error" />;
    case "stopped":
      return <Circle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-secondary" />;
    default:
      return <Spinner size="xs" className="text-text-secondary" />;
  }
}

function KitDevServerStatus({
  status,
  name,
  url,
  port,
  error,
  target,
  actions,
  className,
  ...rest
}: PluginDevServerStatusProps) {
  const at = oneOf(status, DEV_STATES) ?? "stopped";
  const label = nonEmpty(name) ?? "Dev server";
  const href = at === "running" ? portLinkUrl(url, port) : null;
  const reason = at === "crashed" ? nonEmpty(error) : undefined;
  return (
    <div
      {...pickRootProps(rest)}
      data-dev-server-status={at}
      className={cn("flex min-w-0 flex-col gap-0.5 text-xs", str(className))}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <DevGlyph status={at} />
        <span role="status" className="flex min-w-0 shrink items-baseline gap-1.5">
          <span className="truncate font-medium text-text-primary">{label}</span>
          <span
            className={cn(
              "shrink-0",
              at === "crashed" ? "text-status-error" : "text-text-secondary"
            )}
          >
            {DEV_WORD[at]}
          </span>
        </span>
        {href ? (
          <KitPortLink
            url={href}
            target={oneOf(target, ["panel", "external"] as const)}
            className="min-w-0"
          />
        ) : null}
        <span className="flex-1" />
        {hasContent(actions) ? (
          <span className="flex shrink-0 items-center gap-0.5">{node(actions)}</span>
        ) : null}
      </div>
      {reason ? (
        <p className="m-0 line-clamp-2 break-words pl-5.5 font-mono text-2xs text-text-secondary">
          {reason}
        </p>
      ) : null}
    </div>
  );
}

export const pluginKitGit = {
  BranchBadge: KitBranchBadge,
  WorktreeBadge: KitWorktreeBadge,
  WorktreePicker: KitWorktreePicker,
  FileIcon: KitFileIcon,
  FileLink: KitFileLink,
  GitStatusBadge: KitGitStatusBadge,
  CommitRow: KitCommitRow,
  CommitList: KitCommitList,
  ForgeStateBadge: KitForgeStateBadge,
  IssueRow: KitIssueRow,
  PullRequestRow: KitPullRequestRow,
  ChecksList: KitChecksList,
  DevServerStatus: KitDevServerStatus,
  PortLink: KitPortLink,
};
