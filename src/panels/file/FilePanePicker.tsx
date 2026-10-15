import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HighlightedText, substringMatchIndices } from "@/components/ui/HighlightedText";
import { PathSegments } from "@/components/ui/PathSegments";
import { PathTail } from "@/components/ui/PathTail";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { SearchField } from "@/components/ui/SearchField";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import {
  FILE_TREE_ICON_CLASS,
  FILE_TREE_ICON_COLOR_CLASS,
  getFileTypeIcon,
} from "@/panels/file-browser/fileTypeIcons";
import { filesClient } from "@/clients/filesClient";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { isPointerClaimed } from "@/lib/pointerClaim";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logError } from "@/utils/logger";

const SEARCH_DEBOUNCE_MS = 150;
// The files:search IPC schema caps `limit` at 100; asking for more than the
// picker lists is what tells it the list is not the whole answer.
const SEARCH_LIMIT = 100;
const RESULT_CAP = 50;
// `ScrollShadow`'s compact fade: a name under it is not yet a readable target.
const SCROLL_FADE_PX = 16;

// The list's scroll fade has to land on the pane body's own colour.
const RESULT_AREA_STYLE: CSSProperties & Record<"--scroll-shadow-color", string> = {
  "--scroll-shadow-color": "var(--color-surface-canvas)",
};

interface PickerResult {
  relativePath: string;
  absolutePath: string;
  name: string;
  directory: string;
}

interface SettledSearch {
  /** The request this answer belongs to. */
  key: string;
  query: string;
  results: PickerResult[];
  /** The search found more files than the picker lists. */
  more: boolean;
  failed: boolean;
}

const NOTHING_SETTLED: SettledSearch = {
  key: "",
  query: "",
  results: [],
  more: false,
  failed: false,
};

function toResult(root: string, relativePath: string): PickerResult {
  const slash = relativePath.lastIndexOf("/");
  return {
    relativePath,
    absolutePath: `${root}/${relativePath}`,
    name: relativePath.slice(slash + 1),
    directory: slash > 0 ? relativePath.slice(0, slash) : "",
  };
}

/**
 * Debounced file search over the panel's root. The last answer stays on screen
 * while a newer one is in flight (`pending`), and a failed search is kept apart
 * from an answer with nothing in it. `generation` names one request: every edit
 * and every retry is a new one, even when it asks the same thing as an earlier
 * request did.
 */
function useFileSearch(rootPath: string, query: string, generation: number) {
  const [settled, setSettled] = useState<SettledSearch>(NOTHING_SETTLED);
  const key = `${rootPath}\u0000${generation}`;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      filesClient
        // An empty query lists the first files alphabetically.
        .search({ cwd: rootPath, query, limit: SEARCH_LIMIT })
        .then(({ files }) => {
          if (cancelled) return;
          const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
          const paths = files.filter((f) => !f.endsWith("/"));
          setSettled({
            key,
            query,
            results: paths.slice(0, RESULT_CAP).map((p) => toResult(root, p)),
            more: paths.length > RESULT_CAP,
            failed: false,
          });
        })
        .catch((err) => {
          if (cancelled) return;
          setSettled({ key, query, results: [], more: false, failed: true });
          logError("[FilePane] file search failed", err);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rootPath, query, key]);

  return {
    ...settled,
    /** The request the field is asking right now. */
    request: key,
    pending: settled.key !== key,
  };
}

/**
 * Whether a row's folder has wrapped under its name. Measured rather than
 * guessed from string lengths, because the break depends on the pane's width
 * and the font; the row then takes the two-line height.
 */
function useWrapsToSecondLine() {
  const [wrapped, setWrapped] = useState(false);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const check = () => {
      const first = el.firstElementChild;
      const last = el.lastElementChild;
      // Past half the name's height, not merely lower: on one line the smaller
      // folder sits a few pixels down on the name's baseline.
      setWrapped(
        first instanceof HTMLElement &&
          last instanceof HTMLElement &&
          last !== first &&
          last.offsetTop > first.offsetTop + first.offsetHeight / 2
      );
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, wrapped };
}

interface PickerRowProps {
  result: PickerResult;
  id: string;
  index: number;
  query: string;
  selected: boolean;
  /** Show the full path without a hover: the arrow keys put the cursor here. */
  reveal: boolean;
  onHover: (index: number) => void;
  onOpen: (absolutePath: string) => void;
  onDismissReveal: () => void;
}

