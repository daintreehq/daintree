import { useMemo } from "react";
import { parseDiff, Diff, Hunk, tokenize, markEdits, DiffType, ViewType } from "react-diff-view";
import type { HunkData, HunkTokens, TokenizeOptions } from "react-diff-view";
import { refractor } from "refractor";
import "react-diff-view/style/index.css";
import { ExternalLink } from "lucide-react";
import path from "path-browserify";
import { getLanguageForFile } from "@/components/FileViewer/languageUtils";
import { actionService } from "@/services/ActionService";

export interface DiffViewerProps {
  diff: string;
  filePath: string;
  viewType?: ViewType;
  /** Absolute path to the worktree root, used to resolve per-file open-in-editor paths */
  rootPath?: string;
}

function useTokens(hunks: HunkData[], language: string): HunkTokens | null {
  return useMemo(() => {
    if (!hunks.length) return null;

    const options: TokenizeOptions = {
      highlight: true,
      refractor,
      language,
      enhancers: [markEdits(hunks, { type: "block" })],
    };

    try {
      return tokenize(hunks, options);
    } catch {
      return null;
    }
  }, [hunks, language]);
}

export function DiffViewer({ diff, filePath, viewType = "split", rootPath }: DiffViewerProps) {
  const files = useMemo(() => {
    try {
      return parseDiff(diff);
    } catch {
      return [];
    }
  }, [diff]);

  if (!diff || diff === "NO_CHANGES") {
    return (
      <div className="flex items-center justify-center p-8 text-text-muted">
        No changes detected
      </div>
    );
  }

  if (diff === "BINARY_FILE") {
    return (
      <div className="flex items-center justify-center p-8 text-text-muted">
        Binary file - cannot display diff
      </div>
    );
  }

  if (diff === "FILE_TOO_LARGE") {
    return (
      <div className="flex items-center justify-center p-8 text-text-muted">
        File too large to display diff ({">"} 1MB)
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-text-muted">
        Unable to parse diff
      </div>
    );
  }

  const language = getLanguageForFile(filePath);

  return (
    <div className="diff-viewer overflow-auto">
      {files.map((file, index) => (
        <FileDiff
          key={file.newRevision || file.oldRevision || index}
          file={file}
          viewType={viewType}
          language={language}
          rootPath={rootPath}
        />
      ))}
    </div>
  );
}

interface FileDiffProps {
  file: ReturnType<typeof parseDiff>[0];
  viewType: ViewType;
  language: string;
  rootPath?: string;
}

function FileDiff({ file, viewType, language, rootPath }: FileDiffProps) {
  const tokens = useTokens(file.hunks ?? [], language);
  const diffType: DiffType = file.type as DiffType;

  const { additions, deletions } = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const hunk of file.hunks ?? []) {
      for (const change of hunk.changes) {
        if (change.type === "insert") adds++;
        else if (change.type === "delete") dels++;
      }
    }
    return { additions: adds, deletions: dels };
  }, [file.hunks]);

  const fileTyped = file as ReturnType<typeof parseDiff>[0] & {
    newPath?: string;
    oldPath?: string;
  };
  // Prefer newPath (the post-change path); fall back to oldPath for deletions.
  // Filter out /dev/null which git uses as a sentinel for added/deleted files.
  const rawPath =
    fileTyped.newPath && fileTyped.newPath !== "/dev/null"
      ? fileTyped.newPath
      : fileTyped.oldPath && fileTyped.oldPath !== "/dev/null"
        ? fileTyped.oldPath
        : undefined;
  const relPath = rawPath;
  const absolutePath =
    rootPath && relPath && !relPath.startsWith("/")
      ? path.join(rootPath, relPath)
      : relPath || null;

  const firstHunkLine = file.hunks?.[0]?.newStart;

  const handleOpenInEditor = () => {
    if (!absolutePath) return;
    void actionService.dispatch(
      "file.openInEditor",
      { path: absolutePath, line: firstHunkLine },
      { source: "user" }
    );
  };

  return (
    <div className="mb-2">
      {relPath && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-daintree-sidebar border-b border-daintree-border text-xs text-daintree-text/60 font-mono">
          <span className="truncate">{relPath}</span>
          <div className="flex items-center gap-2 shrink-0">
            {(additions > 0 || deletions > 0) && (
              <span className="flex items-center gap-1">
                {additions > 0 && <span className="text-status-success">+{additions}</span>}
                {deletions > 0 && <span className="text-status-danger">-{deletions}</span>}
              </span>
            )}
            {absolutePath && (
              <button
                onClick={handleOpenInEditor}
                title={`Open in editor${firstHunkLine ? ` at line ${firstHunkLine}` : ""}`}
                className="ml-2 shrink-0 flex items-center gap-1 px-2 py-0.5 rounded hover:bg-tint/5 hover:text-daintree-text transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Open
              </button>
            )}
          </div>
        </div>
      )}
      <Diff
        viewType={viewType}
        diffType={diffType}
        hunks={file.hunks ?? []}
        tokens={tokens ?? undefined}
      >
        {(hunks: HunkData[]) =>
          hunks.map((hunk) => <Hunk key={`${hunk.oldStart}-${hunk.newStart}`} hunk={hunk} />)
        }
      </Diff>
    </div>
  );
}
