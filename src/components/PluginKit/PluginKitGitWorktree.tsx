import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Folder, FolderGit2, FolderOpen, GitBranch } from "lucide-react";
import type {
  PluginBranchBadgeProps,
  PluginFileIconProps,
  PluginFileLinkProps,
  PluginGitFileStatus,
  PluginGitStatusBadgeProps,
  PluginWorktreeBadgeProps,
  PluginWorktreeItem,
  PluginWorktreePickerProps,
} from "@shared/types/plugin-sdk-react";
import { isAbsolute, isPathInside, join, normalize, toWorktreeRelative } from "@shared/utils/path";
import { BranchBadge } from "@/components/ui/BranchBadge";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PathTail } from "@/components/ui/PathTail";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { clearSearchBeforeDismiss } from "@/components/ui/SearchField";
import { selectTriggerVariants } from "@/components/ui/select";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";
import { getGitStatusPresentation } from "@/lib/gitStatusPresentation";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  FILE_TREE_ICON_CLASS,
  FILE_TREE_ICON_COLOR_CLASS,
  getFileTypeIcon,
} from "@/panels/file-browser/fileTypeIcons";
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
import { pluginKitTypography } from "./PluginKitTypography";
import { FOCUS_RING, count, dispatchFromKit, preventFocusSteal } from "./kitGitShared";

const KitPathLabel = pluginKitTypography.PathLabel;

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

export function KitGitStatusBadge({
  status,
  variant,
  className,
  ...rest
}: PluginGitStatusBadgeProps) {
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

export function KitFileIcon({
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

export function KitFileLink({
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

export function KitBranchBadge({ branch, className, ...rest }: PluginBranchBadgeProps) {
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

export function KitWorktreeBadge({
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

export function KitWorktreePicker(props: PluginWorktreePickerProps) {
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
