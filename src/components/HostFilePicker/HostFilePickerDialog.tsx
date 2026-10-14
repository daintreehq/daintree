import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Link2,
  RefreshCw,
} from "lucide-react";
import type {
  HostDirectoryEntry,
  HostDirectoryListing,
  HostPickRequest,
  HostPickerRoots,
} from "@shared/types/ipc/hostFiles";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/Kbd";
import { LIST_DETAIL_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { PathTail } from "@/components/ui/PathTail";
import { ROW_CONTROL_CLASS, RowControlTooltip } from "@/components/ui/RowControl";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Server } from "@/components/icons";
import { PlatformGlyph } from "@/components/Hosts/PlatformGlyph";
import { splitHostName } from "@/components/Hosts/hostModel";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { isMac } from "@/lib/platform";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  confirmButtonLabel,
  formatEntrySize,
  hostPathCrumbs,
  hostPathLeaf,
  hostPathParent,
  isAbsoluteHostPath,
  isNavigable,
  isSelectable,
  joinHostPath,
  resolveChoice,
  splitFileName,
} from "./hostFilePickerModel";
import { usePickerHost, type PickerHost } from "./usePickerHost";
import { clientErrorText } from "@/utils/clientAppError";

/**
 * Where the picker reads folders from: the window's own host, or — when the
 * request names another — that host through the Shell.
 */
function pickerSource(hostId: string | undefined) {
  if (hostId === undefined) {
    return {
      roots: () => window.electron.hostFiles.getPickerRoots(),
      list: (path: string, showHidden: boolean) =>
        window.electron.hostFiles.listDirectory({ path, showHidden }),
    };
  }
  return {
    roots: () => window.electron.hostSwitch.pickerRoots({ toHostId: hostId }),
    list: (path: string, showHidden: boolean) =>
      window.electron.hostSwitch.listDirectory({ toHostId: hostId, path, showHidden }),
  };
}

interface HostFilePickerDialogProps {
  request: HostPickRequest;
  onResolve(paths: string[] | null): void;
}

function EntryIcon({ entry }: { entry: HostDirectoryEntry }) {
  const className = "h-4 w-4 shrink-0 text-text-secondary";
  if (entry.kind === "directory") return <Folder className={className} aria-hidden />;
  if (entry.kind === "symlink") return <Link2 className={className} aria-hidden />;
  return <File className={className} aria-hidden />;
}

/**
 * Which machine is being browsed, left of the path and never truncated away:
 * the same path exists on every host, so the path alone never says where.
 * The name's head gives way before its distinguishing tail, as in the host chip.
 */
function HostBadge({ host }: { host: PickerHost }) {
  const { nameHead, nameTail, nameDomain } = splitHostName(host.name);
  // Measured on the parts that give way; only a cut name earns a tab stop.
  const { ref: headRef, isTruncated: headCut } = useTruncationDetection();
  const { ref: domainRef, isTruncated: domainCut } = useTruncationDetection();
  return (
    <TruncatedTooltip
      content={`${host.name} · ${host.remote ? "remote host" : "this machine"}`}
      isTruncated={headCut || domainCut}
    >
      <div
        data-testid="host-picker-host"
        data-host-location={host.remote ? "remote" : "local"}
        aria-label={`Browsing ${host.name}, ${host.remote ? "remote host" : "this machine"}`}
        role="img"
        className="flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle px-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
      >
        {host.remote ? (
          <Server className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        ) : (
          <PlatformGlyph platform={host.platform} className="shrink-0 text-text-secondary" />
        )}
        <span className="flex min-w-0 font-medium">
          {host.remote ? (
            <>
              <span ref={headRef} className="min-w-0 truncate">
                {nameHead}
              </span>
              <span className="shrink-0">{nameTail}</span>
              {nameDomain && (
                <span ref={domainRef} className="min-w-0 shrink-[100] truncate text-text-secondary">
                  {nameDomain}
                </span>
              )}
            </>
          ) : (
            <span ref={headRef} className="truncate">
              {host.name}
            </span>
          )}
        </span>
      </div>
    </TruncatedTooltip>
  );
}

const CRUMB_FOLD_CHARS = 48;

const CRUMB_CLASS =
  "min-w-0 shrink truncate rounded-[var(--radius-sm)] px-1 py-0.5 text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary";

