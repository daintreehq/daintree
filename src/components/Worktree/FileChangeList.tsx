import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileChangeDetail, GitStatus } from "../../types";
import { cn } from "../../lib/utils";
import { FileDiffModal } from "./FileDiffModal";
import { Folder } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isAbsolute, basename, dirname, normalize } from "@shared/utils/path";

function getRelativePath(from: string, to: string): string {
  const normalizedFrom = normalize(from);
  const normalizedTo = normalize(to);

  if (normalizedTo.startsWith(normalizedFrom + "/")) {
    return normalizedTo.slice(normalizedFrom.length + 1);
  }

  return normalizedTo;
}

const STATUS_CONFIG: Record<GitStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "text-status-warning" },
  added: { label: "A", color: "text-status-success" },
  deleted: { label: "D", color: "text-status-error" },
  untracked: { label: "?", color: "text-status-success" },
  renamed: { label: "R", color: "text-status-info" },
  copied: { label: "C", color: "text-status-info" },
  ignored: { label: "I", color: "text-daintree-text/40" },
  conflicted: { label: "!", color: "text-status-error" },
};

const STATUS_PRIORITY: Record<GitStatus, number> = {
  modified: 0,
  added: 1,
  deleted: 2,
  renamed: 3,
  copied: 4,
  untracked: 5,
  ignored: 6,
  conflicted: 7,
};

interface FileChangeListProps {
  changes: FileChangeDetail[];
  maxVisible?: number;
  rootPath: string;
  groupByFolder?: boolean;
  isStale?: boolean;
}

function splitPath(filePath: string): { dir: string; base: string } {
  const dir = dirname(filePath);
  const base = basename(filePath);
  return { dir: dir === "." ? "" : dir, base };
}

function formatDirForDisplay(dir: string, maxSegments = 2): string {
  if (!dir) return "";
  const segments = dir.split("/");
  if (segments.length <= maxSegments) return dir;
  return "…/" + segments.slice(-maxSegments).join("/");
}

interface SelectedFile {
  path: string;
  status: GitStatus;
}

interface FileChangeWithRelativePath extends FileChangeDetail {
  relativePath: string;
}

interface FolderGroup {
  dir: string;
  displayDir: string;
  files: FileChangeWithRelativePath[];
}

function rowKey(change: { path: string; status: GitStatus }): string {
  return `${change.path}-${change.status}`;
}

