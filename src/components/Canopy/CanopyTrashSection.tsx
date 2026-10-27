import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { Ellipsis, RotateCcw } from "lucide-react";
import type { CanopyTrashEntry, CanopyTrashTarget } from "@shared/types/ipc/canopy";
import type { PilotWorkspaceMeta } from "@/components/Pilot/pilotRows";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useCanopyStore } from "@/store/canopyStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { SectionBar } from "./CanopySectionBar";
import { CanopyWhereLine } from "./CanopyRow";
import type { CanopyApi } from "./canopyHostSource";
import {
  buildCanopyTrash,
  canopyTrashDomId,
  closedPhrase,
  expiredAnnouncement,
  trashMatches,
  type CanopyTrashItem,
} from "./canopyTrash";

/** How often a shown row's "Closed 12s ago" moves on. */
const CLOCK_TICK_MS = 1000;
/** A run that leaves this close to its deadline left because its time ran out. */
const EXPIRY_SLACK_MS = 1000;
/** How long a run that left at its deadline is given to turn up in the fleet, restored. */
const EXPIRY_CONFIRM_MS = 1500;

export interface CanopyTrashSectionHandle {
  /** Down off the inbox's last row: onto the Trash bar. False when there is no Trash shown. */
  focusHeader: () => boolean;
}

/** One trash of one run: what the panel acted on, so its leaving isn't said as an expiry. */
function trashKey(item: { runId: string; expiresAt: number }): string {
  return `${item.runId}:${item.expiresAt}`;
}

function targetOf(item: CanopyTrashItem): CanopyTrashTarget {
  return { spawnedAt: item.spawnedAt, expiresAt: item.expiresAt };
}

function failed(title: string, error: unknown): void {
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    title,
    message: formatErrorMessage(error, "It has left the trash."),
    context: { eventKind: "agent" },
    duration: 6000,
  });
}

/**
 * Canopy's Trash: every agent run the host's trash holds, whichever project it
 * is in and however it was closed, newest first. Folded by default, as
 * Archived is; a search shows its matching rows open. Enter, the row's
 * Restore and its menu put a run back where it was; Remove now and Empty
 * trash end the process for good, so each confirms first.
 */
