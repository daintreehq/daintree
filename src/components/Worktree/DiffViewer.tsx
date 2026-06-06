import { forwardRef, useEffect, useMemo, useState } from "react";
import { parseDiff, Diff, Hunk, tokenize, markEdits, DiffType, ViewType } from "react-diff-view";
import type { HunkData, HunkTokens, TokenizeOptions } from "react-diff-view";
import { refractor } from "refractor/core";
import type { Syntax } from "refractor/core";
import bash from "refractor/bash";
import css from "refractor/css";
import javascript from "refractor/javascript";
import jsx from "refractor/jsx";
import json from "refractor/json";
import markdown from "refractor/markdown";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import "react-diff-view/style/index.css";
import { AlertCircle, ChevronRight, ExternalLink } from "lucide-react";
import { join } from "@shared/utils/path";
import { getLanguageForFile } from "@/components/FileViewer/languageUtils";
import { actionService } from "@/services/ActionService";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { getFilePath, shouldCollapseByDefault, estimateFileDiffBytes } from "./diffCollapseUtils";
import { formatBytes } from "@/lib/formatBytes";

for (const lang of [bash, css, javascript, jsx, json, markdown, tsx, typescript]) {
  refractor.register(lang);
}

const LANG_LOADERS: Record<string, () => Promise<{ default: Syntax }>> = {
  c: () => import("refractor/c"),
  cpp: () => import("refractor/cpp"),
  csharp: () => import("refractor/csharp"),
  docker: () => import("refractor/docker"),
  go: () => import("refractor/go"),
  graphql: () => import("refractor/graphql"),
  java: () => import("refractor/java"),
  kotlin: () => import("refractor/kotlin"),
  less: () => import("refractor/less"),
  makefile: () => import("refractor/makefile"),
  markup: () => import("refractor/markup"),
  php: () => import("refractor/php"),
  python: () => import("refractor/python"),
  ruby: () => import("refractor/ruby"),
  rust: () => import("refractor/rust"),
  sass: () => import("refractor/sass"),
  scss: () => import("refractor/scss"),
  sql: () => import("refractor/sql"),
  swift: () => import("refractor/swift"),
  toml: () => import("refractor/toml"),
  yaml: () => import("refractor/yaml"),
};

const langLoadPromises = new Map<string, Promise<void>>();
const FAILED_LANGS = new Set<string>();

export function _resetLangStateForTests(): void {
  FAILED_LANGS.clear();
  langLoadPromises.clear();
}

function ensureLanguage(language: string): Promise<void> {
  if (refractor.registered(language)) return Promise.resolve();
  const loader = LANG_LOADERS[language];
  if (!loader) return Promise.resolve();
  let pending = langLoadPromises.get(language);
  if (!pending) {
    pending = loader()
      .then((mod) => {
        refractor.register(mod.default);
      })
      .catch((err: unknown) => {
        console.warn(`Failed to load refractor grammar for "${language}"`, err);
        FAILED_LANGS.add(language);
      });
    langLoadPromises.set(language, pending);
  }
  return pending;
}

export interface DiffViewerProps {
  diff: string;
  filePath: string;
  viewType?: ViewType;
  /** Absolute path to the worktree root, used to resolve per-file open-in-editor paths */
  rootPath?: string;
  onRetry?: () => void;
  /** Fired when a collapsible file is expanded or collapsed, so consumers can re-scan the hunk rows that just appeared or disappeared */
  onToggleCollapse?: () => void;
}

