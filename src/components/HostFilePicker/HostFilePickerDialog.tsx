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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pathDraft, setPathDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const hiddenId = useId();
  const showSpinner = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);

  useEffect(() => {
    let cancelled = false;
    window.electron.hostFiles
      .getPickerRoots()
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
  }, []);

  useEffect(() => {
    if (directory === null) return;
    let cancelled = false;
    setLoading(true);
    window.electron.hostFiles
      .listDirectory({ path: directory, showHidden })
      .then((result) => {
        if (cancelled) return;
        setListing(result);
        setPathDraft(result.path);
        setSelectedNames([]);
        setActiveIndex(0);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(formatErrorMessage(cause, "Couldn't open that folder"));
        setPathDraft(directory);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, showHidden]);

  const entries = useMemo(() => listing?.entries ?? [], [listing]);
  const selectedEntries = entries.filter((entry) => selectedNames.includes(entry.name));
  const choice = resolveChoice(request, listing?.path ?? null, selectedEntries);
  const confirmLabel = defaultButtonLabel(request);

  const open = (entry: HostDirectoryEntry) => {
    if (!listing) return;
    if (isNavigable(entry)) {
      setDirectory(joinHostPath(listing.path, entry.name));
      return;
    }
    if (isSelectable(entry, request)) onResolve([joinHostPath(listing.path, entry.name)]);
  };

  const toggle = (entry: HostDirectoryEntry, additive: boolean) => {
    if (!isSelectable(entry, request)) return;
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
      setError("Enter an absolute path, starting with /");
      return;
    }
    setDirectory(target);
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (entries.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => Math.min(entries.length - 1, Math.max(0, index + step)));
      return;
    }
    const active = entries[activeIndex];
    if (!active) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open(active);
    } else if (event.key === " ") {
      event.preventDefault();
      toggle(active, event.metaKey || event.ctrlKey);
    }
  };

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const hint = error ? (
    <span className="truncate text-status-error" role="alert">
      {error}
    </span>
  ) : listing?.truncated ? (
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
            disabled={!listing?.parent}
            onClick={() => listing?.parent && setDirectory(listing.parent)}
          >
            <ArrowUp />
          </Button>
          <Input
            density="compact"
            aria-label="Folder path"
            value={pathDraft}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToDraft();
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
                onClick={() => setDirectory(root.path)}
              >
                {root.label}
              </Button>
            ))}
          </div>
        )}

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Folder contents"
          aria-multiselectable={request.mode === "file" && request.multiple ? true : undefined}
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="relative min-h-[16rem] max-h-[24rem] flex-1 overflow-auto rounded-[var(--radius-md)] border border-border-default bg-surface-canvas focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          {showSpinner && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner size="md" />
            </div>
          )}
          {!loading && listing && entries.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-text-secondary">
              {showHidden
                ? "This folder is empty"
                : "No visible items. Show hidden files to see more."}
            </p>
          )}
          {entries.map((entry, index) => {
            const selectable = isSelectable(entry, request);
            const selected = selectedNames.includes(entry.name);
            return (
              <div
                key={entry.name}
                role="option"
                data-index={index}
                aria-selected={selected}
                aria-disabled={!selectable && !isNavigable(entry) ? true : undefined}
                onClick={(event) => {
                  setActiveIndex(index);
                  toggle(entry, event.metaKey || event.ctrlKey);
                }}
                onDoubleClick={() => open(entry)}
                className={cn(
                  "flex cursor-default select-none items-center gap-2 px-3 py-1.5 text-sm",
                  selected ? "bg-overlay-medium" : "hover:bg-overlay-subtle",
                  index === activeIndex && "bg-overlay-subtle",
                  !selectable && !isNavigable(entry) ? "text-text-secondary" : "text-text-primary"
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