export function CanopyTrashSection({
  ref,
  entries,
  workspaces,
  terms,
  api,
  scopeKey,
  dockAnnounces,
  onLeaveUp,
  onSearch,
  onRestored,
  isBackInFleet,
}: {
  ref?: Ref<CanopyTrashSectionHandle>;
  /** The host's trash as its snapshot has it, newest first. */
  entries: readonly CanopyTrashEntry[];
  workspaces: ReadonlyMap<string, PilotWorkspaceMeta>;
  /** The search's words: a search shows the rows it matches, open. */
  terms: readonly string[];
  api: Pick<CanopyApi, "restoreTrashed" | "removeTrashed" | "emptyTrash">;
  /** The host or hosts shown: another's trash starts afresh, its departures unsaid. */
  scopeKey: string;
  /** The dock beside the panel says this run's expiry itself: its own project's trash. */
  dockAnnounces: (workspaceId: string) => boolean;
  /** Up off the Trash bar, back into the inbox. */
  onLeaveUp: () => void;
  /** "/" from a row. */
  onSearch: () => void;
  /** A run put back from here: the inbox selects it once it is back. */
  onRestored: (runId: string) => void;
  /** The run is in the fleet again: it left the trash restored, whatever its deadline. */
  isBackInFleet: (runId: string) => boolean;
}) {
  const expanded = useCanopyStore((s) => s.trashExpanded);
  const setExpanded = useCanopyStore((s) => s.setTrashExpanded);
  const searching = terms.length > 0;
  const open = expanded || searching;

  // Named and placed as each run's inbox row was. The clock behind the rows'
  // age matters to no row here: the trash keeps none past a minute.
  const items = useMemo(
    () => buildCanopyTrash(entries, workspaces, Date.now()),
    [entries, workspaces]
  );
  const shown = useMemo(
    () => (searching ? items.filter((item) => trashMatches(item, terms)) : items),
    [items, terms, searching]
  );
  const rowsShown = open && shown.length > 0;

  // To the second while rows are on screen, and not at all otherwise.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!rowsShown) return;
    setNowMs(Date.now());
    const handle = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(handle);
  }, [rowsShown]);

  // Trashes this panel restored or removed: their leaving is no expiry.
  const actedRef = useRef(new Set<string>());
  // The host or hosts shown now, for an answer that comes back after a switch.
  const scopeRef = useRef(scopeKey);
  useLayoutEffect(() => {
    scopeRef.current = scopeKey;
  });
  const isBackRef = useRef(isBackInFleet);
  useLayoutEffect(() => {
    isBackRef.current = isBackInFleet;
  });
  const confirmTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = confirmTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const announced = useRef<{ scope: string; held: Map<string, CanopyTrashItem> }>({
    scope: scopeKey,
    held: new Map(),
  });
  // A run leaving at its deadline was let go by the trash, not by anyone:
  // said once, politely, as the dock says its own. Another host's list, or
  // this one's first, has no departures to say. A restore elsewhere just
  // before the deadline looks the same here until the run is back in the
  // fleet, so it is said only once the fleet has had time to show it.
  useEffect(() => {
    const now = Date.now();
    const current = new Map(items.map((item) => [trashKey(item), item]));
    const before = announced.current;
    const expired: CanopyTrashItem[] = [];
    if (before.scope === scopeKey) {
      for (const [key, item] of before.held) {
        if (current.has(key)) continue;
        if (actedRef.current.delete(key)) continue;
        if (now < item.expiresAt - EXPIRY_SLACK_MS) continue;
        if (dockAnnounces(item.row.run.workspaceId)) continue;
        expired.push(item);
      }
    } else {
      actedRef.current.clear();
    }
    announced.current = { scope: scopeKey, held: current };
    if (expired.length === 0) return;
    const timer = setTimeout(() => {
      confirmTimers.current.delete(timer);
      if (scopeRef.current !== scopeKey) return;
      const gone = expired.filter((item) => !isBackRef.current(item.runId));
      if (gone.length > 0) {
        useAnnouncerStore
          .getState()
          .announce(expiredAnnouncement(gone.map((item) => item.subject)));
      }
    }, EXPIRY_CONFIRM_MS);
    confirmTimers.current.add(timer);
  }, [items, scopeKey, dockAnnounces]);

  const headerRef = useRef<HTMLButtonElement>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  useEffect(() => setSelectedRunId(null), [scopeKey]);
  const tabStop = shown.some((item) => item.runId === selectedRunId)
    ? selectedRunId
    : (shown[0]?.runId ?? null);
  const focusRow = (runId: string) => {
    setSelectedRunId(runId);
    document.getElementById(canopyTrashDomId(runId))?.focus();
  };

  useImperativeHandle(
    ref,
    () => ({
      focusHeader: () => {
        if (headerRef.current) {
          headerRef.current.focus();
          return true;
        }
        // A search shows its matches open, with no bar to land on: the first one.
        const first = document.querySelector<HTMLElement>("#canopy-trash [data-canopy-trash-row]");
        if (!first) return false;
        first.focus();
        return true;
      },
    }),
    []
  );

  // The row that had the keyboard left (removed, expired, restored): the
  // keyboard goes on to the next row, else the bar, else back up into the
  // inbox. A run restored from here takes it on once it is back.
  const shownBeforeRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    const before = shownBeforeRef.current;
    const now = shown.map((item) => item.runId);
    shownBeforeRef.current = now;
    if (selectedRunId === null || now.includes(selectedRunId)) return;
    const index = before.indexOf(selectedRunId);
    if (index === -1) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const next = shown[Math.min(index, shown.length - 1)];
    if (next) focusRow(next.runId);
    else if (headerRef.current) headerRef.current.focus();
    else onLeaveUp();
  });

  const restore = (item: CanopyTrashItem) => {
    const key = trashKey(item);
    const scope = scopeKey;
    actedRef.current.add(key);
    safeFireAndForget(
      api.restoreTrashed(item.runId, targetOf(item)).then(
        () => {
          // Another host shown by now: its runs are not this one.
          if (scopeRef.current === scope) onRestored(item.runId);
        },
        (error: unknown) => {
          actedRef.current.delete(key);
          failed("Couldn't restore terminal", error);
        }
      )
    );
  };

  const [removing, setRemoving] = useState<CanopyTrashItem | null>(null);
  const confirmRemove = () => {
    const item = removing;
    setRemoving(null);
    if (!item) return;
    const key = trashKey(item);
    actedRef.current.add(key);
    safeFireAndForget(
      api.removeTrashed(item.runId, targetOf(item)).catch((error: unknown) => {
        actedRef.current.delete(key);
        failed("Couldn't remove terminal", error);
      })
    );
  };

  // Exactly the runs listed when the confirm opened, never what the trash
  // holds by the time it is answered.
  const [emptying, setEmptying] = useState<CanopyTrashItem[] | null>(null);
  const confirmEmpty = () => {
    const targets = emptying;
    setEmptying(null);
    if (!targets || targets.length === 0) return;
    const keys = targets.map(trashKey);
    for (const key of keys) actedRef.current.add(key);
    safeFireAndForget(
      api
        .emptyTrash(targets.map((item) => ({ runId: item.runId, ...targetOf(item) })))
        .catch((error: unknown) => {
          for (const key of keys) actedRef.current.delete(key);
          failed("Couldn't empty trash", error);
        })
    );
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, item: CanopyTrashItem) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = shown.findIndex((row) => row.runId === item.runId);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      handled();
      const row = event.currentTarget;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 8,
          clientY: rect.top + rect.height / 2,
        })
      );
      return;
    }
    if (event.shiftKey) return;
    switch (event.key) {
      case "ArrowDown":
      case "j":
        handled();
        if (index < shown.length - 1) focusRow(shown[index + 1]!.runId);
        return;
      case "ArrowUp":
      case "k":
        handled();
        if (index > 0) focusRow(shown[index - 1]!.runId);
        else if (headerRef.current) headerRef.current.focus();
        else onLeaveUp();
        return;
      case "Home":
        handled();
        focusRow(shown[0]!.runId);
        return;
      case "End":
        handled();
        focusRow(shown[shown.length - 1]!.runId);
        return;
      case "/":
        handled();
        onSearch();
        return;
      case "Enter":
        handled();
        restore(item);
        return;
    }
  };

  if (shown.length === 0 && !emptying && !removing) return null;

  return (
    <>
      {shown.length > 0 && (
        <SectionBar
          id="canopy-trash-label"
          label="Trash"
          count={shown.length}
          countNoun="trashed agent"
          // A search shows its matches open; the fold is the user's again after.
          fold={
            searching
              ? undefined
              : {
                  expanded,
                  controls: "canopy-trash",
                  onToggle: () => setExpanded(!expanded),
                  onEnter: () => focusRow(shown[0]!.runId),
                  onLeaveUp,
                  buttonRef: headerRef,
                }
          }
          menu={
            searching ? undefined : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Trash options"
                    className="shrink-0 text-text-secondary"
                  >
                    <Ellipsis aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem destructive onSelect={() => setEmptying(items)}>
                    Empty trash…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
        />
      )}
      {rowsShown && (
        <div id="canopy-trash" role="listbox" aria-labelledby="canopy-trash-label">
          {shown.map((item) => (
            <ContextMenu key={item.runId}>
              {/* Contents, so the trigger adds no box between the list and its rows. */}
              <ContextMenuTrigger asChild>
                <div className="contents">
                  <CanopyTrashRow
                    item={item}
                    nowMs={nowMs}
                    isSelected={selectedRunId === item.runId}
                    tabbable={tabStop === item.runId}
                    onSelect={() => setSelectedRunId(item.runId)}
                    onRestore={() => restore(item)}
                    onKeyDown={(event) => onRowKeyDown(event, item)}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem aria-keyshortcuts="Enter" onSelect={() => restore(item)}>
                  Restore
                  <ContextMenuShortcut shortcut="Enter" />
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem destructive onSelect={() => setRemoving(item)}>
                  Remove now…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}
      <ConfirmDialog
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove '${removing?.subject ?? ""}'?`}
        description={`${removing?.subject ?? "This panel"} will be permanently removed.`}
        variant="destructive"
        confirmLabel="Remove panel"
        onConfirm={confirmRemove}
        restoreFocusTo={() => headerRef.current}
      />
      <ConfirmDialog
        isOpen={emptying !== null}
        onClose={() => setEmptying(null)}
        title="Empty trash?"
        description={`${pluralize(emptying?.length ?? 0, "panel")} will be permanently removed.`}
        variant="destructive"
        // The list of what is removed: a dialog, not an alertdialog.
        hasPreview
        confirmLabel="Empty trash"
        onConfirm={confirmEmpty}
        restoreFocusTo={() => headerRef.current}
      >
        <div className="max-h-40 overflow-y-auto">
          <ul className="space-y-0.5 text-xs text-text-secondary">
            {(emptying ?? []).map((item) => (
              <li key={item.runId} className="truncate">
                {item.subject}
              </li>
            ))}
          </ul>
        </div>
      </ConfirmDialog>
    </>
  );
}

/**
 * One run in the trash: its name, the agent it ran, where it ran and when it
 * was closed, at a compact row's size. Restore stays on the row, for a mouse;
 * the keyboard has Enter.
 */
function CanopyTrashRow({
  item,
  nowMs,
  isSelected,
  tabbable,
  onSelect,
  onRestore,
  onKeyDown,
}: {
  item: CanopyTrashItem;
  nowMs: number;
  isSelected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onRestore: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const domId = canopyTrashDomId(item.runId);
  const { row, workspace, subject } = item;
  const closed = closedPhrase(item.trashedAt, nowMs);
  const project = workspace.name || null;
  const worktree = row.worktreeLabel !== subject ? row.worktreeLabel : null;
  const host = workspace.host;
  const meta = [
    row.chrome.label !== subject ? row.chrome.label : null,
    closed.toLowerCase(),
    [project, worktree, host].filter(Boolean).join(" · "),
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
  return (
    <div
      id={domId}
      role="option"
      aria-selected={isSelected}
      aria-label={subject}
      aria-describedby={`${domId}-meta`}
      aria-keyshortcuts="Enter"
      tabIndex={tabbable ? 0 : -1}
      data-canopy-trash-row=""
      onFocus={() => {
        if (!isSelected) onSelect();
      }}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className="canopy-inbox-row group/row relative flex w-full shrink-0 cursor-pointer items-stretch gap-3 px-3 py-2.5 text-left"
    >
      <span id={`${domId}-meta`} className="sr-only">
        {meta}
      </span>
      {/* The leading column keeps a live row's shape: no state to show, its agent beside it. */}
      <span aria-hidden="true" className="flex w-10 shrink-0 flex-col">
        <span className="flex h-5 items-center gap-2">
          <span className="size-4" />
          <span className="flex size-4 items-center justify-center">
            <TerminalIcon
              chrome={row.chrome}
              className="h-4 w-4"
              brandColor={row.presetColor ?? row.chrome.color}
            />
          </span>
        </span>
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm leading-5 text-text-primary">
            {subject}
          </span>
          <Button
            variant="ghost"
            size="xs"
            // A mouse affordance: the row has the keyboard, and Enter restores.
            tabIndex={-1}
            data-canopy-trash-restore=""
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onRestore();
            }}
            className="-my-0.5 shrink-0 text-text-secondary hover:text-text-primary"
          >
            <RotateCcw aria-hidden="true" />
            Restore
          </Button>
        </span>
        <span className="flex h-4 min-w-0 items-center text-xs leading-4 text-text-secondary">
          <span className="min-w-0 truncate tabular-nums">{closed}</span>
        </span>
        <CanopyWhereLine
          emoji={workspace.emoji}
          project={project}
          worktree={worktree}
          host={host}
        />
      </span>
    </div>
  );
}