function useTokens(
  hunks: HunkData[],
  language: string
): {
  tokens: HunkTokens | null;
  langLoadFailed: boolean;
} {
  const [langReady, setLangReady] = useState(() => refractor.registered(language));
  const [langLoadFailed, setLangLoadFailed] = useState(() => FAILED_LANGS.has(language));

  useEffect(() => {
    if (refractor.registered(language)) {
      setLangReady(true);
      setLangLoadFailed(false);
      return;
    }
    setLangReady(false);
    let cancelled = false;
    void ensureLanguage(language).then(() => {
      if (!cancelled) {
        setLangReady(refractor.registered(language));
        setLangLoadFailed(FAILED_LANGS.has(language));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const tokens = useMemo(() => {
    if (!hunks.length || !langReady) return null;

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
  }, [hunks, language, langReady]);

  return { tokens, langLoadFailed };
}

export const DiffViewer = forwardRef<HTMLDivElement, DiffViewerProps>(function DiffViewer(
  { diff, viewType = "split", rootPath, onRetry, onToggleCollapse },
  ref
) {
  const files = useMemo(() => {
    try {
      const parsed = parseDiff(diff);
      // parseDiff is forgiving — nonsense input yields a synthetic file with
      // empty paths and no hunks. Treat that shape as a parse failure.
      const allEmpty = parsed.every(
        (file) => !file.oldPath && !file.newPath && file.hunks.length === 0
      );
      return allEmpty ? [] : parsed;
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

  if (diff === "ERROR") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8">
        <div className="flex items-center gap-2 text-status-error text-sm">
          <AlertCircle className="w-4 h-4" />
          Failed to load diff
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1.5 text-xs font-medium rounded bg-daintree-border hover:bg-daintree-border/80 text-daintree-text transition-colors"
          >
            Retry
          </button>
        )}
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

  return (
    <div ref={ref} className="diff-viewer overflow-auto">
      {files.map((file, index) => (
        <FileDiff
          key={file.newRevision || file.oldRevision || index}
          file={file}
          viewType={viewType}
          rootPath={rootPath}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
    </div>
  );
});

interface FileDiffProps {
  file: ReturnType<typeof parseDiff>[0];
  viewType: ViewType;
  rootPath?: string;
  /** Fired whenever this file's collapse state is toggled (expand or collapse) */
  onToggleCollapse?: () => void;
}

function FileDiff({ file, viewType, rootPath, onToggleCollapse }: FileDiffProps) {
  const relPath = getFilePath(file);
  const language = useMemo(() => {
    const derived = getLanguageForFile(relPath);
    return FAILED_LANGS.has(derived) ? "plaintext" : derived;
  }, [relPath]);
  const { tokens, langLoadFailed } = useTokens(file.hunks ?? [], language);
  const diffType: DiffType = file.type as DiffType;

  const collapseDecision = useMemo(() => shouldCollapseByDefault(file), [file]);
  const [isCollapsed, setIsCollapsed] = useState(collapseDecision.collapse);

  useEffect(() => {
    setIsCollapsed(collapseDecision.collapse);
  }, [collapseDecision.collapse]);

  const diffRegionId = useMemo(
    () =>
      `diff-region-${file.oldPath || "dst"}-${file.newPath || "src"}-${file.newRevision || file.oldRevision || "unknown"}`,
    [file.newPath, file.oldPath, file.newRevision, file.oldRevision]
  );

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

  const absolutePath =
    rootPath && relPath && !relPath.startsWith("/") ? join(rootPath, relPath) : relPath || null;

  const firstHunkLine = file.hunks?.[0]?.newStart;

  const handleOpenInEditor = () => {
    if (!absolutePath) return;
    void actionService.dispatch(
      "file.openInEditor",
      { path: absolutePath, line: firstHunkLine },
      { source: "user" }
    );
  };

  const handleToggleCollapse = () => {
    // Notify consumers on every toggle so they can re-scan the hunk rows that
    // just appeared (expand) or disappeared (collapse) — the hunk indicator and
    // scroll tracking attach to live DOM and must follow both transitions.
    onToggleCollapse?.();
    setIsCollapsed((prev) => !prev);
  };

  return (
    <div className="mb-2">
      {relPath && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-daintree-sidebar border-b border-daintree-border text-xs text-daintree-text/60 font-mono">
          <TruncatedTooltip content={relPath}>
            <span className="truncate">{relPath}</span>
          </TruncatedTooltip>
          {langLoadFailed && (
            <span
              className="text-xs text-text-muted"
              role="status"
              data-testid="diff-plain-text-badge"
            >
              Plain text
            </span>
          )}
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
      {collapseDecision.collapse && (
        <button
          onClick={handleToggleCollapse}
          aria-expanded={!isCollapsed}
          {...(!isCollapsed ? { "aria-controls": diffRegionId } : {})}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-muted hover:bg-tint/5 transition-colors"
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
          />
          <span className="text-left">
            {collapseDecision.reason === "generated"
              ? "Generated file collapsed"
              : `Large diff (${formatBytes(estimateFileDiffBytes(file))})`}
          </span>
          <span className="ml-auto text-daintree-text/50 font-mono text-xs">
            {isCollapsed ? "Show diff" : "Hide diff"}
          </span>
        </button>
      )}
      {!isCollapsed && (
        <div id={diffRegionId} className="diff-file-scroll">
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
      )}
    </div>
  );
}