/**
 * The folder being shown as clickable segments. A deep path keeps its root,
 * the parent and the folder itself, and folds the rest behind "…"; the folder
 * itself gives way last. Keyboard users reach the same places through the
 * path field and the parent button. The space after the leaf is the way into editing the path.
 */
function PathCrumbs({
  path,
  onNavigate,
  onEdit,
}: {
  path: string;
  onNavigate(path: string): void;
  onEdit(): void;
}) {
  const crumbs = hostPathCrumbs(path);
  const leaf = crumbs[crumbs.length - 1]!;
  const ancestors = crumbs.slice(0, -1);
  // Fold only a path too long for the strip; a short one stays whole.
  const folded =
    ancestors.length > 3 && path.length > CRUMB_FOLD_CHARS ? ancestors.slice(1, -1) : [];
  const shown =
    folded.length > 0 ? [ancestors[0]!, null, ancestors[ancestors.length - 1]!] : ancestors;
  const separator = (
    <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
  );

  return (
    <div className="flex h-8 min-w-0 flex-1 items-center rounded-[var(--radius-md)] border border-border-input bg-surface-input pl-1.5 text-sm">
      <nav aria-label="Folder path" className="flex min-w-0 items-center gap-0.5">
        {shown.map((crumb, index) =>
          crumb === null ? (
            <span key="folded" className="flex shrink-0 items-center gap-0.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${folded.length} more folders`}
                    className={cn(CRUMB_CLASS, "shrink-0")}
                  >
                    …
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {folded.map((hidden) => (
                    <DropdownMenuItem key={hidden.path} onSelect={() => onNavigate(hidden.path)}>
                      <Folder className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
                      {hidden.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {separator}
            </span>
          ) : (
            <span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                tabIndex={-1}
                title={crumb.path}
                onClick={() => onNavigate(crumb.path)}
                className={cn(CRUMB_CLASS, index === 0 && "shrink-0")}
              >
                {crumb.name}
              </button>
              {separator}
            </span>
          )
        )}
        <TruncatedTooltip content={leaf.path} focusable={false}>
          <span
            aria-current="location"
            className="min-w-0 shrink-0 truncate px-1 font-medium text-text-primary max-w-[60%]"
          >
            {leaf.name}
          </span>
        </TruncatedTooltip>
      </nav>
      <button
        type="button"
        aria-label="Edit path"
        onClick={onEdit}
        className="h-full min-w-6 flex-1 cursor-text rounded-r-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
      />
    </div>
  );
}

/**
 * A row's name: its middle gives way, its last few characters and extension
 * never do, so `quarterly-plan-…-final v3.pdf` still says which one it is. The
 * full name is the option's accessible name, and the tooltip whenever it is
 * cut — on hover, or on the row the arrow keys are on.
 */
function EntryName({
  entry,
  reveal,
  onDismiss,
}: {
  entry: HostDirectoryEntry;
  reveal?: boolean;
  onDismiss?: () => void;
}) {
  const { head, tail, extension } = splitFileName(entry.name, entry.kind);
  return (
    <span className="flex min-w-0 flex-1 whitespace-pre">
      <TruncatedTooltip
        content={entry.name}
        focusable={false}
        open={reveal || undefined}
        onOpenChange={(next) => {
          if (!next) onDismiss?.();
        }}
      >
        <span className="min-w-0 truncate">{head}</span>
      </TruncatedTooltip>
      {(tail || extension) && <span className="shrink-0">{`${tail}${extension}`}</span>}
    </span>
  );
}

function SummaryLines({
  label,
  name,
  detail,
}: {
  label: string;
  name: React.ReactNode;
  detail: string;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 leading-4">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0">{label}</span>
        <span className="flex min-w-0 font-medium text-text-primary">{name}</span>
      </span>
      <PathTail className="font-mono text-2xs">{detail}</PathTail>
    </span>
  );
}

/**
 * Daintree's own file and folder chooser for a window attached to a remote
 * host. It browses the host's filesystem through the host-files namespace;
 * a native dialog here would browse this machine instead.
 */
export function HostFilePickerDialog({ request, onResolve }: HostFilePickerDialogProps) {
  const [roots, setRoots] = useState<HostPickerRoots | null>(null);
  const [directory, setDirectory] = useState<string | null>(
    isAbsoluteHostPath(request.defaultPath) ? request.defaultPath : null
  );
  const [listing, setListing] = useState<HostDirectoryListing | null>(null);
  // The folder `listing` was fetched for: a listing only ever answers for that one.
  const [listedDirectory, setListedDirectory] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pathDraft, setPathDraft] = useState("");
  // The path field opens focused, so it opens as a field; once focus leaves it
  // the path reads as segments again.
  const [editingPath, setEditingPath] = useState(true);
  // The arrow keys, not the pointer, last moved the active row: its full name
  // then shows without a hover.
  const [keyboardCursor, setKeyboardCursor] = useState(false);
  const [stillWorking, setStillWorking] = useState(false);
  const [pathInput, setPathInput] = useState<HTMLInputElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const focusOwedRef = useRef(true);
  const listPointerRef = useRef(false);
  const listedPathRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const hiddenId = useId();
  const host = usePickerHost(request.hostId);
  const showProgress = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);

  // Each listing request gets its own five seconds.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setStillWorking(true), UI_STILL_WORKING_MS);
    return () => {
      clearTimeout(timer);
      setStillWorking(false);
    };
  }, [loading, directory, reloadKey, showHidden, request.hostId]);

  // AppDialog is told not to place focus: the path field takes it, a frame
  // after the field mounts, so the dialog has already recorded the invoker it
  // hands focus back to on close. Later mounts (Edit path) focus it at once.
  useEffect(() => {
    if (!pathInput) return;
    const place = () => {
      const input = pathInputRef.current;
      if (!input?.isConnected) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
      input.scrollLeft = input.scrollWidth;
    };
    if (!focusOwedRef.current) {
      place();
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (!focusOwedRef.current) return;
      focusOwedRef.current = false;
      place();
    });
    return () => cancelAnimationFrame(frame);
  }, [pathInput]);

  const hostId = request.hostId;

  useEffect(() => {
    let cancelled = false;
    pickerSource(hostId)
      .roots()
      .then((result) => {
        if (cancelled) return;
        setRoots(result);
        setDirectory((current) => current ?? result.home);
      })
      .catch(() => {
        if (!cancelled) setDirectory((current) => current ?? "/");
      });
    return () => {
      cancelled = true;
    };
  }, [hostId]);

  useEffect(() => {
    if (directory === null) return;
    let cancelled = false;
    setLoading(true);
    pickerSource(hostId)
      .list(directory, showHidden)
      .then((result) => {
        if (cancelled) return;
        // A refresh of the same folder (Show hidden files, Retry) keeps what is
        // still there selected; a different folder starts over.
        const sameFolder = listedPathRef.current === result.path;
        listedPathRef.current = result.path;
        setListing(result);
        setListedDirectory(directory);
        setPathDraft(result.path);
        setSelectedNames((current) =>
          sameFolder
            ? current.filter((name) =>
                result.entries.some((entry) => entry.name === name && isSelectable(entry, request))
              )
            : []
        );
        setActiveIndex((index) =>
          sameFolder ? Math.min(index, Math.max(0, result.entries.length - 1)) : 0
        );
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(clientErrorText(cause, "Couldn't open that folder"));
        setPathDraft(directory);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, showHidden, reloadKey, hostId]);

  // Keep the end of a long path in view while it is being typed or replaced.
  useEffect(() => {
    const input = pathInputRef.current;
    if (input && document.activeElement === input) input.scrollLeft = input.scrollWidth;
  }, [pathDraft, pathInput]);

  // Anything chosen belongs to the listing on screen, and only while that
  // listing is the answer for the folder asked for: never mid-load, after a
  // failure, or from the folder before.
  const ready = listing !== null && listedDirectory === directory && !loading && loadError === null;
  const entries = useMemo(
    () => (listing && loadError === null ? listing.entries : []),
    [listing, loadError]
  );
  const selectedEntries = ready
    ? entries.filter((entry) => selectedNames.includes(entry.name) && isSelectable(entry, request))
    : [];
  const choice = ready ? resolveChoice(request, listing.path, selectedEntries) : null;
  const confirmLabel = confirmButtonLabel(request, choice?.length ?? 0);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const activeEntry = ready ? entries[activeIndex] : undefined;
  const multiple = request.mode === "file" && request.multiple === true;
  const parentTarget =
    directory === null ? null : ready ? listing.parent : hostPathParent(directory);
  const shownPath = directory ?? listing?.path ?? "";

  const navigate = (target: string) => {
    setLoadError(null);
    setPathError(null);
    setPathDraft(target);
    if (target === directory) {
      setReloadKey((key) => key + 1);
      return;
    }
    setSelectedNames([]);
    setActiveIndex(0);
    setDirectory(target);
  };

  const retry = () => {
    setLoadError(null);
    setReloadKey((key) => key + 1);
  };

  const open = (entry: HostDirectoryEntry) => {
    if (!ready) return;
    if (isNavigable(entry)) {
      navigate(joinHostPath(listing.path, entry.name));
      return;
    }
    if (isSelectable(entry, request)) onResolve([joinHostPath(listing.path, entry.name)]);
  };

  const toggle = (entry: HostDirectoryEntry, additive: boolean) => {
    if (!ready || !isSelectable(entry, request)) return;
    setSelectedNames((current) => {
      if (additive && multiple) {
        return current.includes(entry.name)
          ? current.filter((name) => name !== entry.name)
          : [...current, entry.name];
      }
      return current.length === 1 && current[0] === entry.name ? [] : [entry.name];
    });
  };

  const confirm = () => {
    if (choice) onResolve(choice);
  };

  const editPath = (draft?: string) => {
    if (draft !== undefined) setPathDraft(draft);
    setEditingPath(true);
  };

  const goToDraft = () => {
    const target = pathDraft.trim();
    if (!isAbsoluteHostPath(target)) {
      setPathError("Enter an absolute path, starting with /");
      return;
    }
    navigate(target);
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      editPath();
      return;
    }
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      editPath("/");
      return;
    }
    if (!ready || entries.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setKeyboardCursor(true);
      setActiveIndex((index) => Math.min(entries.length - 1, Math.max(0, index + step)));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setKeyboardCursor(true);
      setActiveIndex(event.key === "Home" ? 0 : entries.length - 1);
      return;
    }
    if (!activeEntry) return;
    if (event.key === "Enter") {
      event.preventDefault();
      // In a multi-select, Enter on a file confirms what is selected, as the
      // button would, rather than picking that one file alone.
      if (multiple && !isNavigable(activeEntry) && choice && selectedEntries.length > 0) {
        confirm();
        return;
      }
      open(activeEntry);
    } else if (event.key === " ") {
      // Space toggles membership in a multi-select, as the listbox pattern
      // has it (and ⌘Space is Spotlight's on a Mac); elsewhere it selects.
      event.preventDefault();
      toggle(activeEntry, multiple || event.metaKey || event.ctrlKey);
    }
  };

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const pendingLeaf = directory ? hostPathLeaf(directory) : null;
  const openingText = pendingLeaf
    ? stillWorking
      ? `Still opening ${pendingLeaf}…`
      : `Opening ${pendingLeaf}…`
    : "";
  const status = loading
    ? showProgress
      ? openingText
      : ""
    : ready
      ? `${hostPathLeaf(listing.path)}, ${pluralize(entries.length, "item")}`
      : "";

  const hint = pathError ? (
    <span className="truncate text-status-error" role="alert">
      {pathError}
    </span>
  ) : loading ? (
    <span className="truncate">{showProgress ? openingText : ""}</span>
  ) : loadError !== null ? (
    <span className="truncate">Open another folder to continue</span>
  ) : choice && ready ? (
    request.mode === "directory" ? (
      <SummaryLines
        label={selectedEntries.length > 0 ? "Selected folder" : "This folder"}
        name={<span className="truncate">{hostPathLeaf(choice[0]!)}</span>}
        detail={choice[0]!}
      />
    ) : choice.length > 1 ? (
      <TruncatedTooltip
        content={<span className="whitespace-pre-line">{choice.join("\n")}</span>}
        isTruncated
      >
        <span className="min-w-0">
          <SummaryLines
            label={pluralize(choice.length, "file")}
            name={<span className="truncate">{selectedEntries.map((e) => e.name).join(", ")}</span>}
            detail={listing.path}
          />
        </span>
      </TruncatedTooltip>
    ) : (
      <SummaryLines
        label="Selected file"
        name={<EntryName entry={selectedEntries[0]!} />}
        detail={listing.path}
      />
    )
  ) : (
    <span className="truncate">
      {multiple ? "Select one or more files" : "Select a file to continue"}
    </span>
  );

  const keyHint = (keys: string[], action: string) => (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
      {action}
    </span>
  );

  return (
    <AppDialog isOpen onClose={() => onResolve(null)} size="lg" initialFocus="none">
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<FolderOpen className="h-4 w-4 text-text-secondary" />}>
          {request.title}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-6 pt-4">
        <div className="flex items-center gap-2">
          <HostBadge host={host} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Parent folder"
            disabled={parentTarget === null}
            onClick={() => parentTarget !== null && navigate(parentTarget)}
          >
            <ArrowUp />
          </Button>
          {editingPath ? (
            <Input
              ref={(input) => {
                pathInputRef.current = input;
                setPathInput(input);
              }}
              aria-label="Folder path"
              aria-controls={listId}
              value={pathDraft}
              spellCheck={false}
              autoComplete="off"
              className="h-8 min-w-0 flex-1"
              onChange={(event) => {
                setPathDraft(event.target.value);
                setPathError(null);
              }}
              onBlur={() => {
                setEditingPath(false);
                setPathError(null);
                setPathDraft(shownPath);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  goToDraft();
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  listRef.current?.focus();
                }
              }}
            />
          ) : (
            <PathCrumbs path={shownPath} onNavigate={navigate} onEdit={() => editPath()} />
          )}
        </div>

        <div className="relative h-1">
          {showProgress && <ProgressBar label={openingText || "Opening folder"} />}
        </div>

        {roots && roots.roots.length > 0 && (
          <div className="-mt-1 flex flex-wrap items-center gap-1" aria-label="Places">
            {roots.roots.map((root) => (
              <Button
                key={root.path}
                variant="ghost"
                size="xs"
                title={root.path}
                onClick={() => navigate(root.path)}
              >
                {root.label}
              </Button>
            ))}
          </div>
        )}

        <div role="status" className="sr-only">
          {status}
        </div>

        {/* A fixed height: the dialog keeps its size from folder to folder,
            so it never re-centres while browsing. */}
        <div className="relative flex h-72 shrink-0 flex-col">
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Folder contents"
            aria-busy={loading || undefined}
            aria-multiselectable={multiple || undefined}
            aria-activedescendant={activeEntry ? optionId(activeIndex) : undefined}
            tabIndex={0}
            onKeyDown={onListKeyDown}
            onPointerDown={() => {
              listPointerRef.current = true;
              setKeyboardCursor(false);
            }}
            onFocus={(event) => {
              // Tab or ArrowDown from the path field, not a click: the active
              // row is the keyboard's from the start.
              if (event.target === event.currentTarget && !listPointerRef.current) {
                setKeyboardCursor(true);
              }
              listPointerRef.current = false;
            }}
            onBlur={() => {
              listPointerRef.current = false;
              setKeyboardCursor(false);
            }}
            className={cn(
              "group/list min-h-0 flex-1 overflow-auto rounded-[var(--radius-md)] border border-border-default bg-surface-canvas p-1 transition-opacity duration-150 ease-out",
              // The rows still on screen belong to the folder being left.
              showProgress && "opacity-60",
              // With rows, the active row carries the focus ring; an empty
              // list rings itself.
              ready && entries.length > 0
                ? "focus-visible:outline-hidden"
                : "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            )}
          >
            {listing === null && loadError === null && (
              <Skeleton inert className="flex flex-col">
                {[62, 48, 71, 40, 55, 66].map((width, index) => (
                  <div key={index} className="flex items-center gap-2 px-3 py-2">
                    <SkeletonBone className="h-4 w-4 rounded-[var(--radius-xs)]" />
                    <SkeletonBone className="h-3" style={{ width: `${width}%` }} />
                  </div>
                ))}
              </Skeleton>
            )}
            {entries.map((entry, index) => {
              const selectable = isSelectable(entry, request);
              const navigable = isNavigable(entry);
              const selected = ready && selectedNames.includes(entry.name);
              const inert = !ready || (!selectable && !navigable);
              return (
                <div
                  key={entry.name}
                  id={optionId(index)}
                  role="option"
                  // The name split in two flex parts would be read with a gap in it.
                  aria-label={entry.name}
                  data-index={index}
                  aria-selected={selected}
                  aria-disabled={inert ? true : undefined}
                  onClick={(event) => {
                    if (!ready) return;
                    setActiveIndex(index);
                    toggle(entry, event.metaKey || event.ctrlKey);
                  }}
                  onDoubleClick={() => open(entry)}
                  className={cn(
                    LIST_DETAIL_ROW_CLASS,
                    "flex cursor-default select-none items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-sm",
                    ready &&
                      index === activeIndex &&
                      "group-focus-visible/list:outline-2 group-focus-visible/list:-outline-offset-2 group-focus-visible/list:outline-selection-outline group-focus-visible/list:outline-solid",
                    inert ? "text-text-secondary" : "text-text-primary",
                    // The highlight fill is a whisper on the light themes'
                    // canvas; an inset hairline keeps a selected row findable
                    // without the check alone.
                    selected && "font-medium shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                  )}
                >
                  <EntryIcon entry={entry} />
                  <EntryName
                    entry={entry}
                    reveal={keyboardCursor && ready && index === activeIndex}
                    onDismiss={() => setKeyboardCursor(false)}
                  />
                  {entry.size !== null && (
                    <span className="shrink-0 pl-2 text-right text-xs font-normal tabular-nums text-text-secondary">
                      {formatEntrySize(entry.size)}
                    </span>
                  )}
                  <span className="flex w-4 shrink-0 justify-center">
                    {selected && <Check className="h-4 w-4 text-text-primary" aria-hidden />}
                  </span>
                  {navigable ? (
                    <RowControlTooltip label={`Open ${entry.name}`} shortcut="Enter">
                      <span
                        aria-hidden="true"
                        onClick={(event) => {
                          event.stopPropagation();
                          open(entry);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        className={cn(ROW_CONTROL_CLASS, "-my-1 -mr-1.5")}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </span>
                    </RowControlTooltip>
                  ) : (
                    <span className="-mr-1.5 w-6 shrink-0" aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>
          {ready && entries.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
              <FolderOpen className="mb-1 h-5 w-5 text-text-secondary" aria-hidden="true" />
              <p className="text-sm font-medium text-text-primary">
                {request.mode === "directory" ? "This folder is empty" : "No files here"}
              </p>
              <p className="text-xs text-text-secondary">
                {request.mode === "directory"
                  ? "You can still choose it, or open another folder."
                  : "Open another folder to find one."}
                {!showHidden && " Hidden files aren't shown."}
              </p>
            </div>
          )}
          {loadError !== null && !loading && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <Callout
                severity="error"
                role="alert"
                title="Couldn't open this folder"
                className="w-full max-w-md p-3"
                action={
                  <Button variant="outline" size="xs" onClick={retry}>
                    <RefreshCw />
                    Retry
                  </Button>
                }
              >
                <p className="text-xs">{loadError}</p>
              </Callout>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 pb-4 text-xs text-text-secondary">
          <label htmlFor={hiddenId} className="flex items-center gap-2">
            <Checkbox
              id={hiddenId}
              size="sm"
              checked={showHidden}
              onCheckedChange={(checked) => setShowHidden(checked === true)}
            />
            Show hidden files
          </label>
          {ready && listing.truncated ? (
            <span className="truncate">
              Showing the first {entries.length.toLocaleString()} items. Type a path to go deeper.
            </span>
          ) : (
            <span
              className={cn(
                "flex items-center gap-3",
                // Kept in the layout while it doesn't apply, so the dialog
                // holds its height through loading, empty and error.
                !(ready && entries.length > 0) && "invisible"
              )}
              aria-hidden="true"
            >
              {keyHint(["↵"], "Open")}
              {keyHint(["Space"], multiple ? "Toggle" : "Select")}
              {multiple && keyHint([isMac() ? "⌘" : "Ctrl"], "Click to add")}
            </span>
          )}
        </div>
      </div>

      <AppDialog.Footer
        hint={<span className="flex h-[2.125rem] min-w-0 items-center">{hint}</span>}
        secondaryAction={{ label: "Cancel", onClick: () => onResolve(null) }}
        primaryAction={{ label: confirmLabel, onClick: confirm, disabled: !choice }}
      />
    </AppDialog>
  );
}