function PickerRow({
  result,
  id,
  index,
  query,
  selected,
  reveal,
  onHover,
  onOpen,
  onDismissReveal,
}: PickerRowProps) {
  const { ref: nameRef, isTruncated: nameCut } = useTruncationDetection();
  const { ref: directoryRef, isTruncated: directoryCut } = useTruncationDetection();
  const { ref: linesRef, wrapped } = useWrapsToSecondLine();
  const { Icon } = getFileTypeIcon(result.name);
  return (
    <TruncatedTooltip
      content={
        <span className="font-mono text-xs">
          <PathSegments path={result.relativePath} />
        </span>
      }
      isTruncated={nameCut || directoryCut}
      focusable={false}
      side="bottom"
      align="start"
      open={reveal || undefined}
      onOpenChange={(next) => {
        if (!next) onDismissReveal();
      }}
    >
      <button
        id={id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        // The name and folder are two parts, the folder drawn right to left; the
        // path read whole says the same thing in order.
        aria-label={result.relativePath}
        data-option-index={index}
        data-testid="file-pane-result"
        // Focus stays in the search field; rows are reached through
        // `aria-activedescendant`, never the Tab sequence.
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => onHover(index)}
        onClick={() => onOpen(result.absolutePath)}
        className={cn(
          PALETTE_ROW_CLASS,
          // The icon lands under the field's magnifier and the name under its
          // text: both insets match the palette-size field's.
          "flex w-full min-w-0 shrink-0 items-center gap-2 rounded-[var(--radius-md)] px-3 text-left text-sm text-text-secondary",
          wrapped ? "py-2" : "py-1.5"
        )}
      >
        <Icon
          className={cn("h-4 w-4 shrink-0", FILE_TREE_ICON_COLOR_CLASS, FILE_TREE_ICON_CLASS)}
          aria-hidden="true"
        />
        {/* The name is what the row is; the folder gives way first, and takes a
            line of its own rather than shrinking to a sliver beside a long name. */}
        <span ref={linesRef} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span
            ref={nameRef}
            data-file-name=""
            className="max-w-full shrink-0 truncate text-text-primary"
          >
            <HighlightedText
              text={result.name}
              indices={substringMatchIndices(result.name, query)}
            />
          </span>
          {result.directory && (
            <PathTail
              ref={directoryRef}
              className="min-w-[10ch] flex-1 basis-0 font-mono text-xs text-text-secondary"
            >
              {result.directory}
            </PathTail>
          )}
        </span>
      </button>
    </TruncatedTooltip>
  );
}

export interface FilePanePickerProps {
  /** The folder searched — the panel's worktree, else the project. */
  rootPath: string;
  onOpen: (absolutePath: string) => void;
}

/**
 * The empty file pane's picker: a search field driving a list of the root's
 * files. The field keeps focus; the arrow keys and the pointer move one
 * highlighted row, and Enter or a click opens it in this pane.
 */