export function FileChangeList({
  changes,
  maxVisible = 8,
  rootPath,
  groupByFolder = false,
  isStale = false,
}: FileChangeListProps) {
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  const sortedChanges = useMemo(() => {
    return [...changes]
      .map((change) => ({
        ...change,
        relativePath: isAbsolute(change.path)
          ? getRelativePath(rootPath, change.path)
          : change.path,
      }))
      .sort((a, b) => {
        const churnA = (a.insertions ?? 0) + (a.deletions ?? 0);
        const churnB = (b.insertions ?? 0) + (b.deletions ?? 0);
        if (churnA !== churnB) {
          return churnB - churnA;
        }

        const priorityA = STATUS_PRIORITY[a.status] ?? 99;
        const priorityB = STATUS_PRIORITY[b.status] ?? 99;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }

        return a.path.localeCompare(b.path);
      });
  }, [changes, rootPath]);

  const visibleChanges = useMemo(
    () => sortedChanges.slice(0, maxVisible),
    [sortedChanges, maxVisible]
  );
  const remainingCount = Math.max(0, sortedChanges.length - maxVisible);

  // Track which row keys arrived since the previous render. Empty on mount because
  // prevKeysRef is seeded with the initial keys — the first paint must NOT flash
  // every existing row. The decay IS the recency signal (semantic exception, ~2s).
  const prevKeysRef = useRef<Set<string> | null>(null);
  const [newRowKeys, setNewRowKeys] = useState<Set<string>>(() => new Set());

  useLayoutEffect(() => {
    const currentKeys = sortedChanges.map(rowKey);
    if (prevKeysRef.current === null) {
      prevKeysRef.current = new Set(currentKeys);
      return;
    }
    const added = new Set<string>();
    for (const key of currentKeys) {
      if (!prevKeysRef.current.has(key)) {
        added.add(key);
      }
    }
    prevKeysRef.current = new Set(currentKeys);
    setNewRowKeys((prev) => (added.size === 0 && prev.size === 0 ? prev : added));
  }, [sortedChanges]);
  const remainingFiles = useMemo(
    () => sortedChanges.slice(maxVisible, maxVisible + 2),
    [sortedChanges, maxVisible]
  );

  const groupedChanges = useMemo((): FolderGroup[] => {
    if (!groupByFolder) return [];

    const groups = new Map<string, FileChangeWithRelativePath[]>();

    visibleChanges.forEach((change) => {
      const { dir } = splitPath(change.relativePath);
      const groupKey = dir || "(root)";
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(change);
    });

    return Array.from(groups.entries())
      .map(([dir, files]) => ({
        dir,
        displayDir: dir === "(root)" ? "(root)" : formatDirForDisplay(dir, 3),
        files,
      }))
      .sort((a, b) => {
        if (a.dir === "(root)") return -1;
        if (b.dir === "(root)") return 1;
        return a.dir.localeCompare(b.dir);
      });
  }, [visibleChanges, groupByFolder]);

  if (changes.length === 0) {
    return null;
  }

  const handleFileClick = (change: FileChangeWithRelativePath) => {
    setSelectedFile({
      path: change.relativePath,
      status: change.status,
    });
  };

  const closeModal = () => {
    setSelectedFile(null);
  };

  const renderFileItem = (change: FileChangeWithRelativePath, showDir: boolean) => {
    const config = STATUS_CONFIG[change.status] || STATUS_CONFIG.untracked;
    const { dir, base } = splitPath(change.relativePath);
    const displayDir = formatDirForDisplay(dir);
    const key = rowKey(change);
    const isNew = newRowKeys.has(key);

    return (
      <Tooltip key={key}>
        <TooltipTrigger asChild>
          <div
            data-recency-new={isNew ? "true" : undefined}
            className={cn(
              "group/filerow flex items-center text-xs font-mono hover:bg-tint/5 rounded px-1.5 py-0.5 -mx-1.5 cursor-pointer transition-colors",
              isNew && "file-change-row-new"
            )}
            onClick={() => handleFileClick(change)}
          >
            <span className={cn("w-4 font-bold shrink-0", config.color)}>{config.label}</span>

            <div className="flex-1 min-w-0 flex items-center mr-2">
              {showDir && displayDir && (
                <span className="truncate min-w-0 text-daintree-text/60 opacity-60 group-hover/filerow:opacity-80">
                  {displayDir}/
                </span>
              )}
              <span className="text-daintree-text group-hover/filerow:text-daintree-text font-medium truncate min-w-0">
                {base}
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0 text-[11px]">
              {(change.insertions ?? 0) > 0 && (
                <span className="text-status-success/80">+{change.insertions}</span>
              )}
              {(change.deletions ?? 0) > 0 && (
                <span className="text-status-error/80">-{change.deletions}</span>
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{change.relativePath}</TooltipContent>
      </Tooltip>
    );
  };

  if (groupByFolder && groupedChanges.length > 0) {
    return (
      <>
        <div
          className={cn(
            "space-y-3 w-full max-h-64 overflow-y-auto overscroll-contain",
            isStale && "surface-stale"
          )}
          aria-busy={isStale || undefined}
        >
          {groupedChanges.map((group) => (
            <div key={group.dir}>
              <div className="flex items-center gap-1.5 text-[11px] text-daintree-text/40 mb-1">
                <Folder className="w-3 h-3" />
                <span className="font-mono">{group.displayDir}</span>
                <span className="text-daintree-text/30">({group.files.length})</span>
              </div>
              <div className="pl-4 flex flex-col gap-0.5">
                {group.files.map((file) => renderFileItem(file, false))}
              </div>
            </div>
          ))}
          {remainingCount > 0 && (
            <div className="text-[11px] text-daintree-text/60 pl-4 pt-1">
              ...and {remainingCount} more
              {remainingFiles.length > 0 && (
                <span className="ml-1 opacity-75">
                  ({remainingFiles.map((f) => basename(f.relativePath)).join(", ")}
                  {sortedChanges.length > maxVisible + 2 && ", ..."})
                </span>
              )}
            </div>
          )}
        </div>

        <FileDiffModal
          isOpen={selectedFile !== null}
          filePath={selectedFile?.path ?? ""}
          status={selectedFile?.status ?? "modified"}
          worktreePath={rootPath}
          onClose={closeModal}
        />
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "flex flex-col gap-0.5 w-full max-h-64 overflow-y-auto overscroll-contain",
          isStale && "surface-stale"
        )}
        aria-busy={isStale || undefined}
      >
        {visibleChanges.map((change) => renderFileItem(change, true))}

        {remainingCount > 0 && (
          <div className="text-[11px] text-daintree-text/60 pl-5 pt-1">
            ...and {remainingCount} more
            {remainingFiles.length > 0 && (
              <span className="ml-1 opacity-75">
                ({remainingFiles.map((f) => basename(f.path)).join(", ")}
                {sortedChanges.length > maxVisible + 2 && ", ..."})
              </span>
            )}
          </div>
        )}
      </div>

      <FileDiffModal
        isOpen={selectedFile !== null}
        filePath={selectedFile?.path ?? ""}
        status={selectedFile?.status ?? "modified"}
        worktreePath={rootPath}
        onClose={closeModal}
      />
    </>
  );
}
