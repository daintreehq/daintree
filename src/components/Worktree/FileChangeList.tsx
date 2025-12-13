import { useMemo, useState } from "react";
import type { FileChangeDetail, GitStatus } from "../../types";
import { cn } from "../../lib/utils";
import { FileDiffModal } from "./FileDiffModal";
import { Folder } from "lucide-react";

function isAbsolutePath(filePath: string): boolean {
  return (
    filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")
  );
}

function getRelativePath(from: string, to: string): string {
  const normalizedFrom = from.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedTo = to.replace(/\\/g, "/");

  if (normalizedTo.startsWith(normalizedFrom + "/")) {
    return normalizedTo.slice(normalizedFrom.length + 1);
  }

  return normalizedTo;
}

function getBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

const STATUS_CONFIG: Record<GitStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "text-[var(--color-status-warning)]" },
  added: { label: "A", color: "text-[var(--color-status-success)]" },
  deleted: { label: "D", color: "text-[var(--color-status-error)]" },
  untracked: { label: "?", color: "text-[var(--color-status-success)]" },
  renamed: { label: "R", color: "text-[var(--color-status-info)]" },
  copied: { label: "C", color: "text-[var(--color-status-info)]" },
  ignored: { label: "I", color: "text-canopy-text/40" },
};

const STATUS_PRIORITY: Record<GitStatus, number> = {
  modified: 0,
  added: 1,
  deleted: 2,
  renamed: 3,
  copied: 4,
  untracked: 5,
  ignored: 6,
};

interface FileChangeListProps {
  changes: FileChangeDetail[];
  maxVisible?: number;
  rootPath: string;
  groupByFolder?: boolean;
}

function splitPath(filePath: string): { dir: string; base: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return { dir: "", base: normalized };
  }
  return {
    dir: normalized.slice(0, lastSlash),
    base: normalized.slice(lastSlash + 1),
  };
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

export function FileChangeList({
  changes,
  maxVisible = 4,
  rootPath,
  groupByFolder = false,
}: FileChangeListProps) {
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  const sortedChanges = useMemo(() => {
    return [...changes]
      .map((change) => ({
        ...change,
        relativePath: isAbsolutePath(change.path)
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

    return (
      <div
        key={`${change.path}-${change.status}`}
        className="group flex items-center text-xs font-mono hover:bg-white/5 rounded px-1.5 py-0.5 -mx-1.5 cursor-pointer transition-colors"
        onClick={() => handleFileClick(change)}
        title={change.relativePath}
      >
        <span className={cn("w-4 font-bold shrink-0", config.color)}>{config.label}</span>

        <div className="flex-1 min-w-0 flex items-center mr-2">
          {showDir && displayDir && (
            <span className="truncate min-w-0 text-canopy-text/60 opacity-60 group-hover:opacity-80">
              {displayDir}/
            </span>
          )}
          <span className="text-canopy-text group-hover:text-white font-medium truncate min-w-0">
            {base}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0 text-[11px]">
          {(change.insertions ?? 0) > 0 && (
            <span className="text-green-500/80">+{change.insertions}</span>
          )}
          {(change.deletions ?? 0) > 0 && (
            <span className="text-red-500/80">-{change.deletions}</span>
          )}
        </div>
      </div>
    );
  };

  if (groupByFolder && groupedChanges.length > 0) {
    return (
      <>
        <div className="space-y-3 w-full">
          {groupedChanges.map((group) => (
            <div key={group.dir}>
              <div className="flex items-center gap-1.5 text-[11px] text-canopy-text/40 mb-1">
                <Folder className="w-3 h-3" />
                <span className="font-mono">{group.displayDir}</span>
                <span className="text-canopy-text/30">({group.files.length})</span>
              </div>
              <div className="pl-4 flex flex-col gap-0.5">
                {group.files.map((file) => renderFileItem(file, false))}
              </div>
            </div>
          ))}
          {remainingCount > 0 && (
            <div className="text-[11px] text-canopy-text/60 pl-4 pt-1">
              ...and {remainingCount} more
              {remainingFiles.length > 0 && (
                <span className="ml-1 opacity-75">
                  ({remainingFiles.map((f) => getBasename(f.relativePath)).join(", ")}
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
      <div className="flex flex-col gap-0.5 w-full">
        {visibleChanges.map((change) => renderFileItem(change, true))}

        {remainingCount > 0 && (
          <div className="text-[11px] text-canopy-text/60 pl-5 pt-1">
            ...and {remainingCount} more
            {remainingFiles.length > 0 && (
              <span className="ml-1 opacity-75">
                ({remainingFiles.map((f) => getBasename(f.path)).join(", ")}
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
