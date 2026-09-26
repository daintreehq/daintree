import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUp, File, Folder, FolderOpen, Link2 } from "lucide-react";
import type {
  HostDirectoryEntry,
  HostDirectoryListing,
  HostPickRequest,
  HostPickerRoots,
} from "@shared/types/ipc/hostFiles";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import {
  defaultButtonLabel,
  formatEntrySize,
  isAbsoluteHostPath,
  isNavigable,
  isSelectable,
  joinHostPath,
  resolveChoice,
} from "./hostFilePickerModel";

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
  const [pathInput, setPathInput] = useState<HTMLInputElement | null>(null);
  const focusOwedRef = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const hiddenId = useId();
  const showSpinner = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);

  // AppDialog is told not to place focus: the path field takes it, a frame
  // after the field mounts, so the dialog has already recorded the invoker it
  // hands focus back to on close.
  useEffect(() => {
    if (!pathInput || !focusOwedRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (!focusOwedRef.current || !pathInput.isConnected) return;
      focusOwedRef.current = false;
      pathInput.focus();
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
        setListing(result);
        setListedDirectory(directory);
        setPathDraft(result.path);
        setSelectedNames([]);
        setActiveIndex(0);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(formatErrorMessage(cause, "Couldn't open that folder"));
        setPathDraft(directory);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, showHidden, reloadKey, hostId]);

  // Anything chosen belongs to the listing on screen, and only while that
  // listing is the answer for the folder asked for: never mid-load, after a
  // failure, or from the folder before.
  const ready = listing !== null && listedDirectory === directory && !loading && loadError === null;
  const entries = useMemo(
    () => (listing && loadError === null ? listing.entries : []),
    [listing, loadError]
  );
  const selectedEntries = ready
    ? entries.filter((entry) => selectedNames.includes(entry.name))
    : [];
  const choice = ready ? resolveChoice(request, listing.path, selectedEntries) : null;
  const confirmLabel = defaultButtonLabel(request);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const activeEntry = ready ? entries[activeIndex] : undefined;

  const navigate = (target: string) => {
    setSelectedNames([]);
    setActiveIndex(0);
    setLoadError(null);
    setPathError(null);
    if (target === directory) setReloadKey((key) => key + 1);
    else setDirectory(target);
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
      if (additive && request.mode === "file" && request.multiple) {
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

  const goToDraft = () => {
    const target = pathDraft.trim();
    if (!isAbsoluteHostPath(target)) {
      setPathError("Enter an absolute path, starting with /");
      return;
    }
    navigate(target);
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!ready || entries.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => Math.min(entries.length - 1, Math.max(0, index + step)));
      return;
    }
    if (!activeEntry) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open(activeEntry);
    } else if (event.key === " ") {
      event.preventDefault();
      toggle(activeEntry, event.metaKey || event.ctrlKey);
    }
  };

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const hint = pathError ? (
    <span className="truncate text-status-error" role="alert">
      {pathError}
    </span>
  ) : ready && listing.truncated ? (
    <span className="truncate">
      Showing the first {entries.length.toLocaleString()} items. Type a path to go deeper.
    </span>
  ) : choice ? (
    <span className="truncate" title={choice.join("\n")}>
      {choice.length > 1 ? `${choice.length} files selected` : choice[0]}
    </span>
  ) : (
    <span className="truncate">
      {request.mode === "file" ? "Select a file to continue" : "Open a folder to choose it"}
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

      <div className="flex flex-col gap-3 px-6 pt-4 min-h-0 flex-1">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Parent folder"
            disabled={!ready || !listing.parent}
            onClick={() => ready && listing.parent && navigate(listing.parent)}
          >
            <ArrowUp />
          </Button>
          <Input
            ref={setPathInput}
            density="compact"
            aria-label="Folder path"
            aria-controls={listId}
            value={pathDraft}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setPathDraft(event.target.value);
              setPathError(null);
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
        </div>

        {roots && roots.roots.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Places">
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

        <div className="relative flex min-h-[16rem] max-h-[24rem] flex-1 flex-col">
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Folder contents"
            aria-busy={loading || undefined}
            aria-multiselectable={request.mode === "file" && request.multiple ? true : undefined}
            aria-activedescendant={activeEntry ? optionId(activeIndex) : undefined}
            tabIndex={0}
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-md)] border border-border-default bg-surface-canvas focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          >
            {ready && entries.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-text-secondary">
                {showHidden
                  ? "This folder is empty"
                  : "No visible items. Show hidden files to see more."}
              </p>
            )}
            {entries.map((entry, index) => {
              const selectable = isSelectable(entry, request);
              const selected = ready && selectedNames.includes(entry.name);
              return (
                <div
                  key={entry.name}
                  id={optionId(index)}
                  role="option"
                  data-index={index}
                  aria-selected={selected}
                  aria-disabled={!ready || (!selectable && !isNavigable(entry)) ? true : undefined}
                  onClick={(event) => {
                    if (!ready) return;
                    setActiveIndex(index);
                    toggle(entry, event.metaKey || event.ctrlKey);
                  }}
                  onDoubleClick={() => open(entry)}
                  className={cn(
                    "flex cursor-default select-none items-center gap-2 px-3 py-1.5 text-sm",
                    selected ? "bg-overlay-medium" : "hover:bg-overlay-subtle",
                    ready && index === activeIndex && "bg-overlay-subtle",
                    !ready || (!selectable && !isNavigable(entry))
                      ? "text-text-secondary"
                      : "text-text-primary"
                  )}
                >
                  <EntryIcon entry={entry} />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-text-secondary">
                    {formatEntrySize(entry.size)}
                  </span>
                </div>
              );
            })}
          </div>
          {showSpinner && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Spinner size="md" />
            </div>
          )}
          {loadError !== null && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-status-error" role="alert">
                {loadError}
              </p>
              <Button variant="outline" size="sm" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
        </div>

        <label
          htmlFor={hiddenId}
          className="flex items-center gap-2 pb-4 text-xs text-text-secondary"
        >
          <Checkbox
            id={hiddenId}
            size="sm"
            checked={showHidden}
            onCheckedChange={(checked) => setShowHidden(checked === true)}
          />
          Show hidden files
        </label>
      </div>

      <AppDialog.Footer hint={hint}>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => onResolve(null)}>
            Cancel
          </Button>
          <Button variant="contrast" size="sm" onClick={confirm} disabled={!choice}>
            {confirmLabel}
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