export function FilePanePicker({ rootPath, onOpen }: FilePanePickerProps) {
  const [{ query, generation }, setRequest] = useState({ query: "", generation: 0 });
  const search = useFileSearch(rootPath, query, generation);
  const { results } = search;
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter with no row on screen yet waits for the answer to the request it was
  // typed against, and only while the field still has focus.
  const enterQueuedForRef = useRef<string | null>(null);
  // Retry was pressed and has not been answered: a success removes the button,
  // and focus goes back to the field rather than falling to the page.
  const retryHandoffRef = useRef(false);

  // Returning to an earlier query is still a new request, so it starts over at
  // its top hit instead of reviving a pick, or a queued Enter, from last time.
  const ask = (next: string) => {
    enterQueuedForRef.current = null;
    setRequest((current) => ({ query: next, generation: current.generation + 1 }));
  };
  const retry = () => {
    if (search.pending) return;
    retryHandoffRef.current = true;
    setRequest((current) => ({ ...current, generation: current.generation + 1 }));
  };

  // A row the user picked, by path and for the request they picked it in. A new
  // query starts over at its top hit; a pick made while that query's answer was
  // still on its way survives the answer, as long as the file is in it. The
  // index is derived at read time, so the highlight, the active descendant and
  // Enter can never resolve against two different lists for a frame.
  const [choice, setChoice] = useState<{ request: string; path: string; byKeys: boolean } | null>(
    null
  );
  const current = choice?.request === search.request ? choice : null;
  const chosenIndex = current ? results.findIndex((r) => r.absolutePath === current.path) : -1;
  const activeIndex = results.length === 0 ? -1 : Math.max(chosenIndex, 0);
  // The arrow keys, not the pointer or a new answer, put the cursor here: a
  // clipped path then shows in full without a hover.
  const keyboardCursor = chosenIndex >= 0 && current?.byKeys === true;

  const [fieldFocused, setFieldFocused] = useState(false);
  const [pointerInList, setPointerInList] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-files`;
  const optionId = (index: number) => `${baseId}-file-${index}`;

  // No row is "the one Enter opens" while Enter would go somewhere else.
  const showCursor = activeIndex >= 0 && (fieldFocused || pointerInList);

  // The row the keys landed on shows its full path, opened only once revealing
  // it has scrolled: Radix closes a tooltip whose trigger's scroller scrolls, so
  // a reveal opened first would be shut by its own scroll.
  const revealTarget = keyboardCursor && showCursor ? `${search.key}\u0000${activeIndex}` : null;
  const [revealed, setRevealed] = useState<string | null>(null);

  // Set while a scroll is the cursor's own reveal rather than the user's, so
  // `handleListScroll` leaves it alone. A scroll event fires before the next
  // animation frame, which is where the flag drops.
  const revealScrollRef = useRef(false);

  useEffect(() => {
    if (!showCursor) return;
    const row = listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`);
    // A row the pointer just claimed is already where the user is looking.
    if (row instanceof HTMLElement && !isPointerClaimed(row)) {
      revealScrollRef.current = true;
      row.scrollIntoView({ block: "nearest" });
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      revealScrollRef.current = false;
      if (revealTarget !== null) second = requestAnimationFrame(() => setRevealed(revealTarget));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      revealScrollRef.current = false;
    };
  }, [activeIndex, showCursor, revealTarget, search.key]);

  useEffect(() => {
    const queued = enterQueuedForRef.current;
    if (queued === null || search.pending) return;
    enterQueuedForRef.current = null;
    const top = search.results[0];
    if (queued === search.key && top && !search.failed) onOpen(top.absolutePath);
  }, [search.pending, search.key, search.results, search.failed, onOpen]);

  const moveCursor = (index: number, byKeys: boolean) => {
    const target = results[index];
    if (target) setChoice({ request: search.request, path: target.absolutePath, byKeys });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (keyBelongsToField(event)) return;
    const next = stepListboxCursor(event.key, activeIndex, results.length);
    if (next !== null) {
      event.preventDefault();
      moveCursor(next, true);
      return;
    }
    if (event.key !== "Enter") return;
    // The highlighted row is always what Enter opens.
    if (activeIndex >= 0) {
      event.preventDefault();
      onOpen(results[activeIndex]!.absolutePath);
    } else if (search.pending) {
      event.preventDefault();
      enterQueuedForRef.current = search.request;
    }
  };

  const handleHover = (index: number) => {
    if (index !== activeIndex || keyboardCursor) moveCursor(index, false);
  };

  // The wheel or the scrollbar took the highlighted file's name out of sight:
  // Enter must not open a file the user can no longer read, so the cursor comes
  // along to the nearest row whose name is. "Readable" stops short of an edge
  // fade, and only where the list can scroll further, so the first and last
  // rows at rest are never counted as hidden.
  const handleListScroll = () => {
    const list = listRef.current;
    if (revealScrollRef.current || activeIndex < 0 || !list) return;
    const row = list.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    if (!row) return;
    const view = list.getBoundingClientRect();
    const top = view.top + (list.scrollTop > 0 ? SCROLL_FADE_PX : 0);
    const bottom =
      view.bottom -
      (list.scrollTop + list.clientHeight < list.scrollHeight - 1 ? SCROLL_FADE_PX : 0);
    const nameBox = (r: HTMLElement) =>
      (r.querySelector("[data-file-name]") ?? r).getBoundingClientRect();
    const readable = (r: HTMLElement) => {
      const b = nameBox(r);
      return b.top >= top - 1 && b.bottom <= bottom + 1;
    };
    if (readable(row)) return;
    const inView = [...list.querySelectorAll<HTMLElement>("[data-option-index]")].filter(readable);
    const nearest = nameBox(row).top < top ? inView[0] : inView[inView.length - 1];
    if (nearest) moveCursor(Number(nearest.dataset.optionIndex), false);
  };

  const hasRows = results.length > 0 && !search.failed;
  const showSearching = useDohertyGate(search.pending && !hasRows && !search.failed);
  // A retry under the Doherty threshold needs no spinner; `retry` still ignores
  // a second press from the first millisecond.
  const showRetrySpinner = useDohertyGate(search.pending && search.failed);
  const answered = search.key !== "";
  const settledQuery = search.query.trim();

  let status = "";
  if (search.failed) status = "Couldn't search files";
  else if (showSearching) status = "Searching…";
  else if (answered && settledQuery) status = `No matches for "${settledQuery}"`;
  else if (answered) status = "Add a file to this folder to open it here";

  // What a settled answer says to assistive technology, once typing pauses.
  // Through the announcer rather than a live region, so two answers that say
  // the same thing are both spoken. The unprompted first listing stays quiet.
  let announcement: string | null = null;
  if (answered && !search.pending) {
    if (search.failed) announcement = "Couldn't search files";
    else if (!hasRows) announcement = status;
    else if (settledQuery)
      announcement = search.more
        ? `${pluralize(RESULT_CAP, "file")} shown, more available`
        : pluralize(results.length, "file");
  }
  useEffect(() => {
    if (announcement === null) return;
    const timer = setTimeout(
      () => useAnnouncerStore.getState().announce(announcement, "polite"),
      UI_DOHERTY_THRESHOLD
    );
    return () => clearTimeout(timer);
  }, [announcement, search.key]);

  // The wait is said once, when its line appears; the gate is the delay.
  useEffect(() => {
    if (showSearching) useAnnouncerStore.getState().announce("Searching…", "polite");
  }, [showSearching]);

  useEffect(() => {
    if (!retryHandoffRef.current || search.pending) return;
    retryHandoffRef.current = false;
    // A second failure keeps Retry on screen, and focus with it. Focus the user
    // moved somewhere else while waiting stays where they put it.
    if (search.failed) return;
    const active = document.activeElement;
    if (active === null || active === document.body) inputRef.current?.focus();
  }, [search.pending, search.failed, search.key]);

  return (
    <div className="flex min-h-0 w-full max-w-md flex-col gap-2">
      <SearchField
        size="palette"
        fieldClassName="shrink-0"
        inputRef={inputRef}
        value={query}
        onChange={(event) => ask(event.target.value)}
        onClear={() => ask("")}
        onKeyDown={handleKeyDown}
        onFocus={() => setFieldFocused(true)}
        onBlur={() => {
          enterQueuedForRef.current = null;
          setFieldFocused(false);
        }}
        placeholder="Search files"
        aria-label="Search files"
        role="combobox"
        aria-expanded={hasRows}
        aria-controls={hasRows ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={fieldFocused && hasRows ? optionId(activeIndex) : undefined}
        data-testid="file-pane-search"
      />
      {/* A fixed height that only the pane's own size can shrink, so the field
          stays put while answers come and go. */}
      <div className="flex h-56 min-h-24 shrink flex-col" style={RESULT_AREA_STYLE}>
        {!hasRows && status && (
          <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
            {search.failed && (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
            )}
            <p
              data-testid="file-pane-search-status"
              className="min-w-0 truncate text-text-secondary"
            >
              {status}
            </p>
            {search.failed && (
              <Button
                variant="ghost"
                size="xs"
                onClick={retry}
                loading={showRetrySpinner}
                // Not `disabled`: that would drop focus to the page mid-retry.
                aria-disabled={search.pending || undefined}
                className="-my-1 shrink-0"
              >
                <RefreshCw aria-hidden="true" />
                Retry
              </Button>
            )}
          </div>
        )}
        {hasRows && (
          <ScrollShadow
            ref={listRef}
            compact
            className="flex-1"
            scrollClassName={cn(search.pending && "palette-results-stale")}
            onPointerEnter={() => setPointerInList(true)}
            onPointerLeave={() => setPointerInList(false)}
            onScroll={handleListScroll}
          >
            <div
              id={listId}
              role="listbox"
              aria-label="Files"
              aria-busy={search.pending || undefined}
              className="flex flex-col"
            >
              {results.map((result, index) => (
                <PickerRow
                  key={result.absolutePath}
                  result={result}
                  id={optionId(index)}
                  index={index}
                  query={search.query}
                  selected={showCursor && index === activeIndex}
                  reveal={
                    revealTarget !== null && revealed === revealTarget && index === activeIndex
                  }
                  onHover={handleHover}
                  onOpen={onOpen}
                  onDismissReveal={() => moveCursor(activeIndex, false)}
                />
              ))}
            </div>
            {search.more && (
              <p className="px-3 py-1.5 text-xs text-text-secondary">
                Showing the first {pluralize(RESULT_CAP, "file")} — type to narrow
              </p>
            )}
          </ScrollShadow>
        )}
      </div>
    </div>
  );
}
